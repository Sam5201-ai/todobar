/**
 * 录音引擎(模块级单例)+ 录音记录元数据持久化。
 *
 * 设计要点:
 * - 引擎独立于页面生命周期:录音中关闭录音页/收起侧栏,录音继续;
 *   App 顶栏图标通过 useRecorderActive() 订阅状态显示红点。
 * - 采集编码:getUserMedia → AudioContext → ScriptProcessorNode → lamejs mp3
 *   (单声道 64kbps,约 0.48MB/分钟),纯前端软编码,Rust 侧零音频依赖。
 * - 分片落盘:每约 8 秒(或积攒 ≥128KB)把 mp3 分片 base64 调 Rust
 *   recording_append 追加写入保存目录(默认「文档\TickTask录音」,可自定义),
 *   文件名 = 标题.mp3;内存占用有界,异常退出最多损失最后一个未落盘分片;
 *   失败分片放回队头下轮重试。
 * - 时长一律前端秒表记录(mp3 元数据不可靠),暂停期间不计时。
 * - 单条硬限制 2 小时:1h55m 提醒 → 2h 自动停止并保存;麦克风拔出/断连
 *   (track ended)自动「完成保存」已录内容。
 * - 麦克风授权两层模型:WebView2 询问框由 additionalBrowserArgs
 *   --use-fake-ui-for-media-stream 自动应答;Windows 系统级禁麦抛
 *   NotAllowedError,由视图引导用户跳转系统设置页。
 */

import { useSyncExternalStore } from 'react'
import lamejs from '@breezystack/lamejs'
import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './useTaskStore'
import { saveDiskPref } from './prefs'
import { trackFeature } from './analytics'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** mp3 码率(kbps)。64kbps 单声道 ≈ 0.48MB/分钟。 */
const MP3_KBPS = 64
/** 单条录音硬上限:2 小时。 */
export const RECORD_MAX_MS = 2 * 60 * 60 * 1000
/** 到达上限前的提醒时点:1 小时 55 分。 */
const RECORD_WARN_MS = 115 * 60 * 1000
/** 分片落盘节奏:每 8 秒或积攒 128KB。 */
const FLUSH_INTERVAL_MS = 8000
const FLUSH_PENDING_BYTES = 128 * 1024
/** 计时快照节奏(React 重渲染频率)。 */
const TICK_MS = 200

// ---------------------------------------------------------------------------
// 快照与订阅
// ---------------------------------------------------------------------------

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'saving'

export type MicErrorKind =
  /** WebView2/系统拒绝麦克风访问(多半是 Windows 隐私设置禁麦)。 */
  | 'denied'
  /** 无麦克风设备。 */
  | 'notfound'
  /** 设备被其他应用占用。 */
  | 'busy'
  /** 磁盘写入失败。 */
  | 'disk'
  /** 非桌面运行时。 */
  | 'nottauri'
  /** 其他未知错误。 */
  | 'unknown'

export interface RecordingResult {
  id: string
  durationMs: number
  bytes: number
  /** 结束原因:手动完成 / 达到时长上限 / 设备断开自动保存。 */
  reason: 'manual' | 'limit' | 'device'
  /** 末尾分片是否成功落盘(false=文件尾部可能缺最后几秒)。 */
  savedOk: boolean
}

export interface RecorderSnapshot {
  status: RecorderStatus
  /** 已录毫秒(暂停时冻结)。 */
  elapsedMs: number
  error: string | null
  errorKind: MicErrorKind | null
  /** 最近一次完成保存的结果(视图据此弹 toast,消费后不会自动清除)。 */
  lastResult: RecordingResult | null
  /** 是否已发过「即将到达上限」提醒。 */
  limitWarned: boolean
}

let snapshot: RecorderSnapshot = {
  status: 'idle',
  elapsedMs: 0,
  error: null,
  errorKind: null,
  lastResult: null,
  limitWarned: false,
}

type Listener = () => void
/** 全量订阅:每次快照变化(含 200ms 计时)都通知,供录音页使用。 */
const fullListeners = new Set<Listener>()
/** 状态订阅:仅在 status 变化时通知,供顶栏图标红点(避免整页高频重渲染)。 */
const statusListeners = new Set<Listener>()
let lastNotifiedStatus: RecorderStatus = snapshot.status

