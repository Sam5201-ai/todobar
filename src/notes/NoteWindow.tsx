import { useCallback, useEffect, useRef, useState } from 'react'
import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { Check, Copy, ListTodo, Palette, Pin, PinOff, Shirt, X } from 'lucide-react'

import './notes.css'
import {
  addNoteItem,
  clearConvertedItems,
  getNoteSync,
  MIN_BG_ALPHA,
  NOTE_COLORS,
  noteColorOf,
  removeNoteItem,
  toggleNoteItem,
  updateNote,
  updateNoteItem,
  useNotes,
} from './store'
import { listenConvertResult, requestConvert } from './bridge'
import { copyText } from '../clipboard'
import { clAddCard, clGetRestoreState, clMakeCard, CL_ARCHIVE_CARD, CL_DROP_NOTE_WINDOW, CL_NOTE_HUNG, type ClArchiveCard } from '../clothesline/bridge'
import { isFullAccess, loadAccount } from '../account'

const win = getCurrentWindow()
const NOTE_ID = win.label.replace(/^note-/, '')

export function NoteWindow() {
  const notes = useNotes()
  const note = notes.find((n) => n.id === NOTE_ID) ?? null

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [newText, setNewText] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [styleOpen, setStyleOpen] = useState(false)
  /** × 确认条：关闭便利签时让用户选「归档 / 删除」（2026-11-18 归档功能）。 */
  const [confirmClose, setConfirmClose] = useState(false)
  const positionedRef = useRef(false)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editInputRef = useRef<HTMLInputElement | null>(null)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 1800)
  }, [])

  /** 挂到晾衣绳。便利签窗口只写 clothesline/cards.json；写回仍归主窗 notes/store.ts。 */
  const hangOnRope = useCallback(
    async (itemId?: string) => {
      if (!note) return
      const item = itemId ? note.items.find((it) => it.id === itemId) : null
      try {
        await clAddCard(
          clMakeCard('note', {
            note_id: note.id,
            attach_to: itemId ? `item:${itemId}` : null,
            title: item ? '便利签 · 单条' : '便利签',
            text: item?.text ?? (note.items.length
              ? note.items.map((it) => `${it.done ? '✓ ' : '· '}${it.text}`).join('\n')
              : '（空便利签）'),
          }),
          isFullAccess(loadAccount()),
        )
        // 问题1：整张挂绳成功后桌面便利签自动消失，避免桌面 + 绳上同时存在两张。
        // 只发事件给主窗统一收起（数据保留），便利签窗口不自己改 notes 数据。
        // 「单条挂绳」只挂一条、桌面便利签仍要继续用，故不隐藏。
        if (!itemId) void emit(CL_NOTE_HUNG, { noteId: note.id }).catch(() => {})
        flash('已挂到晾衣绳')
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e))
      }
    },
    [note, flash],
  )

  // ——— 样式面板:点击面板外关闭(mousedown 判定,不做 preventDefault) ———
  useEffect(() => {
    if (!styleOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest('.ns-popover')) return
      if (t.closest('[data-style-toggle]')) return // 再点一次切换按钮交给 onClick 收起
      setStyleOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [styleOpen])

  // ——— 首次定位 + 显示 ———
  // 窗口在 Rust 侧以 visible(false) 创建,这里读取保存的位置后自行 show(),
  // 避免在 Windows 默认级联位置闪现未定位的窗口(0.4.44 经验)。
  useEffect(() => {
    if (!note || positionedRef.current) return
    positionedRef.current = true
    void (async () => {
      try {
        // 坐标一律按该签记录的 scaleFactor 换算成物理像素;旧数据没有该字段时
        // 用窗口当前屏缩放推断,保持原有恢复行为(尊重用户手动拖到别的屏)。
        const sf = note.scaleFactor ?? (await win.scaleFactor())
        const wPhys = Math.round(note.w * sf)
        const hPhys = Math.round(note.h * sf)
        await win.setSize(new PhysicalSize(wPhys, hPhys))
        let px = note.x * sf
        let py = note.y * sf

        // 越界自愈:全物理坐标比对。旧实现把显示器 position 除以该屏缩放,
        // 混合 DPI 下会误判,把明明在副屏上的便利签「自愈」回主屏。
        try {
          const monitors = await availableMonitors()
          const inRange = monitors.some((m) => {
            const wa = m.workArea ?? { position: m.position, size: m.size }
            return (
              px >= wa.position.x - wPhys &&
              px <= wa.position.x + wa.size.width &&
              py >= wa.position.y - hPhys &&
              py <= wa.position.y + wa.size.height
            )
          })
          if (!inRange && monitors.length > 0) {
            const primary = monitors[0]
            const pwa = primary.workArea ?? { position: primary.position, size: primary.size }
            const psf = primary.scaleFactor || 1
            px = pwa.position.x + pwa.size.width / 2 - wPhys / 2
            py = pwa.position.y + pwa.size.height / 2 - hPhys / 2
            updateNote(note.id, {
              x: Math.round(px / psf),
              y: Math.round(py / psf),
              scaleFactor: psf,
            })
          }
        } catch {
          /* 取显示器失败则不纠偏,按原坐标显示 */
        }

        await win.setPosition(new PhysicalPosition(Math.round(px), Math.round(py)))
        await win.setAlwaysOnTop(note.pinned)
        await win.show()
      } catch {
        /* 非 Tauri 环境忽略 */
      }
    })()
  }, [note])

  // ——— 关闭窗口:× 弹「归档 / 删除」确认条(2026-11-18 归档功能)。
  //      归档/删除的落盘都由主窗 notes/store.ts 单一写方编排(本窗只 emit 事件);
  //      挂绳自动收起路径(CL_NOTE_HUNG → collapsed:true)不受影响。 ———
  const handleClose = useCallback(() => {
    setConfirmClose(true)
  }, [])

  const doCloseWindow = useCallback(() => {
    if (!note) return
    void invoke('notes_close_window', { noteId: note.id }).catch(() => {})
  }, [note])

  /** 归档:主窗 archiveNote + 关联绳卡同步归档(一体归档),然后关窗。 */
  const doArchiveClose = useCallback(() => {
    if (!note) return
    setConfirmClose(false)
    void emit(CL_ARCHIVE_CARD, { action: 'archive', noteId: note.id } satisfies ClArchiveCard).catch(() => {})
    doCloseWindow()
  }, [note, doCloseWindow])

  /** 删除:永久移除(主窗 removeNote + 清理关联绳卡),无撤销,然后关窗。 */
  const doDeleteClose = useCallback(() => {
    if (!note) return
    setConfirmClose(false)
    void emit(CL_ARCHIVE_CARD, { action: 'delete-note', noteId: note.id } satisfies ClArchiveCard).catch(() => {})
    doCloseWindow()
  }, [note, doCloseWindow])

  // ——— 标题栏拖动 + 磁力吸附挂绳 ———
  // 改用「自主拖拽」而非原生 startDragging：原生拖动进入 OS 移动循环后 WebView 拿不到
  // 实时坐标,无法做「靠近绳线自动吸附」的磁铁效果。自主拖拽用屏幕绝对坐标(e.screenX/Y)
  // 驱动 setPosition,既保留标题栏拖动手感,又能在便利签上边框靠近绳线时把它吸到绳上。
  // 关键修正:挂绳判定从「顶部长达 360px 的整片区域」收敛为「上边框贴住绳线那一刻」,
  // 因此小幅度移动、左右移动、向下移动都不会误挂。
  const MAGNET_APPROACH = 30 // 绳线下方的磁吸触发带(物理 px):进入即把上边框吸到绳线
  const MAGNET_UP_TOL = 8 // 绳线上方 8px 内也吸(允许略微越过绳线)

  const dragRef = useRef<{
    noteId: string
    startScreenX: number
    startScreenY: number
    startOuterX: number
    startOuterY: number
    sf: number
    ropeY: number | null
    snapped: boolean
    lastX: number
    lastY: number
    raf: number | null
  } | null>(null)

  /** 绳线在屏幕上的物理 Y(便利签上边框对齐目标)。
   *  绳窗恒为目标显示器整屏,绳线 = 显示器顶(mon.y,物理) + 面板 Y(逻辑)× 缩放。
   *  展开态面板 Y = clamp 后的 anchor_y;收起态贴顶 = 0。未启用 / 取不到则返回 null。 */
  const computeRopeY = useCallback(async (): Promise<number | null> => {
    try {
      const st = await clGetRestoreState()
      if (!st.settings.enabled) return null
      const mon =
        st.monitors.find((m) => m.stable_id === st.target_monitor_stable_id) ??
        st.monitors.find((m) => m.is_primary) ??
        st.monitors[0]
      if (!mon) return null
      const sf = mon.scale_factor || 1
      const panelY = st.settings.expanded ? st.session.anchor_y : 0
      return Math.round(mon.y + panelY * sf)
    } catch {
      return null
    }
  }, [])

  // 拖动中:屏幕绝对坐标差 → 物理位移;进入磁吸带则把上边框对齐绳线。
  const onDragMove = useCallback((ev: MouseEvent) => {
    const d = dragRef.current
    if (!d) return
    const nx = d.startOuterX + (ev.screenX - d.startScreenX) * d.sf
    let ny = d.startOuterY + (ev.screenY - d.startScreenY) * d.sf
    d.snapped = false
    if (d.ropeY != null && ny >= d.ropeY - MAGNET_UP_TOL && ny <= d.ropeY + MAGNET_APPROACH) {
      ny = d.ropeY // 磁吸:上边框对齐绳线
      d.snapped = true
    }
    d.lastX = nx
    d.lastY = ny
    // rAF 合并:每帧至多一次 setPosition,避免鼠标高频事件刷爆 IPC。
    if (d.raf == null) {
      d.raf = window.requestAnimationFrame(() => {
        const dd = dragRef.current
        if (!dd) return
        dd.raf = null
        void win
          .setPosition(new PhysicalPosition(Math.round(dd.lastX), Math.round(dd.lastY)))
          .catch(() => {})
      })
    }
  }, [])

  const onDragUp = useCallback(async () => {
    const d = dragRef.current
    if (!d) return
    document.removeEventListener('mousemove', onDragMove)
    document.removeEventListener('mouseup', onDragUp)
    document.body.style.userSelect = ''
    if (d.raf != null) {
      window.cancelAnimationFrame(d.raf)
      d.raf = null
    }
    const snapped = d.snapped
    dragRef.current = null
    // 落盘最终位置(与 onMoved 防抖写盘互补,确保松手即保存)。
    try {
      await win.setPosition(new PhysicalPosition(Math.round(d.lastX), Math.round(d.lastY)))
    } catch {
      /* ignore */
    }
    const pos = await win.outerPosition().catch(() => null)
    if (pos) {
      const sf = d.sf || 1
      updateNote(d.noteId, {
        x: Math.round(pos.x / sf),
        y: Math.round(pos.y / sf),
        scaleFactor: sf,
      })
    }
    // 只有被磁吸到绳线(上边框贴绳)才挂绳;其余位置正常留在桌面。
    if (snapped) {
      const n = getNoteSync(d.noteId)
      const text = (n?.items ?? []).map((it) => it.text).join(' · ').slice(0, 120)
      void emit(CL_DROP_NOTE_WINDOW, { noteId: d.noteId, text }).catch(() => {})
      flash('已挂到晾衣绳')
    }
  }, [onDragMove, flash])

  const onTitleMouseDown = useCallback(
    async (e: React.MouseEvent) => {
      if (e.button !== 0 || !note) return
      // 点控制按钮时不触发拖动。
      if ((e.target as HTMLElement).closest('.ns-btn')) return
      e.preventDefault()
      let outer: { x: number; y: number }
      let sf: number
      try {
        outer = await win.outerPosition()
        sf = await win.scaleFactor()
      } catch {
        return
      }
      const ropeY = await computeRopeY()
      dragRef.current = {
        noteId: note.id,
        startScreenX: e.screenX,
        startScreenY: e.screenY,
        startOuterX: outer.x,
        startOuterY: outer.y,
        sf,
        ropeY,
        snapped: false,
        lastX: outer.x,
        lastY: outer.y,
        raf: null,
      }
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onDragMove)
      document.addEventListener('mouseup', onDragUp)
    },
    [note, computeRopeY, onDragMove, onDragUp, flash],
  )

  // ——— 条目 ———
  const submitNew = () => {
    if (!newText.trim() || !note) return
    const ok = addNoteItem(note.id, newText)
    if (!ok) {
      flash('单条上限 200 条,或内容为空')
      return
    }
    setNewText('') // 连续快记:不清空焦点
  }

  // 0.4.23 铁律:mousedown 会让焦点被夺回 → 输入框闪现即消失。
  // 必须 preventDefault + setTimeout(0) 转移焦点。
  const startEdit = (itemId: string, text: string, e: React.MouseEvent) => {
    e.preventDefault()
    setEditingId(itemId)
    setEditingText(text)
    window.setTimeout(() => editInputRef.current?.focus(), 0)
  }

  const commitEdit = () => {
    if (!note || !editingId) return
    const t = editingText.trim()
    if (!t) {
      removeNoteItem(note.id, editingId)
    } else {
      updateNoteItem(note.id, editingId, { text: t })
    }
    setEditingId(null)
    setEditingText('')
  }

  const handleConvert = (noteId: string, itemId: string, text: string) => {
    // 由主窗口执行真正的 addTask(保留会员闸门/配额/reload/同步),这里等回执。
    void requestConvert({ noteId, itemId, text }).catch(() => flash('转待办失败'))
  }

  // 复制单条内容到系统剪贴板(走 copyText 统一通道,带 self-write 标记不污染剪贴板历史)。
  const handleCopy = (text: string) => {
    if (!text.trim()) return
    void copyText(text)
      .then(() => flash('已复制'))
      .catch(() => flash('复制失败'))
  }

  // 监听转换回执(emit 是全局广播,故按 noteId 过滤)。
  useEffect(() => {
    let disposed = false
    let un: (() => void) | undefined
    void listenConvertResult((res) => {
      if (disposed || res.noteId !== NOTE_ID) return
      if (res.ok) {
        updateNoteItem(res.noteId, res.itemId, { converted: true })
        flash('已转为待办')
      } else {
        flash(res.reason || '转待办失败')
      }
    }).then((fn) => {
      if (disposed) fn()
      else un = fn
    })
    return () => {
      disposed = true
      un?.()
    }
  }, [flash])

  // —— 尺寸记忆 ——
  // payload 是**物理像素**,必须按 DPI 换算回逻辑像素(否则多屏 DPI≠100% 时尺寸失真)。
  // 且 resize 过程中会每帧回调,不能直接落盘(每次都会写 localStorage + 磁盘),
  // 故用 300ms 防抖,只在用户停手后保存一次。
  useEffect(() => {
    let disposed = false
    let un: (() => void) | undefined
    void win
      .onResized(({ payload }) => {
        if (disposed || !note) return
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = setTimeout(() => {
          void win.scaleFactor().then((sf) => {
            updateNote(note.id, {
              w: Math.round(payload.width / sf),
              h: Math.round(payload.height / sf),
              scaleFactor: sf,
            })
          })
        }, 300)
      })
      .then((fn) => {
        if (disposed) fn()
        else un = fn
      })
    return () => {
      disposed = true
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      un?.()
    }
  }, [note])

  // ——— 拖动位置落盘:onMoved 兜底 ———
  // 自主拖拽(鼠标 → setPosition)每次移动都触发 onMoved,这里用 150ms 防抖只在停手后落盘一次。
  // payload 为物理像素,按 DPI 换算回逻辑像素(与首次显示时 ×sf 互逆)。
  useEffect(() => {
    if (!note) return
    const noteId = note.id
    let disposed = false
    let un: (() => void) | undefined
    let moveTimer: ReturnType<typeof setTimeout> | null = null
    void win
      .onMoved(({ payload }) => {
        if (disposed) return
        if (moveTimer) clearTimeout(moveTimer)
        moveTimer = setTimeout(() => {
          void win.scaleFactor().then((sf) => {
            const logicalY = Math.round(payload.y / sf)
            updateNote(noteId, {
              x: Math.round(payload.x / sf),
              y: logicalY,
              // 手动拖到别的屏后,把坐标系切换到该屏缩放 —— 下次恢复仍原位,
              // 不会被「新建跟随目标屏」强行拉回(用户决策 3)。
              scaleFactor: sf,
            })
            // 挂绳判定已移到 onTitleMouseDown 的自主拖拽:只有便利签上边框被磁吸贴到绳线才挂绳。
          })
        }, 150)
      })
      .then((fn) => {
        if (disposed) fn()
        else un = fn
      })
    return () => {
      disposed = true
      if (moveTimer) clearTimeout(moveTimer)
      un?.()
    }
  }, [note?.id])

  if (!note) {
    return (
      <div className="ns-root ns-empty">
        <div className="ns-empty-text">便利签已删除</div>
        <button type="button" className="ns-btn" onClick={() => void win.close()}>
          关闭
        </button>
      </div>
    )
  }

  const color = noteColorOf(note.colorKey)
  const bg = `rgba(${color.bg}, ${note.bgAlpha})`

  return (
    <div className="ns-root" style={{ background: bg, color: color.fg }}>
      {/* 标题栏:拖动区 + 控制按钮 */}
      <div className="ns-titlebar" onMouseDown={onTitleMouseDown}>
        <span className="ns-grip" aria-hidden="true" />
        <div className="ns-tools">
          <button
            type="button"
            className="ns-btn"
            title="整张挂到晾衣绳"
            onClick={() => void hangOnRope()}
          >
            <Shirt size={13} />
          </button>
          <button
            type="button"
            className={`ns-btn ${styleOpen ? 'is-on' : ''}`}
            data-style-toggle
            title="颜色与透明度"
            onClick={() => setStyleOpen((v) => !v)}
          >
            <Palette size={13} />
          </button>
          <button
            type="button"
            className={`ns-btn ${note.pinned ? 'is-on' : ''}`}
            title={note.pinned ? '取消置顶' : '始终置顶'}
            onClick={() => {
              const pinned = !note.pinned
              updateNote(note.id, { pinned })
              void invoke('notes_set_pinned', { noteId: note.id, pinned }).catch(() => {})
            }}
          >
            {note.pinned ? <Pin size={13} /> : <PinOff size={13} />}
          </button>
          <button type="button" className="ns-btn ns-close" title="关闭便利签" onClick={handleClose}>
            <X size={13} />
          </button>
        </div>
      </div>

      {/* 颜色与透明度面板:挂在 ns-root 下(绝不放进 titlebar,否则滑条会被拖动劫持) */}
      {styleOpen ? (
        <div className="ns-popover" onMouseDown={(e) => e.stopPropagation()}>
          <div className="ns-swatches">
            {NOTE_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`ns-swatch ${c.key === note.colorKey ? 'is-on' : ''}`}
                style={{ background: `rgb(${c.bg})` }}
                title={c.label}
                onClick={() => updateNote(note.id, { colorKey: c.key })}
              />
            ))}
          </div>
          <div className="ns-alpha-row">
            <span className="ns-alpha-label">不透明</span>
            <input
              type="range"
              className="ns-alpha"
              min={Math.round(MIN_BG_ALPHA * 100)}
              max={100}
              step={1}
              value={Math.round(note.bgAlpha * 100)}
              title={`背景不透明度 ${Math.round(note.bgAlpha * 100)}%`}
              onChange={(e) => updateNote(note.id, { bgAlpha: Number(e.target.value) / 100 })}
            />
            <span className="ns-alpha-val">{Math.round(note.bgAlpha * 100)}%</span>
          </div>
        </div>
      ) : null}

      {/* 条目列表 */}
      <div className="ns-body">
        {note.items.length === 0 ? (
          <div className="ns-placeholder">在下方输入,回车快速添加</div>
        ) : (
          <ol className="ns-list">
            {note.items.map((it, idx) => (
              <li key={it.id} className={`ns-item ${it.converted ? 'is-converted' : ''}`}>
                <span className="ns-num">{idx + 1}.</span>
                {editingId === it.id ? (
                  <input
                    ref={editInputRef}
                    className="ns-edit-input"
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit()
                      else if (e.key === 'Escape') {
                        setEditingId(null)
                        setEditingText('')
                      }
                      // 阻止冒泡到窗口级快捷键
                      e.stopPropagation()
                    }}
                  />
                ) : (
                  <span
                    className={`ns-text ${it.done ? 'is-done' : ''}`}
                    title="双击编辑"
                    onMouseDown={(e) => startEdit(it.id, it.text, e)}
                  >
                    {it.text}
                  </span>
                )}
                {editingId !== it.id ? (
                <span className="ns-item-ops">
                  <button
                    type="button"
                    className="ns-btn"
                    title="复制内容"
                    onClick={() => handleCopy(it.text)}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    type="button"
                    className="ns-btn"
                    title="单条挂到晾衣绳"
                    onClick={() => void hangOnRope(it.id)}
                  >
                    <Shirt size={12} />
                  </button>
                  <button
                    type="button"
                    className={`ns-btn ns-check ${it.done ? 'is-on' : ''}`}
                    title="标记完成"
                    onClick={() => toggleNoteItem(note.id, it.id)}
                  >
                    <Check size={12} />
                  </button>
                  <button
                    type="button"
                    className="ns-btn"
                    title="转为待办"
                    disabled={it.converted}
                    onClick={() => handleConvert(note.id, it.id, it.text)}
                  >
                    {/* ★2026-11-19：文字「→待办」改为 SVG 图标，与绳窗便利签卡的
                        「转为待办」图标一致（lucide ListTodo）。 */}
                    <ListTodo size={12} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="ns-btn ns-del"
                    title="删除"
                    onClick={() => removeNoteItem(note.id, it.id)}
                  >
                    ×
                  </button>
                </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* 连续快记输入框 */}
      <div className="ns-composer">
        <input
          className="ns-input"
          value={newText}
          placeholder="添加一条…"
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitNew()
            }
          }}
        />
        {note.items.some((i) => i.converted) ? (
          <button
            type="button"
            className="ns-cleanup"
            onClick={() => {
              const n = clearConvertedItems(note.id)
              if (n > 0) flash(`已清理 ${n} 条`)
            }}
          >
            清理已转
          </button>
        ) : null}
      </div>

      {toast ? <div className="ns-toast">{toast}</div> : null}

      {/* × 确认条:归档 / 删除 两选(2026-11-18 归档功能) */}
      {confirmClose ? (
        <div className="ns-confirm" onMouseDown={(e) => e.stopPropagation()}>
          <div className="ns-confirm-card">
            <div className="ns-confirm-title">关闭便利签</div>
            <div className="ns-confirm-text">归档保留内容，可稍后恢复；删除将永久移除。</div>
            <div className="ns-confirm-actions">
              <button type="button" className="ns-confirm-btn is-primary" onClick={doArchiveClose}>
                归档
              </button>
              <button type="button" className="ns-confirm-btn is-danger" onClick={doDeleteClose}>
                删除
              </button>
              <button type="button" className="ns-confirm-btn" onClick={() => setConfirmClose(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default NoteWindow
