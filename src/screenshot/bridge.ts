// 截图 / 贴图:Rust 命令桥接 + 高层流程编排。
//
// B 路线(以 LiteSnap 为参考)的核心修正:
// 1. 覆盖层 / 贴图窗口全部走「预热常驻」——capture-overlay / pin-1 / pin-2 在
//    tauri.conf.json 静态定义(启动即创建并隐藏),触发快捷键只做 show + 物理定位,
//    目标 <100ms,杜绝每次新建 WebView2 窗口的冷启动白屏。
// 2. 窗口定位全链路物理像素(Rust 侧 set_position/set_size 均用 Physical*),
//    不在前端做任何 scaleFactor 除法 → 多屏混合 DPI 不再错位。
// 3. 采集按光标所在屏(Rust capture_screen 自带该屏 scale)。
// 4. 关闭路径收敛为单一 finishOverlay():隐藏而非销毁,下一次快捷键直接复用。
import { invoke } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { addPin } from './store';
import type { ScreenCapture } from './types';

export const FULL_KEY = 'shot-full';
export const REGION_KEY = 'shot-region';
export const LAST_KEY = 'shot-last';

export const OVERLAY_LABEL = 'capture-overlay';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function captureScreen(): Promise<ScreenCapture> {
  return invoke<ScreenCapture>('capture_screen');
}

export async function stashImage(key: string, value: string): Promise<void> {
  await invoke('stash_image', { key, value });
}

export async function takeImage(key: string): Promise<string | null> {
  return invoke<string | null>('take_image', { key });
}

export async function writeClipboardImage(pngBase64: string): Promise<void> {
  await invoke('write_clipboard_image', { pngBase64 });
}

export async function readClipboardImage(): Promise<string | null> {
  return invoke<string | null>('read_clipboard_image');
}

export async function saveImage(pngBase64: string, dir?: string): Promise<string> {
  return invoke<string>('save_image', { pngBase64, dir });
}

/** 「另存为」:把选区 PNG 写入用户在保存对话框选择的完整路径。 */
export async function saveImageTo(pngBase64: string, path: string): Promise<string> {
  return invoke<string>('save_image_to', { pngBase64, path });
}

export async function windowAtPoint(x: number, y: number): Promise<Rect | null> {
  return invoke<Rect | null>('window_at_point', { x, y });
}

export async function setIgnoreCursorEvents(label: string, value: boolean): Promise<void> {
  await invoke('set_window_ignore_cursor_events', { label, value });
}

export async function closeWindowByLabel(label: string): Promise<void> {
  await invoke('close_window', { label });
}

/** 查询某张贴图当前所在窗口 label(设置页历史管理用)。 */
export async function findPinWindow(pinId: string): Promise<string | null> {
  try {
    return await invoke<string | null>('find_pin_window', { pinId });
  } catch {
    return null;
  }
}

/** 关闭贴图窗口(池窗归还、动态窗销毁,由 Rust 侧区分)。 */
export async function dismissPinWindow(label: string): Promise<void> {
  try {
    await invoke('dismiss_pin_window', { label });
  } catch {
    /* ignore */
  }
}

/** 截图流程诊断日志(落盘 ~/.ticktask/logs/app.log),用于定位流程断点。 */
export async function shotLog(message: string): Promise<void> {
  try {
    await invoke('screenshot_log', { message });
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 加载 dataURL 为 HTMLImageElement。 */
export function loadImageDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = dataUrl;
  });
}

/** 显示主窗口(从任意子窗口调用,用于结束截图流程时恢复侧栏)。
 * 必须走 Rust 命令:JS 的 getByLabel 只能找到当前窗口自己创建的窗口。 */
export async function restoreMain(): Promise<void> {
  try {
    await invoke('show_main_window');
  } catch {
    /* ignore */
  }
}

/**
 * 结束截图流程的**唯一**出口(关闭路径收敛):
 * 走 Rust 原子命令 `finish_capture_overlay` —— 先隐藏覆盖层再恢复主窗,同一条
 * 命令内连续执行,零间隙。旧流程前端先 show 主窗(ShowWindow 会把主窗抬到
 * 覆盖层之上,主窗闪现)再隐藏覆盖层,造成退出时的屏幕弹动。
 */
export async function finishOverlay(): Promise<void> {
  try {
    await invoke('finish_capture_overlay');
  } catch {
    /* 兜底:分别尝试隐藏覆盖层与恢复主窗 */
    try {
      await invoke('hide_window', { label: OVERLAY_LABEL });
    } catch {
      /* ignore */
    }
    await restoreMain();
  }
}

/**
 * 启动截图:抓屏(主窗保持在画面里,与其他截图工具行为一致)→ 暂存元数据 →
 * 通知覆盖层开始本轮流程。覆盖层先在隐藏态定位、再画冻结帧,画完后自行调用
 * show_capture_overlay(只显示覆盖层+置焦,**不动主窗**)。主窗与覆盖层同为
 * alwaysOnTop,覆盖层必然盖在其上;冻结帧 = 抓屏时的桌面,与真实桌面逐像素
 * 一致 → 开始/结束全程无感过渡,零闪屏零弹动。
 */
