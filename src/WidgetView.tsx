/**
 * 牛马计薪器 · 桌面组件窗口(salary_widget)的渲染体。
 *
 * 仅在窗口 label = salary_widget 时由 main.tsx 挂载(主程序不渲染它)。
 * 复用 SalaryView 的计薪内核(loadConfig / computeDay / pickDailyQuote),
 * 每隔 500ms 刷新一次「今日已赚 / 下班倒计时 / 今日寄语」。
 *
 * 0.4.25: 三套样式按参考图二次深度校准 ——
 *  - 外层改为半透明磨砂玻璃(参考图质感),内层卡片更亮、层次分明;
 *  - 倒计时改为「数字 + 小时/分钟/秒标签一一对应」的三列布局;
 *  - 吉祥物升级为 3D 渲染图(ImageGen 生成,透明底):
 *    wide 小马(打工人头带+笔记本+书堆+咖啡)、candy winking 奶牛、
 *    sunset 牛牛伏案场景插画(带远山背景)。
 *
 * 交互:
 *  - 整卡可拖动(走 Tauri 原生 startDragging,不抢焦点、不吞文本选择);
 *  - 拖动结束位置持久化(localStorage + 磁盘偏好),下次打开原位置还原;
 *  - 右缘 48px 内(Mark 主程序 Dock 把手屏蔽区)自动左移避让,杜绝历史「主程序点不动」。
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  getCurrentWindow,
  currentMonitor,
  monitorFromPoint,
  availableMonitors,
  Window,
  PhysicalPosition,
  type Monitor,
} from '@tauri-apps/api/window'
import type { UnlistenFn } from '@tauri-apps/api/event'

import {
  loadConfig,
  computeDay,
  pickDailyQuote,
  fmtMoney,
  fmtDur,
  type SalaryConfig,
} from './SalaryView'
import {
  WIDGET_STATES,
  computeAutoStateKey,
  quipFor,
  stateDef,
  stateSubtitle,
  type WidgetStateKey,
} from './widgetStatus'
import {
  loadSalaryWidgetConfig,
  loadSalaryWidgetPos,
  saveSalaryWidgetPosLocal,
  normalizeStyle,
  STYLE_SIZES,
  SALARY_WIDGET_KEY,
  SALARY_WIDGET_POS_KEY,
  type SalaryWidgetConfig,
  type WidgetStyle,
  type WidgetPos,
} from './salaryWidgetConfig'
import { saveDiskPref, loadDiskPref } from './prefs'
import { isTauriRuntime } from './useTaskStore'
import { invoke } from '@tauri-apps/api/core'

import cowImg from './assets/widget/cow.png'
import sceneCowImg from './assets/widget/scene-cow.png'
import wideCardImg from './assets/widget/wide-card.jpg'
import './WidgetView.css'

/** 手动状态覆盖持久化键(仅当天有效)与趣味计时起点持久化键。 */
const WIDGET_STATE_OVERRIDE_KEY = 'ticktask.widgetStateOverride.v1'
const WIDGET_STATE_ENTER_KEY = 'ticktask.widgetStateEnter.v1'

