/**
 * 便利签窗口 <-> 主窗口 的桥接。
 *
 * 为什么「转待办」不直接在便利签窗口写数据库?
 *
 * 便利签窗口是独立轻量页面(不加载主界面的 useTaskStore / SQLite / 同步引擎)。
 * 若绕过去直接 `repo.saveTask()`,会**跳过 `addTask` 里的三件事**:
 *   ① 会员闸门(受限用户单日上限 FREE_DAILY_TASK_LIMIT)
 *   ② tasks 列表 reload
 *   ③ scheduleSync 同步触发
 * 结果就是「转成功了但主界面看不到、也不上云」,甚至会员过期后仍能无限转。
 *
 * 因此改为事件转发:便利签发请求 → 主窗口用标准 `addTask` 处理 → 回执给便利签。
 * 语义与在待办里手动新建完全一致,闸门、重绘、同步全部自动生效。
 */

import { emit, listen } from '@tauri-apps/api/event'

/** 便利签 → 主窗口:请求把某一条转为待办任务。 */
export type ConvertRequest = {
  noteId: string
  itemId: string
  text: string
}

/** 主窗口 → 便利签:转换结果回执。 */
export type ConvertResult = {
  noteId: string
  itemId: string
  ok: boolean
  /** 失败原因(如「今日免费额度已用完」「内容为空」),直接展示给用户。 */
  reason?: string
}

export async function requestConvert(req: ConvertRequest): Promise<void> {
  await emit('note-convert-request', req)
}

export async function emitConvertResult(res: ConvertResult): Promise<void> {
  await emit('note-convert-result', res)
}

/** 便利签窗口侧:监听回执。注意按 noteId 过滤 —— emit 是全局广播,所有便利签都会收到。 */
export async function listenConvertResult(
  cb: (res: ConvertResult) => void,
): Promise<() => void> {
  const un = await listen<ConvertResult>('note-convert-result', (e) => cb(e.payload))
  return un
}

/** 主窗口侧:监听转换请求。 */
export async function listenConvertRequest(
  cb: (req: ConvertRequest) => void,
): Promise<() => void> {
  const un = await listen<ConvertRequest>('note-convert-request', (e) => cb(e.payload))
  return un
}