function notify(): void {
  for (const l of fullListeners) l()
  if (snapshot.status !== lastNotifiedStatus) {
    lastNotifiedStatus = snapshot.status
    for (const l of statusListeners) l()
  }
}

function patch(next: Partial<RecorderSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  notify()
}

export function subscribeRecorder(cb: Listener): () => void {
  fullListeners.add(cb)
  return () => fullListeners.delete(cb)
}

export function getRecorderSnapshot(): RecorderSnapshot {
  return snapshot
}

/** 录音页用:全量快照订阅(约 5Hz 重渲染,页面小,开销可忽略)。 */
export function useRecorderSnapshot(): RecorderSnapshot {
  return useSyncExternalStore(subscribeRecorder, getRecorderSnapshot, getRecorderSnapshot)
}

function subscribeStatus(cb: Listener): () => void {
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
}

function getStatus(): RecorderStatus {
  return snapshot.status
}

/** 顶栏图标用:仅订阅 status 变化(不随计时重渲染)。 */
export function useRecorderActive(): boolean {
  const status = useSyncExternalStore(subscribeStatus, getStatus, getStatus)
  return status === 'recording' || status === 'paused' || status === 'starting' || status === 'saving'
}

/** 声波动画用:读当前麦克风电平(0~1,带衰减平滑),不走 React 渲染。 */
export function getRecorderLevel(): number {
  return level
}

// ---------------------------------------------------------------------------
// 引擎内部状态(模块级,单例)
// ---------------------------------------------------------------------------

let stream: MediaStream | null = null
let ctx: AudioContext | null = null
let processor: ScriptProcessorNode | null = null
let muteGain: GainNode | null = null
let encoder: lamejs.Mp3Encoder | null = null
let recId: string | null = null
/** 当前录音所在目录('' = 默认「文档\TickTask录音」)与磁盘文件名(含 .mp3)。 */
let recDir = ''
let recFile = ''
let pending: Uint8Array[] = []
let pendingBytes = 0
let bytesOnDisk = 0
let encodedBytes = 0
let accumulatedMs = 0
let resumeAt = 0
let isPaused = false
let level = 0
let lastFlushWallAt = 0
let flushFailures = 0
let tickTimer: number | null = null

function currentElapsedMs(): number {
  if (isPaused) return accumulatedMs
  return accumulatedMs + (resumeAt ? Date.now() - resumeAt : 0)
}

function teardownAudio(): void {
  if (processor) {
    processor.onaudioprocess = null
    processor.disconnect()
    processor = null
  }
  if (muteGain) {
    muteGain.disconnect()
    muteGain = null
  }
  if (stream) {
    for (const t of stream.getTracks()) {
      t.onended = null
      t.stop()
    }
    stream = null
  }
  if (ctx) {
    void ctx.close().catch(() => {})
    ctx = null
  }
  encoder = null
}

function stopTick(): void {
  if (tickTimer !== null) {
    window.clearInterval(tickTimer)
    tickTimer = null
  }
}

function handleAudio(ev: AudioProcessingEvent): void {
  const input = ev.inputBuffer.getChannelData(0)
  // 实时电平(rms,放大并限幅,保留衰减):供声波动画 rAF 读取。
  let sum = 0
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
  const rms = Math.sqrt(sum / input.length)
  const target = Math.min(1, rms * 3.5)
  level = Math.max(level * 0.65, target)

  if (isPaused || !encoder) return
  // Float32 → Int16
  const pcm = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const out = encoder.encodeBuffer(pcm)
  if (out.length > 0) {
    pending.push(out)
    pendingBytes += out.length
    encodedBytes += out.length
  }
  const now = Date.now()
  if (now - lastFlushWallAt >= FLUSH_INTERVAL_MS || pendingBytes >= FLUSH_PENDING_BYTES) {
    lastFlushWallAt = now
    void flush()
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    const sub = bytes.subarray(i, Math.min(i + step, bytes.length))
    binary += String.fromCharCode(...sub)
  }
  return btoa(binary)
}

