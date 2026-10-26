// 截图 / 贴图设置面板(2026-10-22 按用户反馈重构):
// - 仅保留「启用开关 + 三组快捷键」;默认模式 / 复制后自动关闭 / 保存·恢复默认
//   按钮 / 贴图历史区块全部移除。
// - 启用开关即拨即存(写入磁盘 ~/.ticktask/screenshot-settings.json 并重注册
//   快捷键),更新版本 / 重启后由 hydrateSettings 从磁盘恢复,不再依赖手动保存。
// - 快捷键:非编辑态置灰只读、双击进入编辑;编辑态录制组合键,右侧 ✓ 保存 /
//   ✕ 取消,点 ✓ 才写入生效。展示一律用键盘缩写(Ctrl / Alt / Esc),不再显示
//   CommandOrControl 全称。
// - 保存结果统一走父组件 toast(与设置页 toast 样式 / 位置 / 自动关闭一致),
//   不再使用内嵌横幅。
import { useCallback, useEffect, useState } from 'react';
import { getSettings, setSettings, onSettingsChanged } from './store';
import type { ScreenshotSettings } from './types';
import { RESERVED_SHORTCUTS } from './types';
import './screenshot.css';
import { applyShortcuts } from './shortcuts';
import { ShortcutField } from '../ShortcutField';

// 与系统托盘冲突的快捷键(CommandOrControl+Shift+T / +Alt+T 已被窗口开关键占用)。
const EXTRA_RESERVED = ['CommandOrControl+Shift+T', 'CommandOrControl+Shift+Alt+T'];

type ShortcutKey = 'shotShortcut' | 'pinShortcut' | 'exitShortcut';

function normalize(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

function conflictFor(
  settings: ScreenshotSettings,
  key: ShortcutKey,
): string | null {
  const value = settings[key];
  if (!value.trim()) return '快捷键不能为空';
  const reserved = [...RESERVED_SHORTCUTS, ...EXTRA_RESERVED];
  if (reserved.some((r) => normalize(r) === normalize(value))) {
    return '该快捷键被系统 / 托盘占用,请换一个';
  }
  const others = (['shotShortcut', 'pinShortcut', 'exitShortcut'] as ShortcutKey[]).filter(
    (k) => k !== key,
  );
  for (const o of others) {
    if (normalize(settings[o]) === normalize(value)) {
      return '与其他快捷键重复';
    }
  }
  // 基本格式校验:必须含一个非修饰键主键
  const main = value.split('+').pop()?.trim() ?? '';
  if (
    !main ||
    ['control', 'ctrl', 'commandorcontrol', 'command', 'cmd', 'alt', 'shift', 'super', 'meta']
      .includes(main.toLowerCase())
  ) {
    return '快捷键需包含一个主键(如 A、F2、数字),不能只有修饰键';
  }
  return null;
}

export default function ScreenshotSettingsPanel({
  onToast,
}: {
  /** 保存结果提示:复用设置页顶部 toast(样式 / 位置 / 自动关闭一致)。 */
  onToast?: (kind: 'ok' | 'err', text: string) => void;
}) {
  const [settings, setSettingsState] = useState<ScreenshotSettings>(() => getSettings());

  /**
   * 启动后 hydrate 会把磁盘真实值写回 localStorage,此处订阅广播并重新同步显示值,
   * 确保面板显示与快捷键实际注册状态一致(hydrate 之前面板读的是默认值)。
   * 50ms 兜底:万一 hydrate 广播早于本订阅触发,再读一次磁盘值(不影响编辑中的草稿)。
   */
  useEffect(() => {
    const sync = () => {
      const latest = getSettings();
      setSettingsState((prev) =>
        JSON.stringify(prev) === JSON.stringify(latest) ? prev : latest,
      );
    };
    const t = window.setTimeout(sync, 50);
    const off = onSettingsChanged(sync);
    // 挂载后前 3 秒周期对账(500ms 一次):即便广播早于订阅 / 事件丢失,
    // 面板显示也会在数秒内对齐磁盘真实值 —— 「显示停用但快捷键可用」的双保险。
    const iv = window.setInterval(sync, 500);
    const stop = window.setTimeout(() => window.clearInterval(iv), 3000);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(stop);
      window.clearInterval(iv);
      off();
    };
  }, []);

  /** 写入并即时生效(开关与快捷键保存共用);结果用 toast 反馈。 */
  const patch = useCallback(
    async (p: Partial<ScreenshotSettings>) => {
      const next = { ...getSettings(), ...p };
      setSettingsState(next);
      setSettings(next);
      const r = await applyShortcuts();
      if (r.ok) {
        onToast?.('ok', next.enabled ? '已保存,快捷键生效' : '已关闭截图 / 贴图');
      } else {
        onToast?.('err', r.error ?? '快捷键注册失败,可能被其他程序占用');
      }
    },
    [onToast],
  );

  return (
    <div className="settings-group shot-settings-group">
      <div className="settings-group-title">截图 / 贴图</div>

      <label className="toggle-setting">
        <span>
          <strong>启用截图 / 贴图</strong>
        </span>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void patch({ enabled: e.target.checked })}
        />
        <em />
      </label>

      <p className="settings-hint">
        启用后,可使用全局快捷键截图并把截图钉在桌面上。双击快捷键即可修改,点击
        ✓ 保存后生效。
      </p>

      {settings.enabled ? (
        <>
          <ShortcutField
            label="截图快捷键"
            value={settings.shotShortcut}
            conflictFor={(draft) => conflictFor({ ...settings, shotShortcut: draft }, 'shotShortcut')}
            onCommit={(v) => patch({ shotShortcut: v })}
            onToast={onToast}
          />
          <ShortcutField
            label="贴图快捷键"
            value={settings.pinShortcut}
            conflictFor={(draft) => conflictFor({ ...settings, pinShortcut: draft }, 'pinShortcut')}
            onCommit={(v) => patch({ pinShortcut: v })}
            onToast={onToast}
          />
          <ShortcutField
            label="退出快捷键"
            value={settings.exitShortcut}
            conflictFor={(draft) => conflictFor({ ...settings, exitShortcut: draft }, 'exitShortcut')}
            onCommit={(v) => patch({ exitShortcut: v })}
            onToast={onToast}
          />
        </>
      ) : null}
    </div>
  );
}

// 单独的修饰键(不作为组合主键)与录制逻辑已抽到 ../ShortcutField,本文件不再重复。
