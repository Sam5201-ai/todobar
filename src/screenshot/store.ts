// 截图 / 贴图:设置与贴图历史的本地持久化
// 设置正式存储在 ~/.ticktask/screenshot-settings.json(Rust 命令读写),
// localStorage 仅作运行时缓存 —— WebView 清缓存 / 异常退出不会丢设置。
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_SETTINGS, type PinItem, type ScreenshotSettings } from './types';

const SETTINGS_KEY = 'ticktask.screenshot.settings';
const PINS_KEY = 'ticktask.screenshot.pins';
const PIN_IMG_PREFIX = 'ticktask.pin.img.';

/**
 * 磁盘权威值的内存缓存(0.4.41 关键修复):
 * localStorage 会被应用自身的「清理 WebView 缓存」整个抹掉(useTaskStore bootstrap,
 * 且因 set_persist_config 参数命名 bug,cache_cleared 标记此前从未成功持久化 →
 * 每次启动都清一遍),清空时点在 hydrate/快捷键注册**之后** → 曾导致
 * 「面板显示停用、快捷键却可用」。此缓存由 hydrate 从磁盘填充、setSettings 同步
 * 更新,保证 getSettings() 在任何时序下都返回与快捷键注册一致的值,localStorage
 * 降级为纯跨窗口缓存(贴图/覆盖层窗口读它)。
 */
let diskSettings: ScreenshotSettings | null = null;

export function getSettings(): ScreenshotSettings {
  if (diskSettings) return { ...diskSettings };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSettings(s: ScreenshotSettings): void {
  diskSettings = { ...s };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  void invoke('save_screenshot_settings', { json: JSON.stringify(s) }).catch(() => {
    /* 落盘失败时 localStorage 仍可用 */
  });
}

/**
 * 设置值变更广播:hydrate 把磁盘值写回 localStorage 后,通知设置面板重新同步
 * 显示值,避免「面板显示停用、但快捷键已按磁盘值注册」的启动时序不同步
 * (2026-10-23 修复:磁盘残留 enabled:true 时面板曾显示默认停用却仍能用快捷键)。
 */
const SETTINGS_CHANGED_EVENT = 'ticktask:screenshot-settings-changed';

export function emitSettingsChanged(): void {
  try {
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  } catch {
    /* 非浏览器环境忽略 */
  }
}

export function onSettingsChanged(cb: () => void): () => void {
  try {
    window.addEventListener(SETTINGS_CHANGED_EVENT, cb);
  } catch {
    /* 非浏览器环境忽略 */
  }
  return () => {
    try {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, cb);
    } catch {
      /* ignore */
    }
  };
}

/** 启动时从磁盘恢复设置(内存缓存 + localStorage 双写),须在首次 getSettings 前调用。 */
export async function hydrateSettings(): Promise<void> {
  purgeLegacyPinImages();
  try {
    const json = await invoke<string | null>('get_screenshot_settings');
    if (json) {
      // 校验 JSON 合法再写入内存缓存与 localStorage
      const parsed = JSON.parse(json) as Partial<ScreenshotSettings>;
      diskSettings = { ...DEFAULT_SETTINGS, ...parsed };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(diskSettings));
      // 磁盘值已写入缓存,广播让设置面板刷新显示(与后续快捷键注册保持一致)。
      emitSettingsChanged();
      // 诊断日志:记录磁盘恢复结果,便于排查「面板显示与实际生效不一致」。
      try {
        void invoke('screenshot_log', {
          message: `settings hydrated from disk: enabled=${diskSettings.enabled}`,
        });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 无文件或读取失败,沿用 localStorage 缓存 */
  }
}

export function getPins(): PinItem[] {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PinItem[];
  } catch {
    return [];
  }
}

/** 贴图图片一律不读 localStorage(0.4.40 起图片不再写入,见 addPin 注释)。 */
export function getPinImage(_id: string): string | null {
  return null;
}

export function removePinImage(id: string): void {
  localStorage.removeItem(PIN_IMG_PREFIX + id);
}

/**
 * 清理历史版本遗留在 localStorage 里的贴图图片(大图 base64 曾撑爆 5MB 配额,
 * 导致 QuotaExceededError → 贴图失败,且会连累其他 localStorage 写入)。
 */
export function purgeLegacyPinImages(): void {
  try {
    const dead: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PIN_IMG_PREFIX)) dead.push(k);
    }
    for (const k of dead) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/**
 * 添加贴图到历史(仅元数据)。
 * ⚠️ 0.4.40 铁律:贴图 PNG base64 绝不能写 localStorage —— 一屏截图动辄 1MB+,
 * 5MB 配额两三张就爆,setItem 抛 QuotaExceededError 直接令贴图失败。
 * 图片数据走 Rust 进程内 stash(`pin:<id>`),贴图窗口自读。
 */
export function addPin(id: string): void {
  purgeLegacyPinImages();
  const pins = getPins();
  pins.unshift({ id, dataUrl: '', createdAt: Date.now() });
  localStorage.setItem(PINS_KEY, JSON.stringify(pins.slice(0, 12)));
}

export function removePin(id: string): void {
  const pins = getPins().filter((p) => p.id !== id);
  localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  removePinImage(id);
  setPinState(id, { locked: false, penetrated: false, opacity: 1 });
}

// ---- 贴图窗口的运行态(锁定 / 鼠标穿透 / 透明度),跨窗口共享(localStorage) ----

export interface PinState {
  locked: boolean;
  penetrated: boolean;
  opacity: number;
}

/** 穿透控制条窗口的逻辑尺寸(PinWindow 定位与 PinControlWindow 关气泡共用)。
 * 高度 = 气泡 bubbleH + 间隔 gap + 控制条 barH;关闭气泡后只剩 barH。 */
export const PIN_CTL = {
  w: 320,
  barH: 46,
  bubbleH: 100,
  gap: 12,
} as const;

const PIN_STATE_PREFIX = 'ticktask.pin.state.';
const LAST_PENETRATED_KEY = 'ticktask.pin.lastPenetrated';

export function getPinState(id: string): PinState {
  try {
    const raw = localStorage.getItem(PIN_STATE_PREFIX + id);
    if (!raw) return { locked: false, penetrated: false, opacity: 1 };
    const p = JSON.parse(raw) as Partial<PinState>;
    return {
      locked: !!p.locked,
      penetrated: !!p.penetrated,
      opacity: typeof p.opacity === 'number' ? Math.min(1, Math.max(0.1, p.opacity)) : 1,
    };
  } catch {
    return { locked: false, penetrated: false, opacity: 1 };
  }
}

export function setPinState(id: string, s: PinState): void {
  localStorage.setItem(PIN_STATE_PREFIX + id, JSON.stringify(s));
}

/** 最近一次进入「鼠标穿透」的贴图 id,供全局快捷键做穿透恢复逃生口。 */
export function getLastPenetratedPin(): string | null {
  return localStorage.getItem(LAST_PENETRATED_KEY);
}

export function setLastPenetratedPin(id: string | null): void {
  if (id) localStorage.setItem(LAST_PENETRATED_KEY, id);
  else localStorage.removeItem(LAST_PENETRATED_KEY);
}
