/**
 * 全局速记（随手记）独立桌面录入窗（label = quick-note，Rust 动态建窗，见 quick_note.rs）。
 *
 * - 标题「新建随手记」；标题（可空）+ 正文 + 分类（选/新建）。
 * - 双保存按钮：「挂到晾衣绳」（受会员配额）/「保存归档」（不占绳位）。
 * - 归档按钮走同窗 CSS 飞出动画，动画结束再落库（照确认的方案 A）。
 * - 分类表存 localStorage，与其他 WebView 同源共享。
 * - 必须打 data-runtime='tauri'（main.tsx 已打）；跳过 hydrateIdentity。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { LogicalSize, getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalPosition, cursorPosition, monitorFromPoint } from '@tauri-apps/api/window'
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { isFullAccess, loadAccount } from '../account'
import { clAddArchivedCard, clAddCard, clMakeCard, clUpdateCard, CL_ARCHIVE_LANDED } from '../clothesline/bridge'
import { hideQuickNoteWindow } from './shortcuts'
import { addCategory, loadCategories, loadLastCategory, removeCategory, saveLastCategory } from './categories'
import { RICH_PREFIX, hasRichMarkup, isRichText, sanitizeRichHtml } from '../utils/richtext'
import { I18nProvider, t } from '../i18n'
import './quick-note.css'

const FLY_MS = 460
const WIN_W = 460
const WIN_H = 360
/** 归档飞出终点：速记窗是独立小窗，只能在窗内飞向工具窗所在侧（左/右）的边缘。 */
function readDockSide(): 'left' | 'right' {
  try {
    const raw = window.localStorage.getItem('todobar.sidebar.settings.v19')
    return raw && (JSON.parse(raw) as { dockSide?: unknown }).dockSide === 'left' ? 'left' : 'right'
  } catch {
    return 'right'
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 桌面居中到光标所在显示器（物理坐标口径，照 ClipboardView）。 */
async function reposition(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  // macOS：前端 cursorPosition 与 tao PhysicalPosition 口径不一致（项目红线），
  // 建档时 Rust 已居中；后续唤起仅 show，不再用前端坐标重定位。
  if (/Macintosh|Mac OS X/i.test(navigator.userAgent || '')) return
  try {
    const pos = await cursorPosition()
    const mon = await monitorFromPoint(pos.x, pos.y)
    const sf = mon?.scaleFactor ?? (await win.scaleFactor())
    const w = WIN_W * sf
    const h = WIN_H * sf
    const left = mon ? mon.position.x : pos.x - w / 2
    const top = mon ? mon.position.y : pos.y - h / 2
    const width = mon ? mon.size.width : w
    const height = mon ? mon.size.height : h
    const x = clamp(left + (width - w) / 2, left, left + width - w)
    const y = clamp(top + (height - h) / 2, top, top + height - h)
    await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
  } catch {
    /* 取显示器失败保留默认位置 */
  }
}

function QuickNoteApp() {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [cats, setCats] = useState<string[]>(loadCategories)
  const [category, setCategory] = useState('')
  const [newCat, setNewCat] = useState('')
  const [addingCat, setAddingCat] = useState(false)
  const [err, setErr] = useState('')
  const [flying, setFlying] = useState(false)
  const [entering, setEntering] = useState(false)
  const [flyX, setFlyX] = useState(WIN_W) // 归档飞出终点（按 dockSide 定向）
  // ★2026-11-24 编辑模式：归档页点「编辑」→ quick_note_open_for_edit 唤起本窗，
  // 填入整卡内容；保存走 clUpdateCard 增量更新原卡（不新增、不占配额）。
  const [editMode, setEditMode] = useState(false)
  const editIdRef = useRef<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const enterRafRef = useRef<number | null>(null)
  const disposedRef = useRef(false)

  /** 清掉入场动画态（保存飞出 / 窗口收起 / 下次唤起前都调用）。 */
  const stopEnter = useCallback(() => {
    if (enterRafRef.current != null) {
      window.cancelAnimationFrame(enterRafRef.current)
      enterRafRef.current = null
    }
    setEntering(false)
  }, [])

  /** 每次窗口 show 前后重放入场缩放。
   *  ★2026-11-25 修复「先缩小再重新打开」：旧实现是「先移除类、下一帧再加回」，
   *  而 show 之后第一帧就绘制——类还没加回，卡片以全尺寸先绘一帧，下一帧才缩到
   *  0.6 重开，视觉即「先缩小再打开」。改为同步重启：移除类 → 强制 reflow →
   *  立即加回，同一帧内完成，不存在全尺寸空档。调用方应在 show() 之前调用。 */
  const playEnter = useCallback(() => {
    if (enterRafRef.current != null) {
      window.cancelAnimationFrame(enterRafRef.current)
      enterRafRef.current = null
    }
    const el = cardRef.current
    if (!el) return
    el.classList.remove('is-entering')
    void el.offsetWidth // 强制 reflow：让「移除」对动画引擎生效
    el.classList.add('is-entering')
    setEntering(true)
  }, [])

  /** 每次唤起清空内容 / 读共享分类 / 清掉上一次的飞出与入场动画态。 */
  const reset = useCallback(() => {
    if (disposedRef.current) return
    // ★修复：保存后 flying 曾置 true 并让 .is-flying 的 forwards 动画定格在 opacity:0，
    //    hide 窗口不重置它 → 下次 show 时卡片透明+缩小且按钮被 `if (flying) return` 锁死，
    //    表现为「怎么点都打不开」。每次唤起必须清掉飞出态。
    setFlying(false)
    stopEnter()
    setFlyX(WIN_W)
    setTitle('')
    setText('')
    if (editorRef.current) editorRef.current.innerHTML = ''
    setErr('')
    // ★2026-11-24 每次唤起退出编辑模式（编辑入口由 applyEdit 单独进入）
    setEditMode(false)
    editIdRef.current = null
    // 每次唤起重新读共享分类表（可能刚在晾衣绳窗新增了分类），
    // 并默认带出上次选中的分类（失效则为空）。
    const freshCats = loadCategories()
    const last = loadLastCategory()
    setCats(freshCats)
    setCategory(last)
    setAddingCat(false)
    setNewCat('')
    // ★2026-11-23 诊断：确认每次唤起读到的分类表与上次分类（排查「默认带出不生效」）。
    void invoke('app_log', {
      message: `[quickNote] reset cats=${JSON.stringify(freshCats)} last=${JSON.stringify(last)}`,
    }).catch(() => {})
    window.setTimeout(() => titleRef.current?.focus(), 60)
  }, [stopEnter])

  const fullAccess = isFullAccess(loadAccount())

  // 首次挂载：定位居中 → show → 聚焦（Rust 建窗 visible:false）。
  // 之后每次唤起：清空内容 + 重新居中（双屏/换主屏后坐标可能失效）。
  const positionedRef = useRef(false)
  useEffect(() => {
    disposedRef.current = false
    const win = getCurrentWindow()

    void (async () => {
      try {
        // ★2026-11-23：只有 Rust 首次真实建窗时置位的"显示意图"才允许 show。
        //   WebView 因热重载/崩溃恢复重新挂载（窗口仍隐藏）时取到 false → 保持隐藏，
        //   杜绝「没操作却自己弹出随手记窗」。复用路径由 Rust 直接 show + emit，不走这里。
        const shouldShow = await invoke<boolean>('quick_note_take_show_intent').catch(() => false)
        if (!shouldShow) return
        // ★2026-11-25 问题3：首开截断根因——这里固定 setSize(460, 360)，而卡片加了
        // 工具行/分类行后实际高 ≈420px，窗口比卡片矮 → 底部像被截断；拉伸正文触发
        // ResizeObserver 后才恢复。改为按卡片当前实际高度设窗（下限仍 360）。
        // ⚠️ 必须用 offsetHeight：getBoundingClientRect 含 transform，入场缩放期间
        // 会测到缩小后的高度（这正是此前多次修复失败的原因之一）。
        const cardH = Math.max(WIN_H, cardRef.current?.offsetHeight ?? WIN_H)
        await win.setSize(new LogicalSize(WIN_W, cardH))
        await reposition(win)
        await win.setAlwaysOnTop(true)
        // ★先加入场类再 show：第一帧就是 scale(0.6)，不再闪一帧全尺寸。
        if (!disposedRef.current) playEnter()
        await win.show()
        await win.setFocus()
        positionedRef.current = true
        titleRef.current?.focus()
        // ★2026-11-25 高度兜底：首帧布局（字体、分类 chips 换行、错误行）可能在
        // 首次测量之后才稳定；分几个时间点重测并跟随窗口。offsetHeight 不受入场
        // 缩放影响，Rust quick_note_resize 内部仍钳制 [360, 600]。
        for (const delay of [80, 250, 600]) {
          window.setTimeout(() => {
            if (disposedRef.current) return
            const el = cardRef.current
            if (!el) return
            void invoke('quick_note_resize', { height: Math.max(WIN_H, el.offsetHeight) }).catch(() => undefined)
          }, delay)
        }
      } catch {
        /* 非 Tauri 环境忽略 */
      }
    })()
    reset()

    let un: (() => void) | undefined
    void listen('quick-note-reposition', () => {
      if (disposedRef.current) return
      void reposition(win)
      reset()
      // ★2026-11-25 复用路径同样兜底高度（reset 后分类数可能变化）+ 重放入场动画
      //（Rust 已改为 emit 先于 show，动画类在可见前就位）。
      window.setTimeout(() => {
        if (disposedRef.current) return
        const el = cardRef.current
        if (el) void invoke('quick_note_resize', { height: Math.max(WIN_H, el.offsetHeight) }).catch(() => undefined)
        playEnter()
      }, 60)
    }).then((u) => {
      if (disposedRef.current) u()
      else un = u
    })
    return () => {
      disposedRef.current = true
      if (enterRafRef.current != null) window.cancelAnimationFrame(enterRafRef.current)
      un?.()
    }
  }, [playEnter, reset])

  // Esc 关闭（失焦不自动关，避免点分类时误关）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void hideQuickNoteWindow()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // ★2026-11-24 正文拉伸 → 窗口高度跟随：ResizeObserver 监听卡片实际高度，
  // rAF 节流后 setSize（LogicalSize 与 CSS 像素 1:1）。上限 600 = 卡片基础高
  // (≈230) + 文本框上限 340 + 余量（chips 换行会更高）——拉伸的真正上限由 CSS
  // max-height:340 保证，这里只保证窗口装得下，不会无限拉高；飞出动画期间不改窗。
  // 权限来源：notes.json 的 "windows": ["*"] 通配（含 core:window:allow-set-size）。
  const flyingRef = useRef(false)
  flyingRef.current = flying
  const winResizeRafRef = useRef(0)
  useEffect(() => {
    const root = cardRef.current
    if (!root) return
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(winResizeRafRef.current)
      winResizeRafRef.current = requestAnimationFrame(() => {
        if (flyingRef.current) return
        // ★2026-11-25 必须用 offsetHeight（布局高度，不含 transform）：入场缩放
        // 动画期间若触发测量，getBoundingClientRect 会拿到 scale 后的假高度，
        // 窗口被设矮且之后布局不再变化、RO 不再触发 —— 截断就此凝固。
        const h = root.offsetHeight
        // Rust 命令直改窗口尺寸（比前端 window API 可靠：无权限/目标窗口匹配疑虑）
        void invoke('quick_note_resize', { height: h }).catch(() => undefined)
      })
    })
    ro.observe(root)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(winResizeRafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commitCategory = useCallback(() => {
    // ★2026-11-24 问题5：addCategory 内部已改读 localStorage 最新表（跨窗口竞态根因）；
    // 满额不再静默失败，直接提示用户。
    const { cats: next, name, reason } = addCategory(cats, newCat)
    if (name) {
      setCats(next)
      setCategory(name)
      saveLastCategory(name)
    } else if (reason === 'full') {
      setErr(t('quickNote.catFull'))
    }
    setNewCat('')
    setAddingCat(false)
  }, [cats, newCat, t])

  // ★2026-11-24 富文本编辑：execCommand（WebView2 支持）；styleWithCSS 让输出带
  // 内联样式（span style=…），便于落库前按白名单净化。editorRef 的 innerHTML 是
  // 正文真源，text 只是 innerText 镜像（供空值校验与依赖数组）。
  const editorRef = useRef<HTMLDivElement>(null)
  const syncText = useCallback(() => setText(editorRef.current?.innerText ?? ''), [])
  const fmt = useCallback(
    (cmd: string, value?: string) => {
      editorRef.current?.focus()
      document.execCommand(cmd, false, value)
      syncText()
    },
    [syncText],
  )
  useEffect(() => {
    document.execCommand('styleWithCSS', false, 'true')
  }, [])

  /** ★2026-11-24 编辑模式：填入待编辑卡（归档页整卡 JSON）并切到编辑态。 */
  const applyEdit = useCallback(
    (card: { id: string; title?: string; text?: string; category?: string | null }) => {
      if (disposedRef.current) return
      setFlying(false)
      stopEnter()
      setEditMode(true)
      editIdRef.current = card.id
      setTitle(card.title ?? '')
      setCats(loadCategories())
      setCategory(card.category ?? '')
      setAddingCat(false)
      setNewCat('')
      setErr('')
      const editor = editorRef.current
      if (editor) {
        const raw = card.text ?? ''
        if (isRichText(raw)) {
          // 富文本卡：剥前缀 + 白名单净化后整段还原（与速记窗新建格式完全一致）
          editor.innerHTML = sanitizeRichHtml(raw.slice(RICH_PREFIX.length))
        } else {
          editor.textContent = raw
        }
      }
      syncText()
      window.setTimeout(() => titleRef.current?.focus(), 60)
    },
    [stopEnter, syncText],
  )

  // ★2026-11-24 编辑模式数据通道：挂载时取走 pending（新建窗口路径）；之后每次收到
  // quick-note-edit 事件（窗口复用路径）再取。Rust 在 reposition（reset 清空）之后
  // 才补发 edit 事件；这里再延 80ms 双保险，确保覆盖 reset 的清空动作。
  useEffect(() => {
    let un: (() => void) | undefined
    const apply = async () => {
      const card = await invoke<{ id: string; title?: string; text?: string; category?: string | null } | null>(
        'quick_note_take_pending_edit',
      ).catch(() => null)
      if (card) applyEdit(card)
    }
    void apply()
    void listen('quick-note-edit', () => {
      if (disposedRef.current) return
      window.setTimeout(() => void apply(), 80)
    }).then((u) => {
      if (disposedRef.current) u()
      else un = u
    })
    return () => {
      un?.()
    }
  }, [applyEdit])

  /** 落库：创建一张 kind=text 随手记卡，可归档。 */
  const persist = useCallback(
    async (archive: boolean) => {
      const editor = editorRef.current
      const plain = (editor?.innerText ?? text).trim()
      if (!plain) {
        setErr(t('quickNote.errEmpty'))
        return
      }
      setErr('')
      // ★2026-11-24 富文本：有真实格式标记时存 '@@RICH@@' + 净化 HTML；
      // 纯换行（div/br）不算格式，走纯文本存储，与旧数据完全兼容。
      const rawHtml = editor?.innerHTML ?? ''
      const richBody = hasRichMarkup(rawHtml) ? RICH_PREFIX + sanitizeRichHtml(rawHtml) : plain
      // ★2026-11-24 编辑模式：增量更新原卡（不新增、不占绳位配额，归档状态保持原状）
      const editId = editIdRef.current
      if (editId) {
        await clUpdateCard(editId, {
          title: title.trim() || t('quickNote.defaultTitle'),
          text: richBody,
          category: category.trim() || null,
        })
        setEditMode(false)
        editIdRef.current = null
        return
      }
      const card = clMakeCard('text', {
        title: title.trim() || t('quickNote.defaultTitle'),
        text: richBody,
        card_style: 'mist',
        category: category.trim() || null,
      })
      if (archive) {
        // 归档卡不占绳位、不受配额限制，直接一步落库为已归档。
        await clAddArchivedCard(card)
      } else {
        await clAddCard(card, fullAccess, false)
      }
    },
    [title, text, category, fullAccess],
  )

  /** 保存归档：先同窗飞出动画，结束再落库 + 关窗。 */
  const saveArchive = useCallback(() => {
    if (flying) return
    stopEnter() // 入场未播完就保存：立刻让位给飞出动画
    if (!text.trim()) {
      setErr(t('quickNote.errEmpty'))
      return
    }
    // ★2026-11-24 编辑模式：直接保存修改（不播飞出动画、不新增归档条目）
    if (editMode) {
      void persist(true)
        .then(() => void hideQuickNoteWindow())
        .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      return
    }
    // 独立小窗无法跨窗飞入主窗，只能飞向工具窗所在侧的窗口边缘（红线内的物理极限）。
    setFlyX(readDockSide() === 'right' ? WIN_W : -WIN_W)
    setFlying(true)
    window.setTimeout(() => {
      void persist(true)
        .then(async () => {
          // 飞入落地 → 主窗顶栏归档角标 +1 脉冲（对齐预览的「到达反馈」）。
          await emit(CL_ARCHIVE_LANDED, { source: 'quick-note' }).catch(() => undefined)
          await hideQuickNoteWindow()
        })
        .catch((e) => {
          setFlying(false)
          setErr(e instanceof Error ? e.message : String(e))
        })
    }, FLY_MS)
  }, [flying, persist, stopEnter, text, editMode])

  /** 挂晾衣绳：直接落库（不归档）+ 关窗。 */
  const saveHang = useCallback(() => {
    if (flying) return
    stopEnter() // 入场未播完就保存：立刻让位给飞出动画
    if (!text.trim()) {
      setErr(t('quickNote.errEmpty'))
      return
    }
    setFlying(true)
    void persist(false)
      .then(() => void hideQuickNoteWindow())
      .catch((e) => {
        setFlying(false)
        setErr(e instanceof Error ? e.message : String(e))
      })
  }, [flying, persist, stopEnter, text])

  return (
    <div
      ref={cardRef}
      className={`qn-root ${flying ? 'is-flying' : ''} ${entering ? 'is-entering' : ''}`}
      style={{ '--fly-x': `${flyX}px` } as CSSProperties}
      onAnimationEnd={(e) => {
        if (e.animationName === 'qn-enter') setEntering(false)
      }}
    >
      {/* ★2026-11-24 问题1：拖动区收敛到标题栏（qn-head + 标题文字），光标提示与
          实际可拖范围一致；卡片边缘空白不再触发拖动，避免「有光标拖不动 / 无光标却能拖」 */}
      <div className="qn-head" data-tauri-drag-region>
        <span className="qn-title" data-tauri-drag-region>
          {editMode ? t('quickNote.editTitle') : t('quickNote.title')}
        </span>
        <button type="button" className="qn-close" aria-label={t('quickNote.closeAria')} onClick={() => void hideQuickNoteWindow()}>
          ×
        </button>
      </div>
      <input
        ref={titleRef}
        className="qn-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('quickNote.titlePlaceholder')}
        maxLength={60}
        onKeyDown={(e) => {
          // ★2026-11-24 Enter 快捷保存归档（IME 组合中不触发；Shift+Enter 不拦）
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            saveArchive()
          }
        }}
      />
      {/* ★2026-11-24 富文本工具行：加粗/倾斜/下划线/删除线/字体颜色（execCommand；
          onMouseDown preventDefault 保住编辑器选区，命令才能作用在已选中文字上） */}
      <div className="qn-toolbar">
        <button type="button" className="qn-fmt" aria-label={t('quickNote.bold')} onMouseDown={(e) => e.preventDefault()} onClick={() => fmt('bold')}>
          <b>B</b>
        </button>
        <button type="button" className="qn-fmt" aria-label={t('quickNote.italic')} onMouseDown={(e) => e.preventDefault()} onClick={() => fmt('italic')}>
          <i>I</i>
        </button>
        <button type="button" className="qn-fmt" aria-label={t('quickNote.underline')} onMouseDown={(e) => e.preventDefault()} onClick={() => fmt('underline')}>
          <u>U</u>
        </button>
        <button type="button" className="qn-fmt" aria-label={t('quickNote.strike')} onMouseDown={(e) => e.preventDefault()} onClick={() => fmt('strikeThrough')}>
          <s>S</s>
        </button>
        <input
          type="color"
          className="qn-color"
          aria-label={t('quickNote.color')}
          defaultValue="#2c2c2a"
          onChange={(e) => fmt('foreColor', e.target.value)}
        />
      </div>
      <div
        ref={editorRef}
        className="qn-textarea"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        data-placeholder={t('quickNote.bodyPlaceholder')}
        onInput={syncText}
        onKeyDown={(e) => {
          // ★2026-11-24 Enter 快捷保存归档（Shift+Enter 换行；IME 组合中不触发）
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (e.shiftKey) document.execCommand('insertLineBreak')
            else saveArchive()
          }
        }}
      />
      <div className="qn-cats">
        <span className="qn-cats-label">{t('quickNote.category')}</span>
        <div className="qn-cats-chips">
          {cats.map((c) => (
            <button
              type="button"
              key={c}
              className={`qn-chip ${category === c ? 'is-active' : ''}`}
              onClick={() => {
                const next = category === c ? '' : c
                setCategory(next)
                saveLastCategory(next)
              }}
            >
              {c}
              {/* ★2026-11-25 问题2：分类可删除 —— chip 悬停出现 ×，点击删除该分类
                  （localStorage 最新表 + 清除「上次选中」记忆；不影响历史卡片）。 */}
              <span
                role="button"
                aria-label={t('quickNote.catDelete')}
                title={t('quickNote.catDelete')}
                className="qn-chip-x"
                onClick={(e) => {
                  e.stopPropagation()
                  const next = removeCategory(c)
                  setCats(next)
                  if (category === c) {
                    setCategory('')
                    saveLastCategory('')
                  }
                }}
              >
                ×
              </span>
            </button>
          ))}
          {addingCat ? (
            <input
              className="qn-cat-input"
              value={newCat}
              autoFocus
              maxLength={8}
              placeholder={t('quickNote.catPlaceholder')}
              onChange={(e) => setNewCat(e.target.value)}
              onBlur={commitCategory}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitCategory()
                if (e.key === 'Escape') {
                  setAddingCat(false)
                  setNewCat('')
                }
              }}
            />
          ) : (
            <button type="button" className="qn-chip qn-chip-add" onClick={() => setAddingCat(true)}>
              ＋ {t('quickNote.catNew')}
            </button>
          )}
        </div>
      </div>
      {err ? <div className="qn-err">{err}</div> : null}
      <div className="qn-actions">
        {editMode ? (
          // ★2026-11-24 编辑模式：只保留「保存修改」（更新原卡，不新增）
          <button type="button" className="qn-btn qn-btn-hang" onClick={saveArchive}>
            {t('quickNote.saveEdit')}
          </button>
        ) : (
          <>
            <button type="button" className="qn-btn qn-btn-hang" onClick={saveHang}>
              {t('quickNote.hang')}
            </button>
            <button type="button" className="qn-btn qn-btn-archive" onClick={saveArchive}>
              {t('quickNote.archive')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function QuickNoteWindow() {
  return (
    <I18nProvider>
      <QuickNoteApp />
    </I18nProvider>
  )
}
