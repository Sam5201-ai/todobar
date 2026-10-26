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

import { readFreeQuotaUsed, useTaskStore } from '../useTaskStore'
import { useAccount } from '../membership'
import { emitConvertResult, listenConvertRequest } from './bridge'
import { getNotes, hydrateNotes, MAX_VISIBLE_NOTES } from './store'
import { createNoteWithWindow, failText } from './manager'
import { applyNoteShortcut, initNoteShortcuts } from './shortcuts'

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
  const fullAccessRef = useRef(fullAccess)
  fullAccessRef.current = fullAccess
  const storeRef = useRef(store)
  storeRef.current = store
  const setToastRef = useRef(setToast)
  setToastRef.current = setToast

  // ⓪ 磁盘回灌 + 启动恢复:重装 / 清理 WebView 缓存后 localStorage 为空时,
  //    从 ~/.ticktask/prefs.json 恢复便利签数据(与录音 / 计薪同机制);
  //    随后把"还没删"的便利签按上次保存的位置重新开窗(用户选 B:持久化)。
  //    notes_open_window 幂等(已有活窗口则复用),重复调用安全。
  useEffect(() => {
    let cancelled = false
    void hydrateNotes().then(() => {
      if (cancelled) return
      const toOpen = [...getNotes()]
        .filter((n) => !n.collapsed) // 防御:hydrate 已清 legacy 收起态,这里再挡一道
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
            ? '今日免费额度已用完,开通会员可继续'
            : '当前无法新建待办'
          : '内容为空,无法转待办'
        void emitConvertResult({
          noteId: req.noteId,
          itemId: req.itemId,
          ok: false,
          reason,
        })
        return
      }

      void emitConvertResult({ noteId: req.noteId, itemId: req.itemId, ok: true })
      setToastRef.current('ok', '已转为待办')
    }).then((fn) => {
      if (disposed) fn()
      else un = fn
    })

    return () => {
      disposed = true
      un?.()
    }
  }, [])
}
