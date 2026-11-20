/**
 * 便利签在主窗口侧的桥接(自定义 hook)。
 *
 * 把「注册快捷键 / 处理快捷键触发 / 处理转待办请求」三件事收在这里,
 * 让 App.tsx 只需调用一次 `useNotesBridge({...})`,避免在已经很大的 App.tsx 里
 * 再散落便利签逻辑(快捷键、事件监听、闸门都收在 notes/ 目录下)。
 *
 * **会员闸门统一在前端**:Rust 只负责"快捷键被按下"这个信号,
 * 是否创建由这里依据 `fullAccess` 决定 —— 这样提示文案与其他会员功能保持一致。
 */

import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'

import { readFreeQuotaUsed, useTaskStore } from '../useTaskStore'
import { useAccount } from '../membership'
import {
  CL_ARCHIVE_CARD,
  CL_CREATE_NOTE,
  CL_EDIT_NOTE_ITEM,
  CL_NOTE_COLOR_ACTION,
  CL_NOTE_HUNG,
  CL_NOTE_ITEM_ACTION,
  CL_OPEN_NOTE,
  CL_TOAST,
  type ClArchiveCard,
  type ClNoteColorAction,
  type ClNoteHung,
  type ClNoteItemAction,
  type ClToastPayload,
} from '../clothesline/bridge'
import { clAddCard, clArchiveCard, clDeleteArchived, clGetRestoreState, clListArchived, clMakeCard, clRemoveCard } from '../clothesline/bridge'
import { emitConvertResult, listenConvertRequest } from './bridge'
import {
  addNoteItem,
  archiveNote,
  createNote,
  getNotes,
  hydrateNotes,
  MAX_VISIBLE_NOTES,
  removeNote,
  removeNoteItem,
  toggleNoteItem,
  updateNote,
  updateNoteItem,
} from './store'
import { createNoteWithWindow, failText } from './manager'
import { applyNoteShortcut, initNoteShortcuts } from './shortcuts'
import { t } from '../i18n'

type Store = ReturnType<typeof useTaskStore>

