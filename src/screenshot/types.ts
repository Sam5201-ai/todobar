// 截图 / 贴图功能共享类型

export type CaptureMode = 'region' | 'window';

/** 一次整屏捕获结果(对应 Rust 侧 ScreenCapture)。
 * 只回传路径 + 尺寸,真实 PNG 在本地临时文件,覆盖层经 read_capture_png 命令
 * 读回 base64 以 data: URL 加载(0.4.40:asset:// 跨源会污染 canvas,禁用)。 */
export interface ScreenCapture {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 目标屏缩放比(DPI/96,多屏混合 DPI 时按各屏实际值)。 */
  scale: number;
  path: string;
}

export interface ScreenshotSettings {
  /** 总开关:是否启用截图/贴图及快捷键(默认关闭)。 */
  enabled: boolean;
  /** 截图快捷键(截图后进入区域选择)。 */
  shotShortcut: string;
  /** 贴图快捷键(把最近截图/剪贴板图片钉到桌面)。 */
  pinShortcut: string;
  /** 退出快捷键(在截图/标注窗口内按此键取消,默认 Esc)。 */
  exitShortcut: string;
}

export interface PinItem {
  id: string;
  /** 已编码的 PNG dataURL,用于历史恢复与再钉。 */
  dataUrl: string;
  createdAt: number;
}

export const DEFAULT_SETTINGS: ScreenshotSettings = {
  enabled: false,
  shotShortcut: 'CommandOrControl+Shift+A',
  pinShortcut: 'CommandOrControl+Shift+D',
  exitShortcut: 'Escape',
};

/** 系统保留 / 危险的快捷键,禁止绑定。 */
export const RESERVED_SHORTCUTS: string[] = [
  'CommandOrControl+Shift+Escape', // 任务管理器
  'Control+Alt+Delete',
  'CommandOrControl+Escape',
  'Alt+F4',
  'Alt+Tab',
  'Control+Alt+Tab',
  'CommandOrControl+Alt+Delete',
];
