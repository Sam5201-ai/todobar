import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LogicalPosition,
  LogicalSize,
  cursorPosition,
  getCurrentWindow,
  monitorFromPoint,
} from '@tauri-apps/api/window'
import { Copy, Pin, PinOff, Search, Trash2, X } from 'lucide-react'
import type { UnlistenFn } from '@tauri-apps/api/event'

import './ClipboardView.css'
import {
  clipboardClear,
  clipboardCopyBack,
  clipboardDelete,
  clipboardHideWindow,
  clipboardList,
  clipboardPin,
  clipboardSetPaused,
  onClipboardChanged,
  type ClipItem,
} from './clipboard'

const WIN_W = 468
const WIN_H = 600

const win = getCurrentWindow()

/** 读取主程序设置的明/暗主题,独立浮窗需自行套用(主界面样式不生效于此窗口)。 */
function readTheme(): 'light' | 'dark' {
  try {
    const raw = window.localStorage.getItem('todobar.sidebar.settings.v19')
    if (raw) {
      const s = JSON.parse(raw) as { theme?: string }
      if (s.theme === 'dark' || s.theme === 'light') return s.theme
    }
  } catch {
    /* ignore */
  }
  return 'light'
}

function relTime(tsMs: number): string {
  const diff = Date.now() - tsMs
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(tsMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 与 Rust clipboard_list 排序规则一致:置顶项最前(组内按置顶时刻倒序),未置顶按创建时刻倒序。 */
function sortItems(list: ClipItem[]): ClipItem[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.pinned && b.pinned) return (b.pinned_at ?? 0) - (a.pinned_at ?? 0)
    return (b.created_at ?? 0) - (a.created_at ?? 0)
  })
}