/** 把积攒的 mp3 分片落盘;失败分片放回队头下轮重试,连续失败 2 次返回 false。 */
async function flush(): Promise<boolean> {
  if (!recFile || pending.length === 0) return true
  const merged = concatBytes(pending)
  pending = []
  pendingBytes = 0
  try {
    const b64 = bytesToBase64(merged)
    bytesOnDisk = await invoke<number>('recording_append', {
      dir: recDir,
      file: recFile,
      data: b64,
    })
    flushFailures = 0
    return true
  } catch (e) {
    flushFailures++
    pending.unshift(merged)
    pendingBytes += merged.length
    if (flushFailures >= 2) {
      // 连续两次写盘失败(磁盘满/目录被删等):停止录音,已落盘部分仍保留。
      patch({
        error: `写入磁盘失败:${String(e)}`,
        errorKind: 'disk',
      })
      if (snapshot.status === 'recording' || snapshot.status === 'paused') {
        void stopRecording('manual')
      }
      return false
    }
    return true
  }
}

function concatBytes(list: Uint8Array[]): Uint8Array {
  let total = 0
  for (const b of list) total += b.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const b of list) {
    out.set(b, offset)
    offset += b.length
  }
  return out
}

function classifyMicError(err: unknown): { kind: MicErrorKind; text: string } {
  const name = err instanceof DOMException ? err.name : ''
  const detail = err instanceof Error ? err.message : String(err)
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { kind: 'denied', text: '麦克风访问被拒绝,请检查 Windows 隐私设置' }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { kind: 'notfound', text: '未检测到麦克风设备,请检查连接' }
    case 'NotReadableError':
    case 'AbortError':
      return { kind: 'busy', text: '麦克风正被其他应用占用,请关闭后重试' }
    default:
      return { kind: 'unknown', text: `启动录音失败:${detail}` }
  }
}

// ---------------------------------------------------------------------------
// 引擎公开操作
// ---------------------------------------------------------------------------

/** 开始一段新录音(仅 idle 状态可调用)。抛出的错误带 errorKind 供视图引导。 */
export async function startRecording(): Promise<void> {
  if (snapshot.status !== 'idle') return
  if (!isTauriRuntime()) {
    patch({ error: '请在 TickTask 桌面版中使用录音功能', errorKind: 'nottauri' })
    return
  }
  patch({ status: 'starting', error: null, errorKind: null, lastResult: null, limitWarned: false })
  level = 0
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    })
  } catch (err) {
    const { kind, text } = classifyMicError(err)
    patch({ status: 'idle', error: text, errorKind: kind })
    return
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // 文件名 = 标题:默认标题在开始录音时即生成(旧版在保存时生成,没法和文件名对上)。
  const pad0 = (n: number) => String(n).padStart(2, '0')
  const startedAt = new Date()
  const baseTitle = `录音 ${startedAt.getMonth() + 1}月${startedAt.getDate()}日 ${pad0(
    startedAt.getHours(),
  )}:${pad0(startedAt.getMinutes())}`
  const dir = loadRecordingsDir()
  // 同目录下文件名查重(基于现有记录;磁盘孤儿文件冲突由 recording_begin 兜底加序号)。
  const used = new Set(
    loadRecordings()
      .filter((r) => (r.dir || '') === dir)
      .map((r) => r.file || `${r.id}.mp3`),
  )
  let file = sanitizeFileName(baseTitle)
  if (used.has(file)) {
    const stem = file.replace(/\.mp3$/i, '')
    let n = 2
    while (used.has(`${stem} (${n}).mp3`) && n < 999) n++
    file = `${stem} (${n}).mp3`
  }
  try {
    // 先建文件并确保目录可用,把磁盘问题挡在录音开始前;重名时 Rust 返回实际文件名。
    file = await invoke<string>('recording_begin', { dir, file })
  } catch (err) {
    teardownAudio()
    patch({ status: 'idle', error: `录音目录不可用:${String(err)}`, errorKind: 'disk' })
    return
  }

  try {
    ctx = new AudioContext()
    await ctx.resume()
    const source = ctx.createMediaStreamSource(stream)
    processor = ctx.createScriptProcessor(4096, 1, 1)
    // 静音直连:ScriptProcessor 必须接到 destination 才会回调,但麦克风不能外放。
    muteGain = ctx.createGain()
    muteGain.gain.value = 0
    source.connect(processor)
    processor.connect(muteGain)
    muteGain.connect(ctx.destination)
    encoder = new lamejs.Mp3Encoder(1, ctx.sampleRate, MP3_KBPS)
    processor.onaudioprocess = handleAudio

    // 麦克风拔出/蓝牙断连:自动「完成保存」已录内容。
    stream.getAudioTracks()[0].onended = () => {
      if (snapshot.status === 'recording' || snapshot.status === 'paused') {
        void stopRecording('device')
      }
    }
  } catch (err) {
    teardownAudio()
    const { kind, text } = classifyMicError(err)
    patch({ status: 'idle', error: text, errorKind: kind })
    return
  }

  recId = id
  recDir = dir
  recFile = file
  pending = []
  pendingBytes = 0
  bytesOnDisk = 0
  encodedBytes = 0
  accumulatedMs = 0
  resumeAt = Date.now()
  isPaused = false
  lastFlushWallAt = Date.now()
  flushFailures = 0
  trackFeature('record-start')
  patch({ status: 'recording', elapsedMs: 0 })

  stopTick()
  tickTimer = window.setInterval(() => {
    const elapsed = currentElapsedMs()
    if (snapshot.elapsedMs === elapsed) return
    const next: Partial<RecorderSnapshot> = { elapsedMs: elapsed }
    if (!snapshot.limitWarned && elapsed >= RECORD_WARN_MS && elapsed < RECORD_MAX_MS) {
      next.limitWarned = true
    }
    patch(next)
    if (elapsed >= RECORD_MAX_MS) {
      // 达到单条上限:自动停止并保存。
      void stopRecording('limit')
    }
  }, TICK_MS)
}

