// OCR 转待办事件桥:子窗(覆盖层/贴图) → 主窗。
// 可靠性:复用项目 pin-set「重发 + 应答」模式 —— 贴图事件直发会丢,
// 这里 3 次重试 + 主窗 ack,全程无 ack 时 UI 给失败提示,杜绝「点了没反应」。
import { emit, listen } from '@tauri-apps/api/event';

export const OCR_TASK_EVENT = 'ocr-create-task';
export const OCR_TASK_ACK = 'ocr-create-task-ack';

export interface OcrTaskRequest {
  reqId: string;
  lines: { text: string }[];
}

/** 子窗口 → 主窗:请求逐行转待办。返回是否收到主窗 ack。 */
export async function emitOcrCreateTask(lines: { text: string }[]): Promise<boolean> {
  const reqId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let acked = false;
  const off = await listen<{ reqId: string }>(OCR_TASK_ACK, (e) => {
    if (e.payload?.reqId === reqId) acked = true;
  });
  try {
    for (let i = 0; i < 3 && !acked; i++) {
      try {
        await emit(OCR_TASK_EVENT, { reqId, lines } satisfies OcrTaskRequest);
      } catch {
        // 单次发送失败不终止,走重试
      }
      if (!acked) await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    off();
  }
  return acked;
}

/** 主窗:监听转待办请求;回调执行后自动回 ack。返回取消函数。 */
export async function onOcrCreateTask(
  cb: (lines: { text: string }[]) => void,
): Promise<() => void> {
  const off = await listen<OcrTaskRequest>(OCR_TASK_EVENT, (e) => {
    const p = e.payload;
    if (!p || typeof p.reqId !== 'string' || !Array.isArray(p.lines)) return;
    const lines = p.lines.filter(
      (l): l is { text: string } => !!l && typeof l.text === 'string' && !!l.text.trim(),
    );
    if (lines.length) cb(lines);
    void emit(OCR_TASK_ACK, { reqId: p.reqId });
  });
  return off;
}
