// 通用快捷键录入字段(2026-10-23 抽出,供截图设置与窗口设置共用)。
//
// 交互逻辑(与截图快捷键文本框完全一致):
// - 非编辑态:置灰只读文本框,显示当前快捷键(键盘缩写),双击进入编辑;
// - 编辑态:窗口级捕获按键录制组合键,Esc = 取消编辑;右侧 ✓ 保存 / ✕ 取消,
//   点 ✓ 才把新值交给 onCommit 生效;
// - 编辑中即时冲突校验(通过 conflictFor 回调),点 ✓ 时再拦截一次。
// - 保存结果统一走 onToast(与设置页 toast 样式 / 位置 / 自动关闭一致)。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { VipBadge } from './VipBadge'

// 单独的修饰键(不作为组合主键)。
const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
])

/** Tauri 快捷键串 → 键盘缩写展示(CommandOrControl→Ctrl、Escape→Esc、方向键→箭头)。 */
export function displayShortcut(raw: string): string {
  const MAP: Record<string, string> = {
    commandorcontrol: 'Ctrl',
    cmdorctrl: 'Ctrl',
    control: 'Ctrl',
    ctrl: 'Ctrl',
    command: 'Win',
    cmd: 'Win',
    meta: 'Win',
    super: 'Win',
    alt: 'Alt',
    option: 'Alt',
    shift: 'Shift',
    escape: 'Esc',
    esc: 'Esc',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
  }
  return raw
    .split('+')
    .map((t) => MAP[t.trim().toLowerCase()] ?? t.trim())
    .join(' + ')
}

export function ShortcutField({
  label,
  value,
  onCommit,
  conflictFor,
  onToast,
  /** 会员专属锁定:非会员时文本框显示为空、双击触发 onLocked 而非进入编辑。 */
  locked = false,
  /** 锁定态双击回调(弹会员提示),由父组件传入。 */
  onLocked,
  /** 是否在标签右侧显示 VIP 角标。 */
  vip = false,
}: {
  label: string
  value: string
  /** 保存时调用,传入用户录制得到的快捷键串(已 trim)。 */
  onCommit: (v: string) => void | Promise<void>
  /** 返回冲突原因字符串,无冲突返回 null。编辑中即时调用,点 ✓ 再拦一次。 */
  conflictFor?: (draft: string) => string | null
  /** 保存结果提示(成功 / 失败)。 */
  onToast?: (kind: 'ok' | 'err', text: string) => void
  /** 会员专属锁定:非会员时文本框显示为空、双击触发 onLocked 而非进入编辑。 */
  locked?: boolean
  /** 锁定态双击回调(弹会员提示),由父组件传入。 */
  onLocked?: () => void
  /** 是否在标签右侧显示 VIP 角标。 */
  vip?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  // 录制中的实时预览(按下修饰键时逐步显示,如 "Ctrl+Shift+…")
  const [preview, setPreview] = useState<string[]>([])
  const previewRef = useRef<string[]>([])

  const startEdit = useCallback(() => {
    setDraft(value)
    setEditing(true)
  }, [value])

  const cancelEdit = useCallback(() => {
    setEditing(false)
    setPreview([])
    previewRef.current = []
  }, [])

  // 草稿的实时冲突校验(编辑中即时标红,点 ✓ 时再拦截一次)。
  const conflict = editing && conflictFor ? conflictFor(draft) : null

  const commit = useCallback(async () => {
    if (conflict) {
      onToast?.('err', conflict)
      return
    }
    const next = draft.trim()
    const changed = next !== value
    cancelEdit()
    if (changed) await onCommit(next)
  }, [conflict, draft, value, cancelEdit, onCommit, onToast])

  // 编辑态:窗口级捕获按键录制组合键(Esc = 取消编辑)。
  useEffect(() => {
    if (!editing) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        cancelEdit()
        return
      }
      const mods: string[] = []
      if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
      if (e.altKey) mods.push('Alt')
      if (e.shiftKey) mods.push('Shift')
      if (MODIFIER_KEYS.has(e.key)) {
        // 只按了修饰键:仅更新预览,等待主键
        previewRef.current = mods
        setPreview(mods)
        return
      }
      let key = e.key
      if (key === ' ') key = 'Space'
      else if (key === 'ArrowUp') key = 'Up'
      else if (key === 'ArrowDown') key = 'Down'
      else if (key === 'ArrowLeft') key = 'Left'
      else if (key === 'ArrowRight') key = 'Right'
      else if (key.length === 1) key = key.toUpperCase()
      setDraft([...mods, key].join('+'))
      previewRef.current = []
      setPreview([])
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [editing, cancelEdit])

  if (!editing) {
    return (
      <div className="shot-shortcut-row">
        <span className="shot-shortcut-label">
          {label}
          {vip ? <VipBadge /> : null}
        </span>
        <input
          type="text"
          className="shot-shortcut-text is-stored"
          value={locked ? '' : displayShortcut(value)}
          placeholder={locked ? '会员专属' : undefined}
          readOnly
          title={locked ? '会员专属功能,开通会员后可用' : '双击修改快捷键'}
          onDoubleClick={locked ? () => onLocked?.() : startEdit}
        />
      </div>
    )
  }

  const display =
    preview.length > 0 ? `${preview.join('+')}+…` : displayShortcut(draft) || '按下组合键'

  return (
    <div className="shot-shortcut-row">
      <span className="shot-shortcut-label">{label}</span>
      <span className={`shot-shortcut ${conflict ? 'is-conflict' : ''}`}>
        <span className="shot-shortcut-edit">
          <input
            type="text"
            className={`shot-shortcut-text ${conflict ? 'is-conflict' : ''}`}
            value={display}
            readOnly
            placeholder="按下组合键"
          />
          <button
            type="button"
            className="shot-edit-btn is-save"
            title="保存"
            onClick={() => void commit()}
          >
            <Check size={14} />
          </button>
          <button type="button" className="shot-edit-btn" title="取消" onClick={cancelEdit}>
            <X size={14} />
          </button>
        </span>
        {conflict ? <em className="shot-shortcut-err">{conflict}</em> : null}
      </span>
    </div>
  )
}