/** 暂停(冻结计时,继续保留设备);仅录音中可调用。 */
export function pauseRecording(): void {
  if (snapshot.status !== 'recording') return
  accumulatedMs += Date.now() - resumeAt
  isPaused = true
  patch({ status: 'paused' })
}

/** 继续录音;仅暂停态可调用。 */
export function resumeRecording(): void {
  if (snapshot.status !== 'paused') return
  resumeAt = Date.now()
  isPaused = false
  patch({ status: 'recording' })
}

/**
 * 完成录音并保存。返回保存结果(异常时 status 回到 idle 并置 error)。
 * reason: manual=用户点完成;limit=到达时长上限;device=设备断开自动保存。
 */
export async function stopRecording(
  reason: RecordingResult['reason'] = 'manual',
): Promise<RecordingResult | null> {
  if (snapshot.status !== 'recording' && snapshot.status !== 'paused') return null
  const id = recId!
  const dir = recDir
  const file = recFile
  patch({ status: 'saving' })
  stopTick()
  const durationMs = currentElapsedMs()
  const endedAt = new Date()
  if (encoder) {
    const tail = encoder.flush()
    if (tail.length > 0) {
      pending.push(tail)
      pendingBytes += tail.length
      encodedBytes += tail.length
    }
  }
  const savedOk = await flush()
  teardownAudio()
  recId = null
  recDir = ''
  recFile = ''
  isPaused = false
  level = 0
  // 落盘字节数优先取磁盘真实值;落盘失败时退回编码统计(近似)。
  const bytes = savedOk ? bytesOnDisk : bytesOnDisk + pendingBytes
  const result: RecordingResult = { id, durationMs, bytes, reason, savedOk }
  // 元数据持久化放在引擎侧:即使录音页未打开(收起侧栏时点完成),记录也不丢。
  // 标题取自实际文件名(begin 重名加序号后标题同步,保证「文件名 = 标题」)。
  const title = file.replace(/\.mp3$/i, '')
  const all = loadRecordings()
  all.push({
    id,
    title,
    note: '',
    durationMs,
    bytes,
    createdAtIso: endedAt.toISOString(),
    dir,
    file,
  })
  saveRecordings(all)
  trackFeature('record-save')
  patch({ status: 'idle', elapsedMs: 0, lastResult: result })
  return result
}

/** 取消并丢弃当前录音(删除半成品文件)。 */
export async function cancelRecording(): Promise<void> {
  if (snapshot.status !== 'recording' && snapshot.status !== 'paused') return
  const dir = recDir
  const file = recFile
  stopTick()
  teardownAudio()
  recId = null
  recDir = ''
  recFile = ''
  pending = []
  pendingBytes = 0
  isPaused = false
  level = 0
  if (file) {
    try {
      await invoke('recording_delete', { dir, file })
    } catch {
      /* 删不掉就留着,用户可手动清理 */
    }
  }
  patch({ status: 'idle', elapsedMs: 0 })
}

