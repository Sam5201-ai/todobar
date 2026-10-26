// 截图 / 贴图:全局快捷键的注册与触发。
// 设置存于 localStorage,因此注册由前端驱动:读取设置 → 调用 Rust 命令注册,
// 并在设置变化时重新注册(先注销上一批)。Rust 侧快捷键触发后,通过
// `screenshot-trigger` 事件把动作发回主窗口,这里监听后启动对应流程。
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getSettings } from './store';
import { OVERLAY_LABEL, shotLog, startCapture, pinFromClipboardOrLast } from './bridge';

let lastApplied: { shot: string; pin: string } | null = null;
let initialized = false;

/** 根据当前设置注册 / 注销全局快捷键。返回是否成功(失败多为冲突)。 */
export async function applyShortcuts(): Promise<{ ok: boolean; error?: string }> {
  const s = getSettings();
  const unregister = lastApplied ? [lastApplied.shot, lastApplied.pin] : [];
  if (!s.enabled) {
    try {
      await invoke('register_screenshot_shortcuts', {
        unregister,
        shot: '',
        pin: '',
      });
      lastApplied = { shot: '', pin: '' };
    } catch {
      /* 注销失败可忽略 */
    }
    return { ok: true };
  }
  try {
    await invoke('register_screenshot_shortcuts', {
      unregister,
      shot: s.shotShortcut,
      pin: s.pinShortcut,
    });
    lastApplied = { shot: s.shotShortcut, pin: s.pinShortcut };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** 应用启动时调用一次:建立触发监听并应用当前设置。 */
export async function initScreenshotShortcuts(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    await listen<string>('screenshot-trigger', (event) => {
      const kind = event.payload;
      void shotLog(`shortcut triggered: ${kind}`);
      if (kind === 'shot') {
        // 触发时固定以「区域」模式进入,CaptureOverlay 工具栏可现场切换窗口/全屏。
        void startCapture('region');
      } else if (kind === 'pin') {
        // 覆盖层激活中:转发给覆盖层,钉**当前正在截的选区**;
        // 否则走「上次选区 / 剪贴板」流程。
        void (async () => {
          try {
            const active = await invoke<boolean>('is_overlay_active');
            if (active) {
              await emitTo(OVERLAY_LABEL, 'pin-hotkey');
              return;
            }
          } catch {
            /* 查询失败走默认流程 */
          }
          void pinFromClipboardOrLast();
        })();
      }
    });
  } catch {
    /* 事件监听在非 Tauri 环境不可用 */
  }
  await applyShortcuts();
}
