/**
 * 晾衣绳配置页(PRD v1.6 / 原型 cl-11)：一屏看完、无滚动条。
 *
 * 原 6 项：① 启用顶部晾衣绳 ② 开机自动显示 ③ 展开 / 收起 ④ 显示屏幕 ⑤ 清风动效 ⑥ 截图自动飞入。
 * ⑦ 拉杆样式：2026-11-13 用户确认三款拉杆皮肤全部保留、由用户自行选择，默认「素瓷·侘寂」，
 *    故配置页新增第 7 行。这是唯一一处皮肤入口，绳窗根节点 data-pulltab 由 settings 驱动。
 *
 * 铁律：
 * - **能力零删除**：其余能力(置顶、绳带位置、拉杆、配额、热区…)一个不少，只是不在此页。
 *   置顶唯一入口是 ＋ 菜单第 7 行(常驻不可隐藏)，配置页绝不镜像 → 不会出现两处开关打架(R85)。
 * - 不写 prefs.json、不升 SIDEBAR_SETTINGS_KEY v19；只读/写 `~/.ticktask/clothesline/settings.json`。
 * - 单屏时「显示屏幕」整行禁用(不隐藏)，指定屏拔掉回退主屏并提示(与 dock.ts 同款体验)。
 */
import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  clGetSettings,
  clSetEnabled,
  clUpdateSettings,
  clGetMonitors,
  clGetCardUsage,
  CL_CARDS_CHANGED,
  type ClotheslineSettings,
  type ClPulltabStyle,
  type MonitorInfo,
} from './bridge'
import { useAccount } from '../membership'
import './clothesline-settings.css'

type RowProps = {
  title: string
  sub?: string
  children: React.ReactNode
  disabled?: boolean
}

