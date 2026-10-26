/**
 * 设置页「账号」区块 + 登录/注册/改密/设备管理弹窗。
 *
 * 设计(2026-10-14 改版):
 * - 设置页最上方上下排列:头像在上、昵称在下。
 * - 未登录:默认头像 + 「未登录」+ 登录按钮(打开弹窗)。
 * - 已登录:自定义头像/昵称(均可点击修改)+ 修改密码 + 设备数 + 退出登录。
 * - 弹窗含 登录/注册 双 tab + 找回密码入口。
 */
import { useEffect, useRef, useState } from 'react'
import defaultAvatar from './assets/default-avatar.svg'
import {
  loadAccount,
  saveAccount,
  login,
  register,
  logout,
  sendCode,
  changePassword,
  fetchDevices,
  revokeDevice,
  revokeOtherDevices,
  updateProfile,
  redeemActivationCode,
  refreshAccount,
  AUTH_INVALID_EVENT,
  type AccountState,
  type DeviceInfo,
} from './account'
import { AUTH_BASE } from './account'

type ModalView = 'auth' | 'password' | 'devices' | null

/** 把用户选择的图片压成 256px 方形 JPEG dataURL(≤约 200KB,方便存 D1)。 */
function fileToAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const S = 256
      const canvas = document.createElement('canvas')
      canvas.width = S
      canvas.height = S
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('画布不可用'))
        return
      }
      const side = Math.min(img.width, img.height)
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S)
      URL.revokeObjectURL(url)
      let q = 0.9
      let out = canvas.toDataURL('image/jpeg', q)
      while (out.length > 260_000 && q > 0.35) {
        q -= 0.15
        out = canvas.toDataURL('image/jpeg', q)
      }
      resolve(out)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片读取失败'))
    }
    img.src = url
  })
}

function Field(props: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <label className="labeled-input">
      <span>
        <strong>{props.label}</strong>
      </span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  )
}