export async function startCapture(mode: string): Promise<void> {
  try {
    const cap = await captureScreen();
    await shotLog(
      `capture ok ${cap.width}x${cap.height}@(${cap.left},${cap.top}) scale=${cap.scale} path=${cap.path}`,
    );
    // 存元数据(JSON):整屏图存本地文件路径,覆盖层经 read_capture_png 读回
    // base64 以 data: URL 加载(asset:// 跨源会污染 canvas,导致导出失败)。
    await stashImage(
      FULL_KEY,
      JSON.stringify({
        left: cap.left,
        top: cap.top,
        width: cap.width,
        height: cap.height,
        scale: cap.scale,
        path: cap.path,
        mode,
      }),
    );
    // 通知已挂载待命的覆盖层组件开始本轮流程(带就绪轮询与重发)。
    // 覆盖层画完冻结帧后自行调用 show_capture_overlay → is_overlay_active
    // 翻 true 即「已就绪」。事件偶发丢失时重发,不再出现「按了没反应」。
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await emitTo(OVERLAY_LABEL, 'overlay-show');
      } catch {
        /* 投递失败进入下一轮 */
      }
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 150));
        try {
          if (await invoke<boolean>('is_overlay_active')) {
            await shotLog(`overlay shown (attempt ${attempt})`);
            return;
          }
        } catch {
          /* 查询失败继续等 */
        }
      }
      await shotLog(`overlay not visible after attempt ${attempt}, re-emitting`);
    }
    await shotLog('overlay failed to show after 3 attempts');
    // 主窗未隐藏、屏幕未动,用户可再次触发。
  } catch (e) {
    console.error('startCapture 失败', e);
    await shotLog(`startCapture failed: ${String(e)}`);
    await restoreMain();
  }
}

/**
 * 把一张 PNG(base64)钉到桌面:x/y 为虚拟屏物理坐标(选区原位);
 * 省略时由 Rust 定位到光标附近(剪贴板贴图快捷键)。
 * 返回实际使用的窗口 label。
 */
export async function pinImage(
  pngBase64: string,
  x?: number,
  y?: number,
): Promise<string | null> {
  const dataUrl = `data:image/png;base64,${pngBase64}`;
  const img = await loadImageDataUrl(dataUrl);
  const id = `p${Date.now()}`;
  // 仅记录元数据;图片本体走 Rust stash(下方 pin:<id>),绝不入 localStorage。
  addPin(id);
  // Rust 命令参数是 i32:选区坐标经手柄拖拽可能是小数(如 535.5),
  // 直接传会 invalid args 报「贴图失败」,此处统一取整(2026-10-23 事故)。
  const rx = x == null ? null : Math.round(x);
  const ry = y == null ? null : Math.round(y);
  const rw = Math.round(img.naturalWidth);
  const rh = Math.round(img.naturalHeight);
  const label = await invoke<string>('show_pin_window', {
    pinId: id,
    x: rx,
    y: ry,
    width: rw,
    height: rh,
  });
  void shotLog(`pin window label=${label} size=${rw}x${rh} at=(${rx},${ry})`);
  // 元数据 + 图片数据双兜底:池窗已挂载走事件,动态新窗挂载时自读。
  await stashImage(`pin-meta:${label}`, JSON.stringify({ pinId: id }));
  await stashImage(`pin:${id}`, pngBase64);
  // ⚠️ Rust 侧不再代为 show 窗口 —— 前端 PinWindow 装载完图片后自行 show。
  // 事件丢失会导致贴图永不出现,因此这里带重试。
  for (let i = 0; i < 3; i++) {
    try {
      await emitTo(label, 'pin-set');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  return label;
}

/** 兼容入口(设置页「重新钉出」):从历史数据钉出一张贴图。 */
export async function openPin(
  pinId: string,
  width: number,
  height: number,
  dataUrl?: string,
): Promise<void> {
  // 历史贴图直接复用 pinImage 流程(新 id,避免与注册表旧映射冲突)。
  const b64 = dataUrl ? dataUrl.split(',')[1] ?? '' : '';
  if (!b64) return;
  void width;
  void height;
  void pinId;
  await pinImage(b64, undefined, undefined);
}

/** 贴图快捷键:把最近一次选区或剪贴板图片钉到桌面。 */
export async function pinFromClipboardOrLast(): Promise<void> {
  let pngBase64: string | null = null;
  const last = await takeImage(LAST_KEY);
  if (last) {
    pngBase64 = last;
  } else {
    pngBase64 = await readClipboardImage();
  }
  if (!pngBase64) return;
  await pinImage(pngBase64);
}

/** dataURL -> 去前缀的 base64。 */
export function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.split(',')[1] ?? '';
}