export function useNotesBridge(params: {
  /** 设置页里的「新建便利签」快捷键。 */
  noteShortcut: string
  store: Store
  setToast: (kind: 'ok' | 'err', text: string) => void
}): void {
  const { noteShortcut, store, setToast } = params

  const { fullAccess } = useAccount()

  // 用 ref 持有最新值:事件回调是长期存活的监听器,不能闭包捕获旧快照。
  // ★render 期不写 ref（React Compiler / react-hooks/refs）：统一在 effect 里同步，
  //   监听器注册在挂载后运行，届时 ref 已同步完毕，语义完全等价。
  const fullAccessRef = useRef(fullAccess)
  const storeRef = useRef(store)
  const setToastRef = useRef(setToast)
  useEffect(() => {
    fullAccessRef.current = fullAccess
    storeRef.current = store
    setToastRef.current = setToast
  }, [fullAccess, store, setToast])

  // ⓪ 磁盘回灌 + 启动恢复:重装 / 清理 WebView 缓存后 localStorage 为空时,
  //    从 ~/.ticktask/prefs.json 恢复便利签数据(与录音 / 计薪同机制);
  //    随后把"还没删"的便利签按上次保存的位置重新开窗(用户选 B:持久化)。
  //    notes_open_window 幂等(已有活窗口则复用),重复调用安全。
  useEffect(() => {
    let cancelled = false
    void hydrateNotes().then(() => {
      if (cancelled) return
      const toOpen = [...getNotes()]
        .filter((n) => !n.collapsed && !n.archivedAt) // 归档签不开窗(修复:重启后归档签重回桌面)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, MAX_VISIBLE_NOTES)
      toOpen.forEach((n, i) => {
        window.setTimeout(() => {
          void invoke('notes_open_window', { noteId: n.id, pinned: n.pinned }).catch(() => {})
        }, i * 80)
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  // ① 注册 / 重注册全局快捷键。非会员不注册(释放热键,按下也不会创建);
  //    运行时 createNoteWithWindow 仍有会员闸门作兜底。会员态变化时(登录/过期)重注册。
  useEffect(() => {
    void applyNoteShortcut(fullAccess ? noteShortcut : '').then((r) => {
      if (!r.ok) {
        // 不弹 toast:注册失败若每次启动都提示会打扰用户,这里只记录。
        console.warn('[notes] 便利签快捷键注册失败:', r.error)
      }
    })
  }, [noteShortcut, fullAccess])

  // ② 快捷键触发 → 新建便利签(含会员 / 总数 / 显示数三道闸门)。
  useEffect(() => {
    void initNoteShortcuts(() => {
      void createNoteWithWindow(fullAccessRef.current).then((r) => {
        if (!r.ok) setToastRef.current('err', failText(r.reason))
      })
    })
  }, [])

  // ③ 便利签窗口的「转待办」请求 → 走标准 addTask。
  //    好处:会员配额、主界面 reload、云同步触发全部自动生效,不会绕过闸门。
  useEffect(() => {
    let disposed = false
    let un: (() => void) | undefined

    void listenConvertRequest((req) => {
      const s = storeRef.current
      // 默认转入「今天」清单 —— 与主界面 handleAddTree 的处理保持一致
      // (listId 是 'today' / 'month' 这类虚拟清单 id,不是 customLists 的 id)。
      const listId = 'today'

      const task = s.addTask(listId, req.text)
      if (!task) {
        // addTask 失败时**不抛错、返回 null**,必须区分场景给用户明确提示,
        // 否则就是经典的"点了没反应"。
        const limited = !fullAccessRef.current
        const reason = limited
          ? readFreeQuotaUsed() >= 3
            ? t('note.quotaFull')
            : t('note.noTaskSlot')
          : t('note.emptyNoTask')
        void emitConvertResult({
          noteId: req.noteId,
          itemId: req.itemId,
          ok: false,
          reason,
        })
        return
      }

      void emitConvertResult({ noteId: req.noteId, itemId: req.itemId, ok: true })
      setToastRef.current('ok', t('note.toTaskDone'))
    }).then((fn) => {
      if (disposed) fn()
      else un = fn
    })

    return () => {
      disposed = true
      un?.()
    }
  }, [])

  // ④ 晾衣绳的便利签卡：绳窗只读 localStorage、绝不写 prefs.json（R60 竞态）。
  //    「打开原内容」与「编辑单条事项」都在这里落盘，仍然是 notes/store.ts 单一写方。
  useEffect(() => {
    let disposed = false
    const unsubs: Array<() => void> = []
    void (async () => {
      const u1 = await listen<{ id: string }>(CL_OPEN_NOTE, (e) => {
        if (disposed) return
        const note = getNotes().find((n) => n.id === e.payload.id)
        if (!note) {
          setToastRef.current('err', t('note.goneToast'))
          return
        }
        // 2026-11-15 需求:绳卡「打开原内容」时把桌面便利签标记为未折叠,
        // 否则重启后 boot 自动恢复会把它过滤掉(collapsed 的不再弹窗)。
        if (note.collapsed) updateNote(note.id, { collapsed: false })
        void invoke('notes_open_window', { noteId: note.id, pinned: note.pinned }).catch(() => {
          setToastRef.current('err', t('note.openFail'))
        })
      }).catch(() => null)
      if (u1) unsubs.push(u1)

      const u2 = await listen<{ noteId: string; itemId: string; text: string }>(
        CL_EDIT_NOTE_ITEM,
        (e) => {
          if (disposed) return
          const { noteId, itemId, text } = e.payload
          if (!text?.trim()) return
          updateNoteItem(noteId, itemId, { text: text.trim() })
          setToastRef.current('ok', t('note.updated'))
        },
      ).catch(() => null)
      if (u2) unsubs.push(u2)

      // ⑥ 绳上便利签卡可交互：勾选 / 新增 / 删除 / 编辑条目。
      //    绳窗只读 localStorage 快照，所有写回统一由主窗 store 单一写方执行，
      //    避免绳窗直接写 prefs.json 造成整文件覆盖（既有功能红线）。
      const u3 = await listen<ClNoteItemAction>(CL_NOTE_ITEM_ACTION, (e) => {
        if (disposed) return
        const p = e.payload
        if (!p?.noteId) return
        switch (p.action) {
          case 'toggle':
            toggleNoteItem(p.noteId, p.itemId)
            break
          case 'add':
            if (p.text?.trim()) addNoteItem(p.noteId, p.text.trim())
            break
          case 'remove':
            removeNoteItem(p.noteId, p.itemId)
            break
          case 'edit':
            if (p.text?.trim()) updateNoteItem(p.noteId, p.itemId, { text: p.text.trim() })
            break
          case 'totask': {
            // ★2026-11-15 反馈4：绳上便利签行操作「加入待办」→ 主窗任务单一写方建任务。
            const text = p.text?.trim()
            if (!text) break
            const added = storeRef.current.addTask('today', text)
            // ★批14：结果 toast 弹回绳窗并锚到该便利签卡（用户不会一直开着工具窗，
            //   主窗 toast 等于没提示，会让用户以为没有添加成功）。
            void emit(CL_TOAST, {
              kind: added ? 'ok' : 'err',
              msg: added ? t('note.addedToday') : t('note.taskLimit'),
              noteId: p.noteId,
            } satisfies ClToastPayload).catch(() => undefined)
            break
          }
        }
      }).catch(() => null)
      if (u3) unsubs.push(u3)

      // ★2026-11-15 反馈6：绳窗 ＋ 菜单「新建便利签」→ 主窗单一写方创建便利签数据
      //    （collapsed：不开桌面窗、重启也不再桌面弹出），随后直接挂上晾衣绳。
      //    一步到位，不再需要「先建桌面便利签 → 再点挂绳」两步流程。
      const uNoteCreate = await listen<unknown>(CL_CREATE_NOTE, () => {
        if (disposed) return
        if (!fullAccessRef.current) {
          setToastRef.current('err', t('note.vipOnly'))
          return
        }
        const note = createNote({ collapsed: true })
        if (!note) {
          setToastRef.current('err', t('note.countLimit'))
          return
        }
        void clAddCard(clMakeCard('note', { note_id: note.id }), true)
          .then(() => setToastRef.current('ok', t('note.createdHung')))
          .catch((e) => setToastRef.current('err', failText(e)))
      }).catch(() => null)
      if (uNoteCreate) unsubs.push(uNoteCreate)

      // ⑧ 问题1：便利签成功挂到绳上后，桌面那张便利签必须自动消失。
      //    只把 collapsed 置 true + 关窗口，**绝不删数据**（绳上卡仍按 noteId 读快照）。
      //    collapsed 后 visibleNotes() 不再包含它，重启也不会又冒出来。
      const u4 = await listen<ClNoteHung>(CL_NOTE_HUNG, (e) => {
        if (disposed || !e.payload?.noteId) return
        const noteId = e.payload.noteId
        if (!getNotes().some((n) => n.id === noteId)) return
        updateNote(noteId, { collapsed: true })
        void invoke('notes_close_window', { noteId }).catch(() => undefined)
      }).catch(() => null)
      if (u4) unsubs.push(u4)

      // ⑨ 问题10：绳上便利签换色，仍由主窗 notes/store.ts 单一写方落盘。
      const u5 = await listen<ClNoteColorAction>(CL_NOTE_COLOR_ACTION, (e) => {
        if (disposed || !e.payload?.noteId || !e.payload?.colorKey) return
        updateNote(e.payload.noteId, { colorKey: e.payload.colorKey })
      }).catch(() => null)
      if (u5) unsubs.push(u5)

      // ⑩ ★2026-11-18 归档：便签窗/绳窗的「一体归档 / 永久删除」编排。
      //    写方只在主窗（单一写方红线）：archiveNote/removeNote 归这里，
      //    绳卡命令（clArchiveCard/clDeleteArchived）也从这里发起。
      const u6 = await listen<ClArchiveCard>(CL_ARCHIVE_CARD, (e) => {
        if (disposed) return
        const p = e.payload
        if (!p?.action) return
        void (async () => {
          if (p.action === 'archive') {
            // 1) 便签数据归档（存在且未归档时）；2) 关联绳卡同步归档。
            const note = getNotes().find((n) => n.id === p.noteId)
            if (note && note.archivedAt == null) archiveNote(note.id)
            const cardId =
              p.cardId ??
              (await clGetRestoreState()
                .then((st) => st.cards.find((c) => c.note_id === p.noteId)?.id ?? null)
                .catch(() => null))
            if (cardId) await clArchiveCard(cardId).catch(() => undefined)
          } else if (p.action === 'delete-note') {
            // 永久删除便签 + 清理关联绳卡（活跃卡由绳窗删除路径带 cardId 过来）。
            if (p.noteId && getNotes().some((n) => n.id === p.noteId)) removeNote(p.noteId)
            if (p.cardId) {
              await clRemoveCard(p.cardId).catch(() => undefined)
              await clDeleteArchived(p.cardId).catch(() => undefined)
            }
            const archived = await clListArchived().catch(() => [])
            const hit = archived.find((c) => c.note_id === p.noteId)
            if (hit) await clDeleteArchived(hit.id).catch(() => undefined)
          }
        })()
      }).catch(() => null)
      if (u6) unsubs.push(u6)
    })()
    return () => {
      disposed = true
      unsubs.forEach((u) => u())
    }
  }, [])
}