// ---------------------------------------------------------------------------
// 录音记录元数据(localStorage + 磁盘 prefs 双持久化)
// ---------------------------------------------------------------------------

export interface RecordingMeta {
  id: string
  title: string
  note: string
  durationMs: number
  bytes: number
  /** ISO 时间戳(本地构造后再 toISOString,显示时本地时区取日期)。 */
  createdAtIso: string
  /** 录音所在目录('' = 默认「文档\TickTask录音」);0.4.36 起支持自定义。 */
  dir: string
  /** 磁盘文件名(含 .mp3),与 title 保持一致;旧记录回填 <id>.mp3。 */
  file: string
}

const STORE_KEY = 'ticktask.recordings.v1'
const DISK_KEY = 'recordings'

function normalize(list: unknown): RecordingMeta[] {
  if (!Array.isArray(list)) return []
  const out: RecordingMeta[] = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const r = it as Partial<RecordingMeta>
    if (typeof r.id !== 'string' || !r.id) continue
    out.push({
      id: r.id,
      title: typeof r.title === 'string' && r.title.trim() ? r.title : '新录音',
      note: typeof r.note === 'string' ? r.note : '',
      durationMs: Number.isFinite(r.durationMs) && Number(r.durationMs) > 0 ? Number(r.durationMs) : 0,
      bytes: Number.isFinite(r.bytes) && Number(r.bytes) > 0 ? Number(r.bytes) : 0,
      createdAtIso: typeof r.createdAtIso === 'string' ? r.createdAtIso : new Date().toISOString(),
      // 旧记录(0.4.35 以前)无 dir/file:回填默认目录 + <id>.mp3,老文件照常可播。
      dir: typeof r.dir === 'string' ? r.dir : '',
      file:
        typeof r.file === 'string' && r.file.trim()
          ? r.file
          : `${r.id.replace(/[\\/:*?"<>|]/g, '')}.mp3`,
    })
  }
  // 旧的在前,新的在后(追加式);视图自行倒序分组。
  return out
}

/** 读取录音记录:localStorage 优先,磁盘 prefs 兜底(WebView 缓存被清时自愈)。 */
export function loadRecordings(): RecordingMeta[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) return normalize(JSON.parse(raw))
  } catch {
    /* 落到兜底 */
  }
  return []
}

/** 保存录音记录:localStorage 即时写,磁盘 prefs 异步镜像。 */
export function saveRecordings(list: RecordingMeta[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list))
  } catch {
    /* localStorage 满等异常不阻断 */
  }
  void saveDiskPref(DISK_KEY, list)
}

/** 磁盘 prefs 里的录音记录(WebView localStorage 丢失时的回灌来源)。 */
export function parseDiskRecordings(raw: unknown): RecordingMeta[] {
  if (Array.isArray(raw)) return normalize(raw)
  if (typeof raw === 'string') {
    try {
      return normalize(JSON.parse(raw))
    } catch {
      return []
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// 保存目录配置(localStorage + 磁盘 prefs 双持久化;'' = 默认「文档\TickTask录音」)
// ---------------------------------------------------------------------------

const DIR_STORE_KEY = 'ticktask.recordings.dir.v1'
const DIR_DISK_KEY = 'recordingsDir'

/** 读取自定义保存目录('' = 默认目录)。 */
export function loadRecordingsDir(): string {
  try {
    return localStorage.getItem(DIR_STORE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 保存自定义保存目录('' = 恢复默认)。 */
export function saveRecordingsDir(dir: string): void {
  try {
    if (dir) localStorage.setItem(DIR_STORE_KEY, dir)
    else localStorage.removeItem(DIR_STORE_KEY)
  } catch {
    /* localStorage 异常不阻断 */
  }
  void saveDiskPref(DIR_DISK_KEY, dir)
}

/** 磁盘 prefs 里的保存目录(WebView localStorage 丢失时的回灌来源)。 */
export function parseDiskRecordingsDir(raw: unknown): string {
  return typeof raw === 'string' ? raw : ''
}

/** 标题 → 安全文件名:挡 Windows 非法字符,压空白、去结尾点/空格,固定 .mp3 后缀。 */
export function sanitizeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, 60)
  return cleaned ? `${cleaned}.mp3` : `录音 ${Date.now()}.mp3`
}