function Row({ title, sub, children, disabled }: RowProps) {
  return (
    <div className={`cl-set-row ${disabled ? 'is-disabled' : ''}`}>
      <div className="cl-set-copy">
        <span className="cl-set-title">{title}</span>
        {sub ? <span className="cl-set-sub">{sub}</span> : null}
      </div>
      <div className="cl-set-ctl">{children}</div>
    </div>
  )
}

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`cl-switch ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="cl-switch-knob" />
    </button>
  )
}

export function ClotheslineSettingsPage() {
  const [settings, setSettings] = useState<ClotheslineSettings | null>(null)
  const [monitors, setMonitors] = useState<MonitorInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [monitorFallback, setMonitorFallback] = useState(false)
  const [usage, setUsage] = useState(0)
  const { fullAccess } = useAccount()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [s, ms, used] = await Promise.all([
          clGetSettings(),
          clGetMonitors(),
          clGetCardUsage(),
        ])
        if (cancelled) return
        setSettings(s)
        setMonitors(ms)
        setUsage(used)
        // 上次记忆的屏已不在 → 标注「已回退主屏」提示(只提示,不改配置)。
        if (s.monitor_stable_id && ms.length > 0) {
          setMonitorFallback(!ms.some((m) => m.stable_id === s.monitor_stable_id))
        }
      } catch {
        /* 读失败保持空,不刷错误面板 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 卡片增删 / 排序 / 满额撕卡都会广播，状态条读数跟着变（只读，不镜像细项）。
  useEffect(() => {
    let cancelled = false
    let un: (() => void) | undefined
    void listen(CL_CARDS_CHANGED, () => {
      void clGetCardUsage()
        .then((n) => {
          if (!cancelled) setUsage(n)
        })
        .catch(() => undefined)
    })
      .then((fn) => {
        if (cancelled) fn()
        else un = fn
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      un?.()
    }
  }, [])

  const patch = useCallback(async (p: Partial<ClotheslineSettings>) => {
    if (busy) return
    setBusy(true)
    // 乐观更新：先改本地再写盘,开关零延迟。
    setSettings((prev) => (prev ? { ...prev, ...p } : prev))
    try {
      const next = await clUpdateSettings(p)
      setSettings(next)
      // 总开关单独走命令(要建窗 / 建循环),其余走 update_settings。
    } catch {
      /* 写失败回滚由下次读取纠正,此处静默 */
    } finally {
      setBusy(false)
    }
  }, [busy])

  // 滑杆专用：拖动时高频触发，不走 busy 闸门（否则第一次 patch 未返回前
  // 后续 onChange 全部被丢弃，滑杆拖一半就「卡住」）。Rust 侧串行执行天然排队。
  const patchLive = useCallback(async (p: Partial<ClotheslineSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...p } : prev))
    try {
      const next = await clUpdateSettings(p)
      setSettings(next)
    } catch {
      /* 静默 */
    }
  }, [])

  const setEnabled = useCallback(
    async (v: boolean) => {
      if (busy) return
      setBusy(true)
      setSettings((prev) => (prev ? { ...prev, enabled: v } : prev))
      try {
        await clSetEnabled(v)
        const s = await clGetSettings()
        setSettings(s)
      } catch {
        /* 静默 */
      } finally {
        setBusy(false)
      }
    },
    [busy],
  )

  // 选中的屏：命中记忆 ID → 它；否则主屏。
  const selectedMonitorId =
    monitors.find((m) => m.stable_id === settings?.monitor_stable_id)?.stable_id ??
    monitors.find((m) => m.is_primary)?.stable_id ??
    ''

  if (!settings) {
    return <div className="cl-set-body cl-set-loading">正在读取晾衣绳设置…</div>
  }

  const singleScreen = monitors.length <= 1
  return (
    <div className="cl-set-body">
      <div className="cl-set-group">
        <div className="cl-set-group-title">顶部晾衣绳</div>

        <Row title="启用顶部晾衣绳" sub="在屏幕顶部挂一条常驻绳，聚合桌面卡片">
          <Switch checked={settings.enabled} onChange={(v) => void setEnabled(v)} disabled={busy} />
        </Row>

        <Row
          title="开机自动显示"
          sub={settings.enabled ? '跟随 Tacco 启动时自动展开' : '需先启用顶部晾衣绳'}
        >
          <Switch
            checked={settings.auto_show_on_boot}
            onChange={(v) => void patch({ auto_show_on_boot: v })}
            disabled={busy || !settings.enabled}
          />
        </Row>

        <Row title="展开 / 收起晾衣绳" sub="收起后只保留一个木夹把手">
          <Switch
            checked={settings.expanded}
            onChange={(v) => void patch({ expanded: v })}
            disabled={busy}
          />
        </Row>

        <Row title="拉杆样式" sub="收起态拉绳把手的材质与配色，默认素瓷">
          <select
            className="cl-set-select"
            value={settings.pulltab_style ?? 'porcelain'}
            disabled={busy}
            onChange={(e) => void patch({ pulltab_style: e.target.value as ClPulltabStyle })}
          >
            <option value="porcelain">素瓷 · 侘寂（默认）</option>
            <option value="brass">黄铜 · 铃坠</option>
            <option value="glass">琉璃 · 露珠</option>
          </select>
        </Row>

        <Row
          title="显示屏幕"
          sub={
            singleScreen
              ? '仅检测到一块屏幕'
              : monitorFallback
                ? '上次记忆的屏幕已断开，当前显示在主屏'
                : '卡片绳将挂在这块屏幕上'
          }
          disabled={singleScreen || !settings.enabled}
        >
          <select
            className="cl-set-select"
            value={selectedMonitorId}
            disabled={singleScreen || !settings.enabled}
            onChange={(e) => void patch({ monitor_stable_id: e.target.value })}
          >
            {monitors.map((m, i) => (
              <option key={m.stable_id} value={m.stable_id}>
                {m.is_primary ? '主屏' : `屏幕 ${i + 1}`} · {m.width}×{m.height}
              </option>
            ))}
            {monitors.length === 0 ? <option value="">未检测到屏幕</option> : null}
          </select>
        </Row>

        <Row
          title="晾衣绳长度"
          sub="绳子横向长度占可用区的比例，影响单屏可挂卡片数量"
          disabled={!settings.enabled}
        >
          <div className="cl-set-range">
            <input
              type="range"
              min={30}
              max={100}
              step={1}
              value={Math.round((settings.rope_width_ratio ?? 0.86) * 100)}
              disabled={!settings.enabled}
              onChange={(e) => void patchLive({ rope_width_ratio: Number(e.target.value) / 100 })}
            />
            <span className="cl-set-range-val">
              {Math.round((settings.rope_width_ratio ?? 0.86) * 100)}%
            </span>
          </div>
        </Row>

        <Row
          title="卡片尺寸"
          sub="当前尺寸为最小，最大可放大一倍"
          disabled={!settings.enabled}
        >
          <div className="cl-set-range">
            <input
              type="range"
              min={100}
              max={200}
              step={5}
              value={Math.round((settings.card_size ?? 1) * 100)}
              disabled={!settings.enabled}
              onChange={(e) => void patchLive({ card_size: Number(e.target.value) / 100 })}
            />
            <span className="cl-set-range-val">
              {Math.round((settings.card_size ?? 1) * 100)}%
            </span>
          </div>
        </Row>

        <Row title="清风动效" sub="绳上卡片随风极淡摆动，鼠标悬停时暂停">
          <Switch
            checked={settings.wind_effect}
            onChange={(v) => void patch({ wind_effect: v })}
            disabled={busy}
          />
        </Row>

        <Row title="截图自动挂上晾衣绳" sub="截图复制后，截图会自动挂在晾衣绳上">
          <Switch
            checked={settings.auto_fly_shot}
            onChange={(v) => void patch({ auto_fly_shot: v })}
            disabled={busy}
          />
        </Row>
      </div>

      <div className="cl-set-status">
        <span className={`cl-set-dot ${settings.enabled ? 'is-on' : ''}`} />
        {settings.enabled ? '晾衣绳运行中' : '晾衣绳已关闭'}
        <span className="cl-set-status-sep">·</span>
        已挂 {usage}/{fullAccess ? 24 : 12} 张
        <span className="cl-set-status-sep">·</span>
        拖木夹可移动 · 卡片可拖动排序 · 置顶开关在「⋯ 更多」
      </div>

      <p className="cl-set-footnote">
        更多操作（置顶、拖绳换屏、木夹排序、卡片编辑、新建计时）可直接上手操作，不在此处重复设置。
      </p>
    </div>
  )
}
