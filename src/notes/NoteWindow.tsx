import { useCallback, useEffect, useRef, useState } from 'react'
import { availableMonitors, getCurrentWindow, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { Check, Palette, Pin, PinOff, X } from 'lucide-react'

import './notes.css'
import {
  addNoteItem,
  clearConvertedItems,
  MIN_BG_ALPHA,
  NOTE_COLORS,
  noteColorOf,
  removeNote,
  removeNoteItem,
  toggleNoteItem,
  updateNote,
  updateNoteItem,
  useNotes,
} from './store'
import { listenConvertResult, requestConvert } from './bridge'

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
  const positionedRef = useRef(false)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editInputRef = useRef<HTMLInputElement | null>(null)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 1800)
  }, [])

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
        const sf = await win.scaleFactor()
        await win.setSize(new LogicalSize(note.w, note.h))

        // 越界自愈:保存的坐标若已不在任何可用显示器内(拔显示器/改分辨率/DPI 变化),
        // 则重置到主屏居中 —— 否则便利签会「跑到屏幕外,用户以为丢了」。
        let x = note.x
        let y = note.y
        try {
          const monitors = await availableMonitors()
          const inRange = monitors.some((m) => {
            const ms = m.scaleFactor || 1
            const mx = m.position.x / ms
            const my = m.position.y / ms
            const mw = m.size.width / ms
            const mh = m.size.height / ms
            return x >= mx - note.w && x <= mx + mw && y >= my - note.h && y <= my + mh
          })
          if (!inRange && monitors.length > 0) {
            const primary = monitors[0]
            const ps = primary.scaleFactor || 1
            x = Math.round(primary.position.x / ps + primary.size.width / ps / 2 - note.w / 2)
            y = Math.round(primary.position.y / ps + primary.size.height / ps / 2 - note.h / 2)
            updateNote(note.id, { x, y })
          }
        } catch {
          /* 取显示器失败则不纠偏,按原坐标显示 */
        }

        await win.setPosition(new PhysicalPosition(Math.round(x * sf), Math.round(y * sf)))
        await win.setAlwaysOnTop(note.pinned)
        await win.show()
      } catch {
        /* 非 Tauri 环境忽略 */
      }
    })()
  }, [note])

  // ——— 删除(用完即撕):彻底删除数据 + 销毁窗口 ———
  const handleClose = useCallback(() => {
    if (!note) return
    removeNote(note.id)
    void invoke('notes_close_window', { noteId: note.id }).catch(() => {})
  }, [note])

  // ——— 拖动(仅标题栏) + 拖动结束保存位置 ———
  // startDragging 会进入原生移动循环,与文本选择冲突,故只挂在标题栏上。
  const onTitleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !note) return
    // 点控制按钮时不触发拖动。
    if ((e.target as HTMLElement).closest('.ns-btn')) return
    e.preventDefault()
    // 仅发起原生拖动;位置落盘交由下方 onMoved 兜底。
    // ⚠️ 切勿在 startDragging() 之后立刻 outerPosition():
    // 该 Promise resolve 时 OS 尚未回写最终坐标,读到的是拖动前的旧坐标,
    // 会把旧位置存盘 → 重启后便利签弹回原位(实测踩过)。
    void win.startDragging().catch(() => {})
  }

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
  // startDragging 后读 outerPosition 在部分 Tauri 版本会拿到旧坐标(见上),
  // 故改为监听 onMoved:窗口真正被 OS 移动后才触发,拿到的是最终坐标。
  // 拖动中每帧都会回调,用 150ms 防抖只在用户停手后落盘一次。
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
            updateNote(noteId, {
              x: Math.round(payload.x / sf),
              y: Math.round(payload.y / sf),
            })
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
          <button type="button" className="ns-btn ns-close" title="删除便利签" onClick={handleClose}>
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
                <span className="ns-item-ops">
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
                    <span className="ns-to-todo">→待办</span>
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
    </div>
  )
}

export default NoteWindow
