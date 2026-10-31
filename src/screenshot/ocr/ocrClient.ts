// OCR 客户端:区域 PNG → 临时文件(路径) → Rust 原生引擎识别。
// 大图守卫:4K 整屏裁剪 base64 可达 8~10MB,过大 IPC 卡顿(项目既有教训),
// 超限时引导用户框选更小区域。
import { invoke } from '@tauri-apps/api/core';
import { shotLog } from '../bridge';

export interface OcrLine {
  text: string;
  /** 置信度(macOS Vision 有;Windows 引擎无,undefined) */
  confidence?: number;
  /** 行框(原图物理像素) */
  bbox?: { x: number; y: number; w: number; h: number };
}

export interface OcrResult {
  lines: OcrLine[];
  engine: string;
  language: string;
}

export interface OcrStatus {
  available: boolean;
  engine: string;
  zhAvailable: boolean;
  enAvailable: boolean;
  warmed: boolean;
  message: string;
}

/** base64 字符数上限(≈6MB 二进制)。超过提示框选更小区域;贴图整图自动识别据此降采样重试。 */
export const OCR_INPUT_LIMIT = 8 * 1024 * 1024;

/** invoke 超时上限:引擎锁排队 + 最慢推理(4K 大图数十行)也远小于此。
 *  本项目已有 Tauri invoke 偶发挂起的先例(show_pin_window 等),不设超时
 *  会表现为「静默无响应、零日志」;超时抛错走调用方的失败日志链路。 */
const OCR_INVOKE_TIMEOUT_MS = 15000;

function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${tag}_TIMEOUT`)), ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 区域 PNG(物理像素,原图直出)→ 识别结果。 */
export async function recognizeRegion(pngBase64: string): Promise<OcrResult> {
  if (pngBase64.length > OCR_INPUT_LIMIT) {
    throw new Error('OCR_REGION_TOO_LARGE');
  }
  const t0 = performance.now();
  const path = await withTimeout(
    invoke<string>('ocr_save_input', { pngBase64 }),
    OCR_INVOKE_TIMEOUT_MS,
    'OCR_SAVE',
  );
  const r = await withTimeout(
    invoke<OcrResult>('ocr_recognize', { path }),
    OCR_INVOKE_TIMEOUT_MS,
    'OCR_RECOGNIZE',
  );
  void shotLog(
    `ocr ok engine=${r.engine} lang=${r.language} lines=${r.lines.length} ${Math.round(performance.now() - t0)}ms`,
  );
  return r;
}

/** 系统能力探测(设置面板展示;Win 缺语言包时 message 含安装指引)。 */
export async function ocrStatus(): Promise<OcrStatus> {
  return invoke<OcrStatus>('ocr_status');
}

/** 噪音行过滤:单字符且行高极小(物理像素)的行视为图标/装饰符噪音剔除。 */
export function filterNoiseLines(lines: OcrLine[]): OcrLine[] {
  return lines.filter((l) => {
    const t = l.text.trim();
    if (!t) return false;
    if (t.length <= 1 && l.bbox && l.bbox.h < 10) return false;
    return true;
  });
}

/** 全部文本合并(行间换行),供复制全部。 */
export function joinLines(lines: OcrLine[]): string {
  return lines.map((l) => l.text).join('\n');
}
