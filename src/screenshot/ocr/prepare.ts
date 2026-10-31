// OCR 输入准备:纯无损操作(物理像素裁剪 + PNG 编码)。
// 精度优先铁律(方案 §1):不二值化、不放大、不加滤镜 —— 原图直出,
// 原生引擎(Vision / Media.Ocr)内部自带比前端更强的前处理。
import { dataUrlToBase64 } from '../bridge';

/** 从源图(canvas/img)按物理像素矩形裁剪出 PNG base64(dataUrl 去头)。
 *  source: 截图覆盖层的 base canvas / 贴图原图离屏 canvas。 */
export function cropRegionPng(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): string {
  const w = Math.max(1, Math.round(sw));
  const h = Math.max(1, Math.round(sh));
  const x = Math.max(0, Math.round(sx));
  const y = Math.max(0, Math.round(sy));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OCR 裁剪失败:无法创建画布');
  ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
  return dataUrlToBase64(canvas.toDataURL('image/png'));
}