export function ClipboardView() {
  const [items, setItems] = useState<ClipItem[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [paused, setPaused] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [theme] = useState<'light' | 'dark'>(readTheme)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const positionedRef = useRef(false)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 1800)
  }, [])

  const reload = useCallback(() => {
    void clipboardList().then((list) => setItems(list))
  }, [])

  // 居中到光标所在显示器(用该显示器 scaleFactor 把物理坐标换算成逻辑坐标)。
  const reposition = useCallback(async () => {
    try {
      const pos = await cursorPosition()
      const mon = await monitorFromPoint(pos.x, pos.y)
      const sf = mon?.scaleFactor ?? (await win.scaleFactor())
      const cx = ((mon ? mon.position.x + mon.size.width / 2 : pos.x) ) / sf
      const cy = ((mon ? mon.position.y + mon.size.height / 2 : pos.y) ) / sf
      const x = Math.round(cx - WIN_W / 2)
      const y = Math.round(cy - WIN_H / 2)
      await win.setPosition(new LogicalPosition(x, y))
    } catch {
      /* 取显示器失败则保留默认位置 */
    }
  }, [])

  // ——— 首次定位 + 显示 ———
  useEffect(() => {
    if (positionedRef.current) return
    positionedRef.current = true
    void (async () => {
      try {
        await win.setSize(new LogicalSize(WIN_W, WIN_H))
        await reposition()
        await win.setAlwaysOnTop(true)
        await win.show()
        await win.setFocus()
        inputRef.current?.focus() // 进入命令面板式操作
      } catch {
        /* 非 Tauri 环境忽略 */
      }
    })()
  }, [reposition])

  // ——— 加载 + 监听变更 + 失焦收起/重聚重定位 ———
  useEffect(() => {
    reload()
    let un: UnlistenFn | undefined
    void onClipboardChanged(reload).then((fn) => (un = fn))
    return () => un?.()
  }, [reload])

  useEffect(() => {
    let un: UnlistenFn | undefined
    void win
      .onFocusChanged(({ payload: focused }) => {
        // 点到别处自动收起(读完了,没必要占屏);
        // 重新获得焦点(快捷键二次唤起)则按新光标位置重新居中。
        if (!focused) void clipboardHideWindow()
        else void reposition()
      })
      .then((fn) => (un = fn))
    return () => un?.()
  }, [reposition])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (it) => it.text.toLowerCase().includes(q) || (it.preview?.toLowerCase().includes(q) ?? false),
    )
  }, [items, query])

  // 选中项随过滤结果夹取。
  useEffect(() => {
    setSelected((s) => Math.min(Math.max(s, 0), Math.max(filtered.length - 1, 0)))
  }, [filtered.length])

  // 选中项滚入可视区。
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selected}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const doCopy = useCallback(
    async (item: ClipItem) => {
      const pasted = await clipboardCopyBack(item.id)
      flash(pasted ? '已粘贴到上一个窗口' : '已复制，去粘贴吧')
      // 复制后停留约 700ms 让提示可见,再收起(自动粘贴时 Rust 已先收起,此处 no-op)。
      window.setTimeout(() => void clipboardHideWindow(), 700)
    },
    [flash],
  )

  const doDelete = useCallback(async (item: ClipItem) => {
    await clipboardDelete(item.id)
    setItems((cur) => cur.filter((i) => i.id !== item.id))
  }, [])

  const doPin = useCallback(async (item: ClipItem) => {
    const next = !item.pinned
    await clipboardPin(item.id, next)
    setItems((cur) =>
      sortItems(
        cur.map((i) => (i.id === item.id ? { ...i, pinned: next, pinned_at: next ? Date.now() : 0 } : i)),
      ),
    )
  }, [])

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      const list = filtered
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((s) => Math.min(s + 1, list.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((s) => Math.max(s - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = list[selected]
        if (item) void doCopy(item)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (query) setQuery('')
        else void clipboardHideWindow()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
      } else if (e.key === 'Delete') {
        e.preventDefault()
        const item = list[selected]
        if (item) void doDelete(item)
      } else if (/^[1-9]$/.test(e.key) && !query) {
        // 数字键快选前 9 条
        const idx = Number(e.key) - 1
        if (idx < list.length) {
          e.preventDefault()
          void doCopy(list[idx])
        }
      }
    },
    [filtered, selected, query, doCopy, doDelete],
  )

  return (
    <div className={`cb-root theme-${theme}`} onKeyDown={onKey}>
      <div className="cb-card">
        <div className="cb-search">
          <Search size={15} className="cb-search-icon" />
        <input
          ref={inputRef}
          className="cb-input"
          value={query}
          placeholder="搜索剪贴板…  ↑↓ 选择 · Enter 复制 · 1-9 快选 · Esc 收起"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="cb-hint">单击任意一条文案即可复制 · 悬停显示 复制 / 置顶 / 删除</div>

      <div className="cb-list" ref={listRef}>
        {filtered.length === 0 ? (
          <div className="cb-empty">还没有记录。复制点什么试试 —— 最多保留 50 条纯文本。</div>
        ) : (
          filtered.map((it, idx) => (
            <div
              key={it.id}
              data-idx={idx}
              className={`cb-item ${idx === selected ? 'is-selected' : ''} ${it.pinned ? 'is-pinned' : ''}`}
              onMouseEnter={() => setSelected(idx)}
              onClick={() => void doCopy(it)}
            >
              <div className="cb-item-text">{it.preview || it.text}</div>
              <div className="cb-item-meta">
                {it.pinned ? <span className="cb-tag cb-tag-pin">置顶</span> : null}
                {it.source ? <span className="cb-tag">{it.source.replace(/\.exe$/i, '')}</span> : null}
                <span className="cb-time">{relTime(it.created_at)}</span>
                <span className="cb-len">{it.len} 字</span>
              </div>
              <div className="cb-item-ops">
                <button
                  type="button"
                  className="cb-op cb-op-copy"
                  title="复制"
                  onClick={(e) => {
                    e.stopPropagation()
                    void doCopy(it)
                  }}
                >
                  <Copy size={13} />
                </button>
                <button
                  type="button"
                  className="cb-op"
                  title={it.pinned ? '取消置顶' : '置顶'}
                  onClick={(e) => {
                    e.stopPropagation()
                    void doPin(it)
                  }}
                >
                  {it.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                </button>
                <button
                  type="button"
                  className="cb-op cb-op-del"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation()
                    void doDelete(it)
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="cb-footer">
        <button
          type="button"
          className={`cb-foot-btn ${paused ? 'is-on' : ''}`}
          onClick={() => {
            const next = !paused
            setPaused(next)
            void clipboardSetPaused(next)
          }}
        >
          {paused ? '已暂停记录' : '记录中'}
        </button>
        <span className="cb-count">共 {items.length} 条</span>
        <button
          type="button"
          className="cb-foot-btn cb-foot-danger"
          onClick={() => {
            void clipboardClear()
            setItems([])
            flash('已清空')
          }}
        >
          清空全部
        </button>
        <button
          type="button"
          className="cb-foot-btn"
          title="收起"
          onClick={() => void clipboardHideWindow()}
        >
          <X size={13} />
        </button>
      </div>

      {toast ? <div className="cb-toast">{toast}</div> : null}
      </div>
    </div>
  )
}

export default ClipboardView