/** 本地日期键(直接由本地 Date 构造,非 ISO 截取)。 */
function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 按标点符号把寄语拆成句子片段(保留句末标点),用于分行排版。 */
function quoteFrags(text: string): string[] {
  return text
    .split(/(?<=[，。！？；、…])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 估算文本显示宽度:CJK/中文标点/emoji 记 1,其余(英文数字空格)记 0.5。 */
function textWidth(s: string): number {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) >= 0x2e80 ? 1 : 0.5
  return w
}

/**
 * candy 分行判断标准:按「显示宽度预算」把句子贪心装进 maxRows 行 ——
 * 预算 = 总宽度 ÷ 行数;短句可多句同行,装不下才换行,保证整段文案都显示。
 */
function packRows(frags: string[], maxRows: number): string[] {
  if (frags.length <= maxRows) return frags
  const total = frags.reduce((a, f) => a + textWidth(f), 0)
  const budget = Math.ceil(total / maxRows)
  const rows: string[] = ['']
  const rowW: number[] = [0]
  for (const f of frags) {
    const w = textWidth(f)
    const i = rows.length - 1
    if (rowW[i] > 0 && rowW[i] + w > budget && rows.length < maxRows) {
      rows.push(f)
      rowW.push(w)
    } else {
      rows[i] += f
      rowW[i] += w
    }
  }
  return rows
}

/** 一行一句,最多 maxRows 行;单独成行的 emoji 并回上一句,片段超出时合并到最后一行(保证完整不截断)。 */
function onePerRow(frags: string[], maxRows: number): string[] {
  const merged: string[] = []
  for (const f of frags) {
    if (merged.length && textWidth(f) < 2) merged[merged.length - 1] += f
    else merged.push(f)
  }
  if (merged.length <= maxRows) return merged
  return [...merged.slice(0, maxRows - 1), merged.slice(maxRows - 1).join('')]
}

/** 渲染分行寄语:每行一个块级 span,完整显示不截断。balance=candy 的同行打包模式;tail 追加到最后一行。 */
function QuoteRows({ text, maxRows, balance, tail }: { text: string; maxRows: number; balance?: boolean; tail?: string }) {
  const frags = quoteFrags(text)
  const rows = balance ? packRows(frags, maxRows) : onePerRow(frags, maxRows)
  return (
    <>
      {rows.map((r, i) => (
        <span className="q-row" key={i}>
          {r}
          {tail && i === rows.length - 1 && <span className="st-flex">{tail}</span>}
        </span>
      ))}
    </>
  )
}

/** 浏览器预览用 ?style= 参数,其次 localStorage,再其次磁盘偏好;都缺省 candy。 */
async function resolveStyle(): Promise<WidgetStyle> {
  const q = new URLSearchParams(window.location.search).get('style')
  if (q === 'wide' || q === 'sunset') return q
  const local = loadSalaryWidgetConfig()
  if (local.style !== 'candy') return local.style
  const disk = await loadDiskPref<SalaryWidgetConfig>(SALARY_WIDGET_KEY)
  return normalizeStyle(disk?.style)
}

async function resolvePos(): Promise<WidgetPos | null> {
  const local = loadSalaryWidgetPos()
  if (local) return local
  return loadDiskPref<WidgetPos>(SALARY_WIDGET_POS_KEY)
}

/**
 * 校验历史位置是否仍落在任一可见显示器内(0.4.33 修复)。
 * 踩坑:更新会清 WebView2 localStorage,位置回退到磁盘 prefs;若保存后
 * 副屏被移除/分辨率变化,旧坐标(实测 x=2824)会把组件窗口整个放到屏幕外 ——
 * 窗口存在(任务管理器可见)但桌面上永远看不见。这里要求组件矩形与某台
 * 显示器有足量相交(物理像素 ≥120×120,排除「边缘露出一条缝」的半离屏),
 * 否则视为失效位置,交回居中逻辑。
 */
async function posOnVisibleScreen(pos: WidgetPos, style: WidgetStyle): Promise<boolean> {
  try {
    const monitors = await availableMonitors()
    for (const m of monitors) {
      const scale = m.scaleFactor || 1
      const w = Math.round(STYLE_SIZES[style].w * scale)
      const h = Math.round(STYLE_SIZES[style].h * scale)
      const overlapW = Math.min(pos.x + w, m.position.x + m.size.width) - Math.max(pos.x, m.position.x)
      const overlapH = Math.min(pos.y + h, m.position.y + m.size.height) - Math.max(pos.y, m.position.y)
      if (overlapW >= 120 && overlapH >= 120) return true
    }
  } catch {
    /* 显示器列表拿不到时保守放行,走原位置(与旧版行为一致) */
    return true
  }
  return false
}

/** 右缘避让:组件右边界进入屏幕右缘 48px(Dock 把手屏蔽区)时左移进安全区。 */
async function avoidRightEdge(style: WidgetStyle) {
  try {
    const win = getCurrentWindow()
    const monitor = (await currentMonitor()) as Monitor | null
    if (!monitor) return
    const pos = await win.outerPosition()
    const scale = monitor.scaleFactor || 1
    const w = STYLE_SIZES[style].w * scale
    const screenRight = monitor.position.x + monitor.size.width
    const margin = 48 * scale
    if (pos.x + w > screenRight - margin) {
      const nx = Math.round(screenRight - margin - w)
      await win.setPosition(new PhysicalPosition(nx, pos.y))
    }
  } catch {
    /* 位置信息拿不到时忽略 */
  }
}

/**
 * 首次打开且无历史位置时,居中到「主程序主窗口所在显示器」的桌面中央。
 * 0.4.21 踩坑:Rust 侧 current_monitor() 实测静默返回 None,组件被留在
 * Windows 默认级联位置(51,51)——居中一律在前端用显示器 API 做。
 * 优先主窗口所在显示器(组件跟随主程序),拿不到再退回组件自身所在显示器。
 */
async function centerOnMonitor(style: WidgetStyle) {
  try {
    const win = getCurrentWindow()
    let monitor: Monitor | null = null
    try {
      const main = await Window.getByLabel('main')
      if (main) {
        const p = await main.outerPosition()
        monitor = await monitorFromPoint(p.x, p.y)
      }
    } catch {
      /* 主窗口坐标拿不到时退回自身显示器 */
    }
    if (!monitor) monitor = await currentMonitor()
    if (!monitor) return
    const scale = monitor.scaleFactor || 1
    const w = Math.round(STYLE_SIZES[style].w * scale)
    const h = Math.round(STYLE_SIZES[style].h * scale)
    const x = Math.round(monitor.position.x + (monitor.size.width - w) / 2)
    const y = Math.round(monitor.position.y + (monitor.size.height - h) / 2)
    await win.setPosition(new PhysicalPosition(x, y))
  } catch {
    /* 定位失败时保持默认位置,不致命 */
  }
}

/** 星期中文(参考图样式:4月24日 周四)。 */
function dateLine(d: Date): string {
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 ${wk}`
}

/** 今日工作时长(小时,一位小数,参考图样式 6.8 h)。 */
function workedHours(sec: number): string {
  return `${(sec / 3600).toFixed(1)} h`
}

/**
 * 倒计时三列布局:「02 45 17」每个数字下方直接对齐 小时/分钟/秒 标签(参考图样式)。
 * 非倒计时状态(已下班/休息日)回退为整段文案。
 */
function CountdownCols({ text, cls }: { text: string; cls: string }) {
  const segs = text.split(':')
  const labels = ['小时', '分钟', '秒']
  if (segs.length !== 3) {
    return <div className={`${cls}-fallback`}>{text}</div>
  }
  return (
    <div className="cd-time">
      {segs.map((s, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="cd-time-colon" aria-hidden="true">
              :
            </span>
          )}
          <span className="cd-time-cell">
            <strong>{s}</strong>
            <em>{labels[i]}</em>
          </span>
        </Fragment>
      ))}
    </div>
  )
}

/** 编辑小图标(铅笔):提示可点击切换状态,点击直接打开选择弹窗。 */
function EditIcon({ onOpen }: { onOpen: () => void }) {
  return (
    <svg
      className="st-edit-ico"
      viewBox="0 0 20 20"
      aria-hidden="true"
      data-no-drag
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
    >
      <path
        d="M4.4 15.6l.8-3.1 7.9-7.9a1.8 1.8 0 0 1 2.5 0l.4.4a1.8 1.8 0 0 1 0 2.5l-7.9 7.9-3.1.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M11.9 5.8l2.3 2.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** 「今日状态」卡体:状态插图(emoji 徽章)+ 状态名 + 动态小字 + 吐槽语录。仅标题旁铅笔图标可切换状态。 */
function StatusBody({
  stateKey,
  sub,
  quip,
  variant,
}: {
  stateKey: WidgetStateKey
  sub: string
  quip: string
  variant?: 'candy' | 'sunset'
}) {
  const def = stateDef(stateKey)
  return (
    <div className={`st-body${variant ? ` st-body-${variant}` : ''}`}>
      <span className="st-avatar" style={{ background: def.bg }}>{def.emoji}</span>
      <div className="st-text">
        <div className="st-name" style={{ color: def.fg }}>{def.name}</div>
        <div className="st-sub">{sub}</div>
        <div className="st-quip">“{quip}”</div>
      </div>
    </div>
  )
}

/** 手动覆盖弹窗:8 状态宫格 + 恢复自动切换。 */
function StatePicker({
  current,
  isAuto,
  onPick,
  onRestore,
  onClose,
}: {
  current: WidgetStateKey
  isAuto: boolean
  onPick: (key: WidgetStateKey) => void
  onRestore: () => void
  onClose: () => void
}) {
  return (
    <div className="st-picker-mask" data-no-drag onClick={onClose}>
      <div className="st-picker" onClick={(e) => e.stopPropagation()}>
        <div className="st-picker-head">
          <span>选择今日状态</span>
          <button type="button" className="st-picker-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="st-pgrid">
          {WIDGET_STATES.map((d) => (
            <button
              key={d.key}
              type="button"
              className={`st-pitem${d.key === current ? ' is-cur' : ''}`}
              style={{ background: d.bg, color: d.fg }}
              onClick={() => onPick(d.key)}
            >
              <span className="st-pitem-emoji">{d.emoji}</span>
              <span className="st-pitem-name">{d.name}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="st-pauto"
          onClick={isAuto ? () => onPick(current) : onRestore}
        >
          {isAuto ? '当前为自动模式（可点击切换为手动模式）' : '当前为手动模式（点击恢复自动切换）'}
        </button>
      </div>
    </div>
  )
}

export function WidgetView() {
  const [style, setStyle] = useState<WidgetStyle>('candy')
  const [now, setNow] = useState(() => new Date())
  // 今日状态:手动覆盖(仅当天有效) + 选择弹窗 + 趣味计时起点(进入当前状态的时间戳)
  const [override, setOverride] = useState<{ key: WidgetStateKey; day: string } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [enterAt, setEnterAt] = useState(() => Date.now())

  const styleRef = useRef(style)
  styleRef.current = style
  const winRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null)
  const correctTimer = useRef<number | null>(null)

  // 解析风格 + 还原位置 + 注册拖动结束监听
  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let cancelled = false

    void (async () => {
      const s = await resolveStyle()
      if (!cancelled) setStyle(s)

      // 非 Tauri 环境(浏览器预览 ?style=):只渲染样式,跳过一切窗口操作。
      if (!isTauriRuntime()) return

      const win = getCurrentWindow()
      winRef.current = win

      const pos = await resolvePos()
      if (pos && (await posOnVisibleScreen(pos, s))) {
        try {
          await win.setPosition(new PhysicalPosition(pos.x, pos.y))
        } catch {
          /* 忽略 */
        }
      } else {
        // 首次打开,或历史位置已不在可见屏幕内(副屏移除/分辨率变化):
        // 居中到主窗口所在显示器的桌面中央(用户要求默认出现在桌面中间)
        await centerOnMonitor(s)
      }

      // 0.4.37 排障:「组件看不到」时从 app.log 能直接看到最终落点与尺寸。
      try {
        const fp = await win.outerPosition()
        const fs = await win.outerSize()
        void invoke('app_log', {
          message: `[widget] 窗口就位 pos=(${fp.x},${fp.y}) size=${fs.width}x${fs.height} style=${s}`,
        }).catch(() => {})
      } catch {
        /* 忽略 */
      }

      // [0.4.44] 组件窗口 visible:false 创建(启动残影根治):定位完成且首帧
      // 绘制后再显示,避免窗口先以 Windows 默认级联位置闪现未画内容的空窗。
      try {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        await win.show()
      } catch {
        /* 显示失败时由 Rust 侧 raise 路径延迟 1.5s 兜底 */
      }

      try {
        unlisten = await win.onMoved(async () => {
          try {
            const p = await win.outerPosition()
            const wp: WidgetPos = { x: p.x, y: p.y }
            saveSalaryWidgetPosLocal(wp)
            void saveDiskPref(SALARY_WIDGET_POS_KEY, wp)
          } catch {
            /* 忽略 */
          }
          if (correctTimer.current) window.clearTimeout(correctTimer.current)
          correctTimer.current = window.setTimeout(() => {
            void avoidRightEdge(styleRef.current)
          }, 160)
        })
      } catch {
        /* 拖动监听不可用时不致命 */
      }
    })()

    return () => {
      cancelled = true
      unlisten?.()
      if (correctTimer.current) window.clearTimeout(correctTimer.current)
    }
  }, [])

  // 500ms 刷新当前时间(金额按秒级实时变化)
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 500)
    return () => window.clearInterval(t)
  }, [])

  // 风格轮询:切换风格不销毁重建窗口(Rust 侧幂等开窗,只改尺寸),
  // 组件页靠轮询 localStorage 同步风格(两窗口同源共享,主程序写入后 ~800ms 生效)。
  // 注意:只跟随「配置变化」——若首轮读到的值与初始值相同就不覆盖,
  // 否则会把浏览器预览 ?style= 参数解析出的风格冲掉(0.4.23 踩坑)。
  useEffect(() => {
    let last = loadSalaryWidgetConfig().style
    const t = window.setInterval(() => {
      const s = loadSalaryWidgetConfig().style
      if (s !== last) {
        last = s
        setStyle(s)
      }
    }, 800)
    return () => window.clearInterval(t)
  }, [])

  const cfg: SalaryConfig = useMemo(() => loadConfig(), [now])
  const stat = useMemo(() => computeDay(cfg, now), [cfg, now])
  const quote = useMemo(() => pickDailyQuote(cfg, now), [cfg, now])
  const pct = stat.totalSec > 0 ? Math.min(100, (stat.workedSec / stat.totalSec) * 100) : 0

  // —— 今日状态 ——
  const autoKey = useMemo(() => computeAutoStateKey(cfg, now), [cfg, now])
  const todayKey = dayKeyOf(now)
  const activeKey: WidgetStateKey = override && override.day === todayKey ? override.key : autoKey
  const adef = stateDef(activeKey)
  const quip = quipFor(activeKey, now)
  const subtitle = stateSubtitle(activeKey, cfg, now, stat.workedSec, enterAt)

  // 趣味计时起点:展示状态变化(自动切换/手动覆盖)时重置;同状态重启沿用上次起点(持久化)。
  const enterRef = useRef<{ key: WidgetStateKey; at: number } | null>(null)
  useEffect(() => {
    let saved: { key?: string; at?: number } | null = null
    try {
      saved = JSON.parse(localStorage.getItem(WIDGET_STATE_ENTER_KEY) || 'null')
    } catch {
      /* 忽略 */
    }
    if (saved && saved.key === activeKey && typeof saved.at === 'number' && saved.at > 0) {
      enterRef.current = { key: activeKey, at: saved.at }
    } else {
      enterRef.current = { key: activeKey, at: Date.now() }
      try {
        localStorage.setItem(WIDGET_STATE_ENTER_KEY, JSON.stringify(enterRef.current))
      } catch {
        /* 忽略 */
      }
    }
    setEnterAt(enterRef.current.at)
  }, [activeKey])

  function pickState(key: WidgetStateKey) {
    const ov = { key, day: dayKeyOf(new Date()) }
    setOverride(ov)
    setPickerOpen(false)
    try {
      localStorage.setItem(WIDGET_STATE_OVERRIDE_KEY, JSON.stringify(ov))
    } catch {
      /* 忽略 */
    }
  }

  function clearOverride() {
    setOverride(null)
    setPickerOpen(false)
    try {
      localStorage.removeItem(WIDGET_STATE_OVERRIDE_KEY)
    } catch {
      /* 忽略 */
    }
  }

  const picker = pickerOpen ? (
    <StatePicker
      current={activeKey}
      isAuto={!override || override.day !== todayKey}
      onPick={pickState}
      onRestore={clearOverride}
      onClose={() => setPickerOpen(false)}
    />
  ) : null

  const invalid = stat.status === 'invalid'
  // 倒计时统一 HH:MM:SS(参考图样式);非工作状态给文案。
  const counting = stat.status === 'before' || stat.status === 'working' || stat.status === 'lunch'
  const countdownText = counting
    ? fmtDur(stat.remainSec)
    : stat.status === 'after'
      ? '已下班'
      : stat.status === 'rest'
        ? '休息日'
        : '--'
  const countdownSub = counting
    ? stat.status === 'before'
      ? '加油！马上开工啦！'
      : '加油！马上下班啦！'
    : stat.status === 'after'
      ? '今天辛苦啦，好好休息~'
      : '好好享受假期吧!'
  // candy 圆环内的加油语按「！」拆成两行(参考图样式:加油！/马上下班啦！)
  const subLines = counting
    ? countdownSub.split('！').filter(Boolean).map((s) => `${s}！`)
    : []

  function handlePointerDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    try {
      void winRef.current?.startDragging()
    } catch {
      /* 忽略 */
    }
  }

  async function handleClose() {
    try {
      await getCurrentWindow().close()
    } catch {
      /* 忽略 */
    }
  }

  // —— 风格一:candy 奶牛萌卡(卡片 440×370)——
  if (style === 'candy') {
    return (
      <div className="wv" onPointerDown={handlePointerDown} role="application" aria-label="牛马计薪器桌面组件">
        <div className="wv-card wv-candy">
          <button type="button" className="wv-close" data-no-drag onClick={handleClose} aria-label="关闭组件">×</button>
          <div className="cd-hero">
            <img className="cd-cow" src={cowImg} alt="" draggable={false} />
            <div className="cd-bubble">
              <div className="cd-bubble-title">
                牛马寄语 <span className="cd-heart">❤</span>
              </div>
              <p className="cd-quote"><QuoteRows text={quote} maxRows={3} balance /></p>
              <svg className="cd-sun" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="4.6" fill="none" stroke="#f2b64c" strokeWidth="2" />
                {Array.from({ length: 8 }).map((_, i) => {
                  const a = (i * Math.PI) / 4
                  return (
                    <line
                      key={i}
                      x1={12 + Math.cos(a) * 7.4}
                      y1={12 + Math.sin(a) * 7.4}
                      x2={12 + Math.cos(a) * 10.2}
                      y2={12 + Math.sin(a) * 10.2}
                      stroke="#f2b64c"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  )
                })}
              </svg>
            </div>
          </div>
          <div className="cd-cards">
            <div className="cd-card cd-earn">
              <div className="cd-card-head">
                <span className="cd-ico cd-ico-green">
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <rect x="4.5" y="4" width="11" height="13" rx="2" fill="#fff" />
                    <rect x="7" y="2.6" width="6" height="3" rx="1.4" fill="#3cb878" stroke="#fff" strokeWidth="1" />
                  </svg>
                </span>
                <span className="cd-card-title">今日状态</span>
                <EditIcon onOpen={() => setPickerOpen(true)} />
                <span className="cd-card-date">{dateLine(now)}</span>
              </div>
              <StatusBody stateKey={activeKey} sub={subtitle} quip={quip} variant="candy" />
            </div>
            <div className="cd-card cd-down">
              <div className="cd-card-head">
                <span className="cd-ico cd-ico-pink">
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <circle cx="10" cy="10" r="7.4" fill="none" stroke="#fff" strokeWidth="2" />
                    <path d="M10 6v4.4l3 1.8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="cd-card-title">下班倒计时</span>
                <span className="cd-card-date">今日 {cfg.workEnd}</span>
              </div>
              <div className="cd-ring">
                <svg viewBox="0 0 120 120" aria-hidden="true">
                  <circle className="cd-ring-bg" cx="60" cy="60" r="50" />
                  <circle
                    className="cd-ring-fg"
                    cx="60"
                    cy="60"
                    r="50"
                    style={{
                      strokeDasharray: `${2 * Math.PI * 50}`,
                      strokeDashoffset: `${2 * Math.PI * 50 * (1 - pct / 100)}`,
                    }}
                  />
                </svg>
                <div className="cd-ring-center">
                  <span className="cd-ring-ico">💼</span>
                  <strong>{countdownText}</strong>
                  {counting && (
                    <span className="cd-ring-note">
                      {subLines.map((line, i) => (
                        <span key={i} className="cd-ring-note-line">
                          {line}
                          {i === 0 && <span className="cd-heart-sm"> ❤</span>}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
              {!counting && <div className="cd-down-note">{countdownSub}</div>}
            </div>
          </div>
          <div className="cd-pills">
            <span className="cd-pill"><i className="cd-pi cd-pi-blue">✓</i>好好工作</span>
            <span className="cd-pill"><i className="cd-pi cd-pi-pink">❤</i>按时下班</span>
            <span className="cd-pill"><i className="cd-pi cd-pi-green">✓</i>好好生活</span>
            <span className="cd-pill"><i className="cd-pi cd-pi-yellow">★</i>保持开心</span>
          </div>
        </div>
        <FlowersTL />
        <FlowerBouquet />
        {picker}
      </div>
    )
  }

  // —— 风格二:wide 小马宽屏(卡片 560×240)——
  if (style === 'wide') {
    return (
      <div className="wv" onPointerDown={handlePointerDown} role="application" aria-label="牛马计薪器桌面组件">
        <div className="wv-card wv-wide">
          <button type="button" className="wv-close" data-no-drag onClick={handleClose} aria-label="关闭组件">×</button>
          <div className="wd-quote">
            <img className="wd-quote-bg" src={wideCardImg} alt="" draggable={false} />
            <div className="wd-quote-inner">
              <div className="wd-quote-head">
                <svg className="wd-qmark" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 15c0-5 2.4-8.4 6-10l1 1.8C9.6 8.2 8.6 10 8.4 11.6c.3-.1.7-.2 1.1-.2 1.7 0 3 1.3 3 3.1S11.1 18 9.2 18C6.7 18 5 16.9 5 15Z" fill="#5b84b8" />
                  <path d="M14 15c0-5 2.4-8.4 6-10l1 1.8c-2.4 1.4-3.4 3.2-3.6 4.8.3-.1.7-.2 1.1-.2 1.7 0 3 1.3 3 3.1S20.1 18 18.2 18c-2.5 0-4.2-1.1-4.2-3Z" fill="#5b84b8" />
                </svg>
                牛马寄语
              </div>
              <p className="wd-quote-text"><QuoteRows text={quote} maxRows={5} /></p>
            </div>
            <div className="wd-doodle">加油！打工人！</div>
          </div>
          <div className="wd-col">
            <div className="wd-card wd-earn">
              <span className="wd-state-emoji-lg" style={{ background: adef.bg }}>{adef.emoji}</span>
              <div className="wd-card-mid">
                <div className="wd-card-title">
                  今日状态
                  <EditIcon onOpen={() => setPickerOpen(true)} />
                </div>
                <div className="wd-state-name" style={{ color: adef.fg }}>{adef.name}</div>
                <div className="wd-state-sub">{subtitle}</div>
              </div>
              <div className="wd-earn-right">
                <div className="wd-state-quip">“{quip}”</div>
              </div>
            </div>
            <div className="wd-card wd-down">
              <span className="wd-ico wd-ico-blue">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="10" cy="10" r="7.4" fill="none" stroke="#fff" strokeWidth="2" />
                  <path d="M10 6v4.4l3 1.8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div className="wd-card-mid">
                <div className="wd-card-title">下班倒计时</div>
                {counting ? (
                  <CountdownCols text={countdownText} cls="wd-down" />
                ) : (
                  <div className="wd-down-fallback">{countdownText}</div>
                )}
              </div>
              <div className="wd-down-note">坚持一下~<br />下班见自由!</div>
              <svg className="wd-mtn" viewBox="0 0 56 34" aria-hidden="true">
                <circle cx="44" cy="9" r="5" fill="none" stroke="#9db8d8" strokeWidth="2" />
                <polyline points="2,30 14,14 22,24 32,10 44,30" fill="none" stroke="#9db8d8" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        </div>
        {picker}
      </div>
    )
  }

  // —— 风格三:sunset 暖阳三栏(卡片 560×230)——
  return (
    <div className="wv" onPointerDown={handlePointerDown} role="application" aria-label="牛马计薪器桌面组件">
      <div className="wv-card wv-sunset">
        <button type="button" className="wv-close" data-no-drag onClick={handleClose} aria-label="关闭组件">×</button>
        <div className="st-quote">
          <div className="st-quote-head">
            <span className="st-quote-title">
              <svg className="st-sun" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="4.4" fill="#f2b64c" />
                {Array.from({ length: 8 }).map((_, i) => {
                  const a = (i * Math.PI) / 4
                  return (
                    <line
                      key={i}
                      x1={12 + Math.cos(a) * 7}
                      y1={12 + Math.sin(a) * 7}
                      x2={12 + Math.cos(a) * 9.8}
                      y2={12 + Math.sin(a) * 9.8}
                      stroke="#f2b64c"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  )
                })}
              </svg>
              牛马寄语
            </span>
            <span className="st-date">{dateLine(now)}</span>
          </div>
          <p className="st-quote-text"><QuoteRows text={quote} maxRows={4} tail=" 💪" /></p>
          <img className="st-scene" src={sceneCowImg} alt="" draggable={false} />
        </div>
        <div className="st-col st-col-earn">
          <div className="st-col-head">
            <span className="st-ico st-ico-green">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <rect x="4.5" y="4" width="11" height="13" rx="2" fill="#fff" />
                <rect x="7" y="2.6" width="6" height="3" rx="1.4" fill="#3cb878" stroke="#fff" strokeWidth="1" />
              </svg>
            </span>
            <span className="st-col-title">今日状态</span>
            <EditIcon onOpen={() => setPickerOpen(true)} />
          </div>
          <StatusBody stateKey={activeKey} sub={subtitle} quip={quip} variant="sunset" />
          <div className="st-foot">
            <div className="st-foot-item">
              <span>今日工作时长</span>
              <strong>
                <svg className="st-foot-ico" viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="10" cy="10" r="7.2" fill="none" stroke="#5a6470" strokeWidth="1.8" />
                  <path d="M10 6v4.2l2.6 1.6" fill="none" stroke="#5a6470" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {invalid ? '--' : workedHours(stat.workedSec)}
              </strong>
            </div>
            <div className="st-foot-sep" />
            <div className="st-foot-item">
              <span>时薪（约）</span>
              <strong>
                <svg className="st-foot-ico st-foot-ico-green" viewBox="0 0 20 20" aria-hidden="true">
                  <polyline points="3,14 8,9 11,11.5 17,5.5" fill="none" stroke="#2fa46b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <polyline points="12.5,5.5 17,5.5 17,10" fill="none" stroke="#2fa46b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                ¥ {invalid ? '--' : fmtMoney(stat.hourlyPay)}
              </strong>
            </div>
          </div>
        </div>
        <div className="st-col st-col-down">
          <div className="st-col-head">
            <span className="st-ico st-ico-blue">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="7.4" fill="none" stroke="#fff" strokeWidth="2" />
                <path d="M10 6v4.4l3 1.8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="st-col-title">下班倒计时</span>
          </div>
          <div className="st-down-mid">
            {counting ? (
              <CountdownCols text={countdownText} cls="st-down" />
            ) : (
              <div className="st-down-fallback">{countdownText}</div>
            )}
          </div>
          <div className="st-bar">
            <div className="st-bar-track">
              <div className="st-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="st-bar-pct">{Math.round(pct)}%</span>
          </div>
          <div className="st-down-pill">
            <span className="st-pill-ico">☕</span>
            <span className="st-pill-text">再坚持一下，就能见到自由的晚霞了！</span>
            <svg className="st-pill-arrow" viewBox="0 0 20 12" aria-hidden="true">
              <path d="M2 9 Q6 2 10 6 T18 5" fill="none" stroke="#b8c2d8" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M15 3.5 L18.4 4.8 L16 7.4" fill="none" stroke="#b8c2d8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>
      {picker}
    </div>
  )
}

/* ================= candy 花朵装饰(SVG) ================= */

/** candy 左上角花朵装饰(粉花 + 黄花 + 小叶 + 小星)。 */
function FlowersTL() {
  return (
    <svg className="cd-flowers cd-flowers-tl" viewBox="0 0 72 72" aria-hidden="true">
      <path d="M6 58 Q0 42 18 42 Q24 56 6 58 Z" fill="#9bd9b0" />
      <Flower cx={22} cy={26} n={5} rx={6} ry={9} petal="#f7a8c4" core="#ffd24d" />
      <Flower cx={47} cy={15} n={5} rx={4.6} ry={7} petal="#ffd24d" core="#f08a3c" />
      <path d="M50 40 l2.4 6 6 .2 -4.6 4 1.8 5.8 -5.6 -3.4 -5.6 3.4 1.8 -5.8 -4.6 -4 6 -.2 Z" fill="#ffe49a" />
    </svg>
  )
}

/** candy 右下角花束装饰(一束粉/黄花 + 茎叶 + 蝴蝶结,置于下班倒计时卡右下角)。 */
function FlowerBouquet() {
  return (
    <svg className="cd-bouquet" viewBox="0 0 96 92" aria-hidden="true">
      {/* 茎 */}
      <path d="M44 86 Q44 68 44 52" stroke="#7cbf94" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M58 84 Q58 68 55 50" stroke="#8fd3a6" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M32 84 Q33 70 38 54" stroke="#8fd3a6" strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* 叶 */}
      <path d="M28 76 Q16 72 14 62 Q28 62 32 72 Z" fill="#9bd9b0" />
      <path d="M64 78 Q76 74 78 64 Q64 64 60 74 Z" fill="#9bd9b0" />
      <path d="M46 70 Q54 64 62 66 Q56 74 46 72 Z" fill="#b7e4c4" />
      {/* 花朵(一束四朵) */}
      <Flower cx={30} cy={38} n={5} rx={4.4} ry={6.6} petal="#ffd24d" core="#f08a3c" />
      <Flower cx={62} cy={40} n={5} rx={4.8} ry={7.2} petal="#fbb1cc" core="#fff3bf" />
      <Flower cx={46} cy={24} n={5} rx={4} ry={6} petal="#fbb1cc" core="#ffd24d" />
      <Flower cx={46} cy={46} n={6} rx={5.6} ry={8.4} petal="#f78fb8" core="#ffd24d" />
      {/* 蝴蝶结 */}
      <path d="M38 84 q8 5 16 0" stroke="#f27d9d" strokeWidth="4" fill="none" strokeLinecap="round" />
      <path d="M38 84 l-6 -7 M54 84 l6 -7" stroke="#f27d9d" strokeWidth="3.4" fill="none" strokeLinecap="round" />
    </svg>
  )
}

/** 单朵花(中心生成 n 片花瓣 + 花蕊)。 */
function Flower({
  cx,
  cy,
  n,
  rx,
  ry,
  petal,
  core,
}: {
  cx: number
  cy: number
  n: number
  rx: number
  ry: number
  petal: string
  core: string
}) {
  return (
    <g transform={`translate(${cx} ${cy})`}>
      {Array.from({ length: n }).map((_, i) => {
        const a = (i * 360) / n
        return <ellipse key={i} cx={0} cy={-(ry + 1)} rx={rx} ry={ry} fill={petal} transform={`rotate(${a})`} />
      })}
      <circle cx={0} cy={0} r={rx + 1} fill={core} />
    </g>
  )
}