export function AccountSetting({
  onSyncChange,
}: {
  onSyncChange: (patch: Partial<import('./types').SyncConfig>) => void
}) {
  const [account, setAccount] = useState<AccountState | null>(() => loadAccount())
  const [modalView, setModalView] = useState<ModalView>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [editingNick, setEditingNick] = useState(false)
  const [nickDraft, setNickDraft] = useState('')
  const [codeDraft, setCodeDraft] = useState('')
  const [showLogout, setShowLogout] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  // 令牌失效(云端 401:密码修改/设备被解绑/会话过期)时,账号区立即回到未登录态,
  // 避免出现「显示已登录但同步/设备接口全部 401」的僵尸登录态(0.2.9 修复)。
  useEffect(() => {
    const onInvalid = () => setAccount(null)
    window.addEventListener(AUTH_INVALID_EVENT, onInvalid)
    return () => window.removeEventListener(AUTH_INVALID_EVENT, onInvalid)
  }, [])

  // 会员状态静默刷新:挂载与窗口重新获焦点时向云端对齐(后台激活/其他设备兑换后生效)。
  // 用函数式更新按字段比较,值不变则返回原 state 引用,避免重复请求死循环。
  useEffect(() => {
    if (!account) return
    let cancelled = false
    const refresh = () => {
      void refreshAccount().then((next) => {
        if (cancelled || !next) return
        setAccount((prev) =>
          prev && prev.activated === next.activated && prev.trialEndsAt === next.trialEndsAt
            ? prev
            : next,
        )
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [account])

  // 头像/昵称保存成功或失败:轻量 toast 提示,2.8s 后自动消失,不再常驻页面
  useEffect(() => {
    if (!msg) return
    const t = window.setTimeout(() => setMsg(null), 2800)
    return () => clearTimeout(t)
  }, [msg])

  async function handleRedeem() {
    const code = codeDraft.trim()
    if (!code) return
    setBusy(true)
    try {
      const next = await redeemActivationCode(code)
      setAccount(next)
      setCodeDraft('')
      setMsg({ kind: 'ok', text: '兑换成功,已升级为会员' })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || '兑换失败' })
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout() {
    setBusy(true)
    try {
      await logout()
    } catch {
      /* 忽略 */
    } finally {
      setAccount(null)
      setModalView(null)
      onSyncChange({ enabled: false, token: '' })
      setBusy(false)
    }
  }

  async function handleAvatarFile(file: File) {
    setMsg(null)
    try {
      const dataUrl = await fileToAvatarDataUrl(file)
      // ① 本地立即生效:写入 localStorage 并刷新头像,用户立刻看到结果。
      const cur = loadAccount()
      if (cur) {
        const optimistic = { ...cur, avatar: dataUrl }
        saveAccount(optimistic)
        setAccount(optimistic)
      }
      // ② 云端静默同步(异步,不阻塞 UI)。失败也保留本地修改,仅提示。
      setMsg({ kind: 'ok', text: '头像已保存,云端同步中…' })
      void updateProfile({ avatar: dataUrl })
        .then((next) => {
          setAccount(next)
          setMsg({ kind: 'ok', text: '头像已更新' })
        })
        .catch((e) => setMsg({ kind: 'err', text: `云端同步失败: ${(e as Error).message}` }))
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    }
  }

  async function saveNickname() {
    const n = nickDraft.trim()
    if (!n) return
    setMsg(null)
    try {
      // ① 本地立即生效:nickDraft 已经是新值,先落本地并退出编辑态。
      const cur = loadAccount()
      if (cur) {
        const optimistic = { ...cur, nickname: n }
        saveAccount(optimistic)
        setAccount(optimistic)
      }
      setEditingNick(false)
      setMsg({ kind: 'ok', text: '昵称已保存,云端同步中…' })
      // ② 云端静默同步(异步)。
      void updateProfile({ nickname: n })
        .then((next) => {
          setAccount(next)
          setMsg({ kind: 'ok', text: '昵称已更新' })
        })
        .catch((e) => setMsg({ kind: 'err', text: `云端同步失败: ${(e as Error).message}` }))
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    }
  }

  const msgEl = msg ? (
    <div
      className={`sidebar-toast ${msg.kind === 'ok' ? 'is-ok' : 'is-err'}`}
      style={{
        position: 'fixed',
        top: 54,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        justifyContent: 'center',
        animation: 'toast-in 180ms ease',
      }}
      aria-live="polite"
    >
      {msg.text}
    </div>
  ) : null

  return (
    <>
      <div className="settings-group account-hero">
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleAvatarFile(f)
            e.target.value = ''
          }}
        />
        {account ? (
          <>
            <button
              type="button"
              className="account-avatar-btn"
              title="点击更换头像"
              onClick={() => avatarInputRef.current?.click()}
            >
              <img src={account.avatar || defaultAvatar} alt="头像" />
            </button>
            {editingNick ? (
              <div className="account-nick-edit">
                <input
                  value={nickDraft}
                  maxLength={24}
                  autoFocus
                  placeholder="昵称"
                  onChange={(e) => setNickDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveNickname()
                    if (e.key === 'Escape') setEditingNick(false)
                  }}
                />
                <button type="button" onClick={() => void saveNickname()} disabled={busy}>
                  保存
                </button>
                <button type="button" onClick={() => setEditingNick(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="account-nick"
                title="点击修改昵称"
                onClick={() => {
                  setNickDraft(account.nickname || '')
                  setEditingNick(true)
                }}
              >
                {account.nickname || account.email.split('@')[0]}
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  aria-hidden="true"
                  style={{ marginLeft: 4, opacity: 0.55 }}
                >
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>
            )}
            <div className="account-email">{account.email}</div>
            <div className="account-status">
              {account.activated
                ? '已激活 · 永久全功能'
                : account.trialEndsAt
                  ? `试用中 · 剩余 ${Math.max(0, Math.ceil((Date.parse(account.trialEndsAt) - Date.now()) / 86_400_000))} 天`
                  : ''}
            </div>
            {!account.activated && (
              <div className="account-redeem">
                <input
                  value={codeDraft}
                  maxLength={40}
                  placeholder="输入激活码,兑换会员"
                  onChange={(e) => setCodeDraft(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleRedeem()
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleRedeem()}
                  disabled={busy || !codeDraft.trim()}
                >
                  兑换
                </button>
              </div>
            )}
            <div className="account-actions">
              <button type="button" onClick={() => setModalView('password')} disabled={busy}>
                修改密码
              </button>
              <button type="button" onClick={() => setModalView('devices')} disabled={busy}>
                设备
              </button>
              <button type="button" onClick={() => setShowLogout(true)} disabled={busy}>
                退出登录
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="account-avatar-static">
              <img src={defaultAvatar} alt="默认头像" />
            </div>
            <div className="account-nick">未登录</div>
            <div className="account-email">登录后可多设备云同步</div>
            <div className="account-actions">
              <button type="button" onClick={() => setModalView('auth')}>
                登录
              </button>
            </div>
          </>
        )}
        {msgEl}
      </div>

      {showLogout ? (
        <div
          className="account-modal-overlay"
          onClick={() => setShowLogout(false)}
          role="presentation"
        >
          <div
            className="account-modal"
            role="dialog"
            aria-modal="true"
            aria-label="确认退出登录"
            style={{ maxWidth: 320 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="account-modal-head">
              <strong>退出登录</strong>
              <button
                type="button"
                className="account-modal-close"
                onClick={() => setShowLogout(false)}
                aria-label="关闭"
              >
                ✕
              </button>
            </div>
            <p
              style={{
                fontSize: 13,
                lineHeight: 1.65,
                opacity: 0.85,
                margin: '8px 0 16px',
              }}
            >
              退出后本设备将停止云同步,想再次同步需重新登录。确定退出吗?
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="account-link" onClick={() => setShowLogout(false)}>
                取消
              </button>
              <button
                type="button"
                className="sync-now-button"
                disabled={busy}
                onClick={() => {
                  setShowLogout(false)
                  void handleLogout()
                }}
              >
                确认退出
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modalView ? (
        <AccountModal
          view={modalView}
          account={account}
          onClose={() => setModalView(null)}
          onOpenReset={() => setModalView('password')}
          onLoggedIn={(acc) => {
            setAccount(acc)
            setModalView(null)
            onSyncChange({ enabled: true, endpoint: AUTH_BASE, token: acc.token })
          }}
          onPasswordChanged={() => {
            setAccount(null)
            setModalView('auth')
            onSyncChange({ enabled: false, token: '' })
          }}
        />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// 弹窗:登录/注册(双 tab + 找回密码)/ 修改密码 / 设备管理
// ---------------------------------------------------------------------------

function AccountModal({
  view,
  account,
  onClose,
  onOpenReset,
  onLoggedIn,
  onPasswordChanged,
}: {
  view: Exclude<ModalView, null>
  account: AccountState | null
  onClose: () => void
  onOpenReset: () => void
  onLoggedIn: (acc: AccountState) => void
  onPasswordChanged: () => void
}) {
  // auth 表单
  const [tab, setTab] = useState<'login' | 'register'>(account ? 'login' : 'login')
  const [email, setEmail] = useState(account?.email ?? '')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [code, setCode] = useState('')
  // 通用
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [countdown, setCountdown] = useState(0)
  // 设备管理
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  useEffect(() => {
    if (view !== 'devices') return
    fetchDevices()
      .then((d) => setDevices(d.devices))
      .catch(() => setDevices([]))
  }, [view])

  async function handleSendCode(purpose: 'register' | 'reset') {
    setMsg(null)
    if (!email) {
      setMsg({ kind: 'err', text: '请先填写邮箱' })
      return
    }
    if (countdown > 0) return
    setBusy(true)
    try {
      await sendCode(email, purpose)
      setCountdown(60)
      setMsg({ kind: 'ok', text: '验证码已发送到邮箱(10 分钟内有效)' })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function handleSubmitAuth() {
    setMsg(null)
    if (!email || !password) {
      setMsg({ kind: 'err', text: '请填写邮箱和密码' })
      return
    }
    if (tab === 'register' && !code) {
      setMsg({ kind: 'err', text: '请填写邮箱验证码' })
      return
    }
    setBusy(true)
    try {
      const acc =
        tab === 'register'
          ? await register(email, password, code, nickname.trim() || undefined, avatar)
          : await login(email, password)
      onLoggedIn(acc)
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function handlePassword() {
    setMsg(null)
    if (!email || !password || !code) {
      setMsg({ kind: 'err', text: '请填写邮箱、验证码和新密码' })
      return
    }
    setBusy(true)
    try {
      await changePassword(email, password, code)
      onPasswordChanged()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function handleRevoke(token: string) {
    try {
      await revokeDevice(token)
      fetchDevices()
        .then((d) => setDevices(d.devices))
        .catch(() => setDevices([]))
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    }
  }

  /** 一键解绑其他所有设备:清理同一台电脑被历史缺陷记成多台的幽灵设备。 */
  async function handleRevokeOthers() {
    if (
      !window.confirm(
        '将解绑除本机外的所有设备,被解绑的设备需要重新登录。确定继续吗?',
      )
    )
      return
    try {
      await revokeOtherDevices()
      fetchDevices()
        .then((d) => setDevices(d.devices))
        .catch(() => setDevices([]))
      setMsg({ kind: 'ok', text: '已解绑其他所有设备(保留本机)' })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    }
  }

  const msgEl = msg ? (
    <div
      className="sync-status"
      aria-live="polite"
      style={{ color: msg.kind === 'ok' ? '#16a34a' : '#dc2626' }}
    >
      {msg.text}
    </div>
  ) : null

  const title =
    view === 'password'
      ? '修改密码'
      : view === 'devices'
        ? '设备管理'
        : tab === 'login'
          ? '登录 TickTask'
          : '注册 TickTask'

  return (
    <div className="account-modal-overlay" onClick={onClose} role="presentation">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className="account-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="account-modal-head">
          <strong>{title}</strong>
          <button type="button" className="account-modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        {view === 'auth' ? (
          <>
            <div className="segmented-control" aria-label="登录或注册">
              <button
                type="button"
                className={tab === 'login' ? 'is-selected' : ''}
                onClick={() => {
                  setTab('login')
                  setMsg(null)
                }}
              >
                登录
              </button>
              <button
                type="button"
                className={tab === 'register' ? 'is-selected' : ''}
                onClick={() => {
                  setTab('register')
                  setMsg(null)
                }}
              >
                注册
              </button>
            </div>
            {tab === 'register' ? (
              <div className="account-reg-top">
                <button
                  type="button"
                  className="account-avatar-btn account-avatar-sm"
                  title="选择头像(可选)"
                  onClick={() => document.getElementById('account-avatar-input')?.click()}
                >
                  <img src={avatar ?? defaultAvatar} alt="头像" />
                </button>
                <input
                  id="account-avatar-input"
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (!f) return
                    try {
                      setAvatar(await fileToAvatarDataUrl(f))
                    } catch (err) {
                      setMsg({ kind: 'err', text: (err as Error).message })
                    }
                  }}
                />
                <input
                  className="account-nick-input"
                  value={nickname}
                  maxLength={24}
                  placeholder="昵称(选填)"
                  onChange={(e) => setNickname(e.target.value)}
                />
              </div>
            ) : null}
            <Field label="邮箱" value={email} placeholder="you@example.com" onChange={setEmail} />
            <Field
              label="密码"
              type="password"
              value={password}
              placeholder="至少 8 位"
              onChange={setPassword}
            />
            {tab === 'register' ? (
              <div className="account-code-row">
                <Field label="验证码" value={code} placeholder="邮箱验证码" onChange={setCode} />
                <button
                  type="button"
                  className="sync-now-button account-code-btn"
                  onClick={() => void handleSendCode('register')}
                  disabled={busy || countdown > 0}
                >
                  {countdown > 0 ? `${countdown}s` : '获取验证码'}
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="sync-now-button"
              onClick={handleSubmitAuth}
              disabled={busy}
            >
              {busy ? '处理中…' : tab === 'register' ? '注册并登录' : '登录'}
            </button>
            <button
              type="button"
              className="account-link"
              onClick={() => {
                setTab('login')
                onOpenReset()
              }}
            >
              忘记密码?
            </button>
            <div className="sync-status" style={{ fontSize: 11 }}>
              登录后自动开启云同步,支持多设备登录
            </div>
            {msgEl}
          </>
        ) : null}

        {view === 'password' ? (
          <>
            <Field label="邮箱" value={email} placeholder="注册邮箱" onChange={setEmail} />
            <div className="account-code-row">
              <Field label="验证码" value={code} placeholder="邮箱验证码" onChange={setCode} />
              <button
                type="button"
                className="sync-now-button account-code-btn"
                onClick={() => void handleSendCode('reset')}
                disabled={busy || countdown > 0}
              >
                {countdown > 0 ? `${countdown}s` : '获取验证码'}
              </button>
            </div>
            <Field
              label="新密码"
              type="password"
              value={password}
              placeholder="至少 8 位"
              onChange={setPassword}
            />
            <button
              type="button"
              className="sync-now-button"
              onClick={handlePassword}
              disabled={busy}
            >
              {busy ? '提交中…' : '确认修改'}
            </button>
            <div className="sync-status" style={{ fontSize: 11 }}>
              修改成功后所有设备需重新登录
            </div>
            {msgEl}
          </>
        ) : null}

        {view === 'devices' ? (
          <>
            {devices === null ? (
              <div className="sync-status">加载中…</div>
            ) : devices.length === 0 ? (
              <div className="sync-status">暂无设备</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {devices.map((d) => (
                  <div
                    key={d.token}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 10px',
                      borderRadius: 10,
                      background: 'rgba(127,127,127,0.08)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {d.deviceName || '未命名设备'}
                        {d.current ? ' (本机)' : ''}
                      </div>
                      <div style={{ fontSize: 11, opacity: 0.6 }}>
                        最近活跃 {new Date(d.lastSeenAt).toLocaleString('zh-CN')}
                        {d.deviceId ? ` · ID ${d.deviceId.slice(0, 8)}` : ''}
                      </div>
                    </div>
                    {!d.current ? (
                      <button
                        type="button"
                        className="sync-now-button"
                        style={{ width: 'auto', margin: 0, padding: '4px 10px' }}
                        onClick={() => void handleRevoke(d.token)}
                      >
                        解绑
                      </button>
                    ) : null}
                  </div>
                ))}
                {devices.length > 1 ? (
                  <button
                    type="button"
                    className="sync-now-button"
                    style={{ width: 'auto', margin: 0, padding: '6px 12px' }}
                    onClick={() => void handleRevokeOthers()}
                  >
                    解绑其他所有设备(保留本机)
                  </button>
                ) : null}
                <div className="sync-status">可在任意设备登录,解绑不再需要的设备即可</div>
              </div>
            )}
            {msgEl}
          </>
        ) : null}
      </div>
    </div>
  )
}
