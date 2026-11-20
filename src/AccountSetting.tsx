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
  warmDeviceFingerprint,
  AUTH_INVALID_EVENT,
  ACCOUNT_CHANGED_EVENT,
  type AccountState,
  type DeviceInfo,
} from './account'
import { AUTH_BASE } from './account'
import { openUrl } from '@tauri-apps/plugin-opener'
import { t, useI18n } from './i18n'

// 会员购买:链动小铺激活码商品页(系统浏览器打开,capabilities 已白名单该域名)
const PURCHASE_URL = 'https://wzyp.cn/item/w5s7m5'

type ModalView = 'auth' | 'password' | 'devices' | null

// ---------------------------------------------------------------------------
// 「记住账号」(多账号):勾选状态下成功登录的账号密码进入本地列表,下次打开
// 登录弹窗默认带出最近登录的一个;点击邮箱输入框可从下拉列表切换历史账号。
// 取消勾选提交 = 不记住(或移除)该账号,其余账号保留。明文仅存本机。
// ---------------------------------------------------------------------------

const SAVED_LOGINS_KEY = 'todobar.savedLogins'
const LEGACY_SAVED_LOGIN_KEY = 'todobar.savedLogin' // 旧版单账号存储,读取时迁移
const LAST_LOGIN_EMAIL_KEY = 'todobar.lastLoginEmail'

type SavedLogin = { email: string; password: string; savedAt: number }

function readSavedLogins(): SavedLogin[] {
  try {
    const raw = localStorage.getItem(SAVED_LOGINS_KEY)
    if (raw) {
      const v = JSON.parse(raw) as unknown
      if (!Array.isArray(v)) return []
      return v.filter(
        (x): x is SavedLogin =>
          !!x && typeof (x as SavedLogin).email === 'string' && typeof (x as SavedLogin).password === 'string',
      )
    }
    // 旧版单账号记录 → 迁移成列表(一次性)
    const legacy = localStorage.getItem(LEGACY_SAVED_LOGIN_KEY)
    if (legacy) {
      localStorage.removeItem(LEGACY_SAVED_LOGIN_KEY)
      const v = JSON.parse(legacy) as { email?: unknown; password?: unknown }
      if (typeof v.email === 'string' && typeof v.password === 'string') {
        const list = [{ email: v.email, password: v.password, savedAt: 0 }]
        writeSavedLogins(list)
        return list
      }
    }
    return []
  } catch {
    return []
  }
}

function writeSavedLogins(list: SavedLogin[]): void {
  try {
    localStorage.setItem(SAVED_LOGINS_KEY, JSON.stringify(list))
  } catch {
    /* 忽略 */
  }
}

function readLastLoginEmail(): string {
  try {
    return localStorage.getItem(LAST_LOGIN_EMAIL_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

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
        reject(new Error(t('account.canvasError')))
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
      reject(new Error(t('account.imageReadError')))
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
  /** 邮箱历史下拉:透传给 input 的焦点/点击事件。 */
  onInputFocus?: () => void
  onInputBlur?: () => void
  onInputClick?: () => void
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
        onFocus={props.onInputFocus}
        onBlur={props.onInputBlur}
        onClick={props.onInputClick}
      />
    </label>
  )
}

export function AccountSetting({
  onSyncChange,
  onSwitchProfile,
}: {
  onSyncChange: (patch: Partial<import('./types').SyncConfig>) => void
  /** 登录成功后切换到该账号的独立本地库(账号数据隔离),返回并入的游客数据条数。 */
  onSwitchProfile?: (email: string) => Promise<number>
}) {
  const { t } = useI18n()
  const [account, setAccount] = useState<AccountState | null>(() => loadAccount())
  const [modalView, setModalView] = useState<ModalView>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [editingNick, setEditingNick] = useState(false)
  const [nickDraft, setNickDraft] = useState('')
  const [codeDraft, setCodeDraft] = useState('')
  const [showLogout, setShowLogout] = useState(false)
  const [purchaseOpen, setPurchaseOpen] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  // 令牌失效(云端 401:密码修改/设备被解绑/会话过期)时,账号区立即回到未登录态,
  // 避免出现「显示已登录但同步/设备接口全部 401」的僵尸登录态(0.2.9 修复)。
  useEffect(() => {
    const onInvalid = () => setAccount(null)
    window.addEventListener(AUTH_INVALID_EVENT, onInvalid)
    return () => window.removeEventListener(AUTH_INVALID_EVENT, onInvalid)
  }, [])

  // 登录态变更(任意入口登录/激活/登出)时,账号区同步刷新,避免「已登录但设置页仍显示未登录」的割裂。
  useEffect(() => {
    const onChanged = () => setAccount(loadAccount())
    window.addEventListener(ACCOUNT_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, onChanged)
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
      setMsg({ kind: 'ok', text: t('account.redeemOk') })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || t('account.redeemFail') })
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout() {
    setBusy(true)
    // 先关同步再调登出接口:logout 会使服务端会话立即作废,若等它返回后才关同步,
    // 窗口期内的定时/防抖同步会拿着已失效的令牌推送 → 401 → 误弹「同步失败」提示。
    onSyncChange({ enabled: false, token: '' })
    try {
      await logout()
    } catch {
      /* 忽略 */
    } finally {
      setAccount(null)
      setModalView(null)
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
      setMsg({ kind: 'ok', text: t('account.avatarSaved') })
      void updateProfile({ avatar: dataUrl })
        .then((next) => {
          setAccount(next)
          setMsg({ kind: 'ok', text: t('account.avatarUpdated') })
        })
        .catch((e) => setMsg({ kind: 'err', text: t('account.cloudSyncFail', { message: (e as Error).message }) }))
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
      setMsg({ kind: 'ok', text: t('account.nickSaved') })
      // ② 云端静默同步(异步)。
      void updateProfile({ nickname: n })
        .then((next) => {
          setAccount(next)
          setMsg({ kind: 'ok', text: t('account.nickUpdated') })
        })
        .catch((e) => setMsg({ kind: 'err', text: t('account.cloudSyncFail', { message: (e as Error).message }) }))
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
      {/* 会员购买横幅:仅非会员(含试用中/未登录)显示,会员状态不渲染 */}
      {!account?.activated ? (
        <button
          type="button"
          className="vip-marquee"
          aria-label={t('account.marqueeAria')}
          onClick={() => setPurchaseOpen(true)}
        >
          <span className="vip-marquee-track">
            <span className="vip-marquee-text">{t('account.marquee')}</span>
            <span className="vip-marquee-text" aria-hidden="true">
              {t('account.marquee')}
            </span>
          </span>
        </button>
      ) : null}
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
              title={t('account.changeAvatarTitle')}
              onClick={() => avatarInputRef.current?.click()}
            >
              <img src={account.avatar || defaultAvatar} alt={t('account.avatarAlt')} />
            </button>
            {editingNick ? (
              <div className="account-nick-edit">
                <input
                  value={nickDraft}
                  maxLength={24}
                  autoFocus
                  placeholder={t('account.nickPlaceholder')}
                  onChange={(e) => setNickDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveNickname()
                    if (e.key === 'Escape') setEditingNick(false)
                  }}
                />
                <button type="button" onClick={() => void saveNickname()} disabled={busy}>
                  {t('common.save')}
                </button>
                <button type="button" onClick={() => setEditingNick(false)}>
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="account-nick"
                title={t('account.editNickTitle')}
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
                ? t('account.activatedFull')
                : account.trialEndsAt
                  ? t('account.trialDaysLeft', { days: Math.max(0, Math.ceil((Date.parse(account.trialEndsAt) - Date.now()) / 86_400_000)) })
                  : ''}
            </div>
            {!account.activated && (
              <div className="account-redeem">
                <input
                  value={codeDraft}
                  maxLength={40}
                  placeholder={t('account.codeInputPlaceholder')}
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
                  {t('account.redeem')}
                </button>
                <button
                  type="button"
                  className="account-redeem-buy"
                  onClick={() => setPurchaseOpen(true)}
                  disabled={busy}
                >
                  {t('account.buyCode')}
                </button>
              </div>
            )}
            <div className="account-actions">
              <button type="button" onClick={() => setModalView('password')} disabled={busy}>
                {t('account.changePassword')}
              </button>
              <button type="button" onClick={() => setModalView('devices')} disabled={busy}>
                {t('device.short')}
              </button>
              <button type="button" onClick={() => setShowLogout(true)} disabled={busy}>
                {t('account.logout')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="account-avatar-static">
              <img src={defaultAvatar} alt={t('account.defaultAvatarAlt')} />
            </div>
            <div className="account-nick">{t('store.notLoggedIn')}</div>
            <div className="account-email">{t('account.loggedOutHint')}</div>
            <div className="account-actions">
              <button type="button" onClick={() => setModalView('auth')}>
                {t('login.title')}
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
            aria-label={t('account.logoutConfirmAria')}
            style={{ maxWidth: 320 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="account-modal-head">
              <strong>{t('account.logout')}</strong>
              <button
                type="button"
                className="account-modal-close"
                onClick={() => setShowLogout(false)}
                aria-label={t('common.close')}
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
              {t('account.logoutBody')}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" className="account-link" onClick={() => setShowLogout(false)}>
                {t('common.cancel')}
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
                {t('account.logoutConfirm')}
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
            void (async () => {
              // 先切到该账号的独立本地库(首次登录会把游客数据并入),再开同步:
              // 保证云端补齐落在正确的库,换账号登录后互不见对方数据、绝不互传。
              try {
                const migrated = (await onSwitchProfile?.(acc.email)) ?? 0
                if (migrated > 0) setMsg({ kind: 'ok', text: t('sync.mergedLocal', { count: migrated }) })
              } catch (e) {
                setMsg({ kind: 'err', text: t('account.switchFail', { message: (e as Error).message }) })
              }
              onSyncChange({ enabled: true, endpoint: AUTH_BASE, token: acc.token })
            })()
          }}
          onPasswordChanged={() => {
            setAccount(null)
            setModalView('auth')
            onSyncChange({ enabled: false, token: '' })
          }}
        />
      ) : null}

      {/* 会员购买底部弹窗:横幅与「购买激活码」按钮共用;会员升级后自动消失 */}
      {purchaseOpen && !account?.activated ? (
        <PurchaseSheet onClose={() => setPurchaseOpen(false)} />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// 会员购买底部弹窗:价格 + 权益 + 激活步骤;「立即购买」在系统浏览器打开
// 链动小铺商品页(弹窗保持打开,用户买完回来直接兑换)。关闭动画与通用
// sheet 一致:is-closing + 190ms 后卸载。
// ---------------------------------------------------------------------------

// 会员权益对比:三列列表(功能 / 普通用户 / 永久会员),每行只写差异,不再堆长句。
// 数值与代码闸门保持一致:受限用户每日 3 条主任务(account.ts FREE_DAILY_TASK_LIMIT),
// 其余条目均为 fullAccess 限定的能力;桌面套件四项各自独立成行。
interface VipBenefit {
  name: string
  free: string
  member: string
}

/** 会员权益对比行文案:随语言变化,渲染时按当前语言取词条。 */
function vipBenefits(): VipBenefit[] {
  return [
    { name: t('account.benefit.dailyTasks'), free: t('account.benefit.free3PerDay'), member: t('account.benefit.unlimited') },
    { name: t('account.benefit.subtaskRemind'), free: t('account.benefit.unavailable'), member: t('account.benefit.supported') },
    { name: t('account.benefit.birthdayAnniversary'), free: t('account.benefit.viewOnly'), member: t('account.benefit.unlimitedAdd') },
    { name: t('account.benefit.salaryWidget'), free: t('account.benefit.unavailable'), member: t('account.benefit.available') },
    { name: t('account.benefit.screenshotPin'), free: t('account.benefit.unavailable'), member: t('account.benefit.available') },
    { name: t('feature.clipboard'), free: t('account.benefit.unavailable'), member: t('account.benefit.available') },
    { name: t('feature.note'), free: t('account.benefit.unavailable'), member: t('account.benefit.available') },
    { name: t('account.benefit.recorder'), free: t('account.benefit.unavailable'), member: t('account.benefit.available') },
    { name: t('feature.cloudSync'), free: t('account.benefit.unavailable'), member: t('account.benefit.autoSync') },
  ]
}

/** 对比列表的行标记:绿色勾 = 会员可用,灰色叉 = 受限状态。 */
function VipMark({ ok }: { ok: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ok ? 2.8 : 2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ok ? 'M20 6 9 17l-5-5' : 'M18 6 6 18M6 6l12 12'} />
    </svg>
  )
}

/** 激活步骤文案:随语言变化,渲染时按当前语言取词条。 */
function vipSteps(): string[] {
  return [t('account.vipStep1'), t('account.vipStep2'), t('account.vipStep3')]
}

function PurchaseSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const [opening, setOpening] = useState(false)
  const [err, setErr] = useState('')

  function requestClose() {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    window.setTimeout(onClose, 190)
  }

  async function handleBuy() {
    if (opening) return
    setErr('')
    setOpening(true)
    try {
      await openUrl(PURCHASE_URL)
    } catch (e) {
      setErr(t('account.openBrowserFail', { message: (e as Error).message }))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div
      className={`sheet-backdrop ${closing ? 'is-closing' : ''}`}
      onClick={requestClose}
      role="presentation"
    >
      <div
        className={`sheet vip-sheet ${closing ? 'is-closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('account.vipSheetTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <button type="button" className="vip-sheet-close" onClick={requestClose} aria-label={t('common.close')}>
          ✕
        </button>
        <div className="sheet-title">{t('account.vipSheetTitle')}</div>

        {/* 权益明细变长后只在内容区滚动,「立即购买」始终吸底可见。 */}
        <div className="vip-sheet-scroll">
          <div className="vip-price">
            <span className="vip-price-num">￥29.9</span>
            <span className="vip-price-note">{t('account.vipPriceNote')}</span>
          </div>

          <div className="vip-benefits" role="table" aria-label={t('account.vipCompareAria')}>
            <div className="vip-cmp-head" role="row">
              <span role="columnheader">{t('account.vipColFeature')}</span>
              <span role="columnheader">{t('account.vipColFree')}</span>
              <span className="vip-cmp-head-member" role="columnheader">{t('account.vipColMember')}</span>
            </div>
            {vipBenefits().map((b) => (
              <div className="vip-cmp-row" role="row" key={b.name}>
                <span className="vip-cmp-name" role="cell">{b.name}</span>
                <span className="vip-cmp-free" role="cell">
                  <VipMark ok={false} />
                  {b.free}
                </span>
                <span className="vip-cmp-member" role="cell">
                  <VipMark ok />
                  {b.member}
                </span>
              </div>
            ))}
            <div className="vip-cmp-foot" role="row">
              <span role="cell">{t('account.vipMoreBenefits')}</span>
            </div>
          </div>

          <div className="vip-steps">
            <div className="vip-steps-title">{t('account.vipHowToActivate')}</div>
            {vipSteps().map((s, i) => (
              <div key={s} className="vip-step">
                <span className="vip-step-num">{i + 1}</span>
                <span>{s}</span>
              </div>
            ))}
          </div>

          {err ? <div className="vip-sheet-err">{err}</div> : null}
        </div>

        <button type="button" className="vip-buy-btn" onClick={() => void handleBuy()} disabled={opening}>
          {opening ? t('account.opening') : t('account.buyNow')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 弹窗:登录/注册(双 tab + 找回密码)/ 修改密码 / 设备管理
// ---------------------------------------------------------------------------

export function AccountModal({
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
  const { t } = useI18n()
  // auth 表单
  const [tab, setTab] = useState<'login' | 'register'>(account ? 'login' : 'login')
  // 「记住账号」(多账号):默认带出最近一次登录的账号;邮箱框点击可下拉切换历史账号。
  const [savedLogins] = useState(readSavedLogins)
  const [email, setEmail] = useState(() => {
    const last = readLastLoginEmail()
    if (last) return last
    return readSavedLogins()[0]?.email ?? account?.email ?? ''
  })
  const [password, setPassword] = useState(() => {
    const chosen = readLastLoginEmail() || readSavedLogins()[0]?.email || account?.email || ''
    return readSavedLogins().find((x) => x.email === chosen)?.password ?? ''
  })
  const [remember, setRemember] = useState(() => {
    const chosen = readLastLoginEmail() || readSavedLogins()[0]?.email || account?.email || ''
    return readSavedLogins().some((x) => x.email === chosen)
  })
  const [showSaved, setShowSaved] = useState(false)
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState<string | null>(null)
  const [code, setCode] = useState('')
  // 通用
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [countdown, setCountdown] = useState(0)
  // 设备管理
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)

  // 弹窗打开即预取设备指纹(reg query 子进程较慢),登录/注册时直接取缓存,省去串行等待;
  // 同时预热到云端的 DNS/TLS 连接:国内链路冷启动握手要 0.5~2s,预热后真正提交登录
  // 走已建好的连接,实测接口本身只需 ~1s(几乎全是网络往返,服务端处理可忽略)。
  useEffect(() => {
    warmDeviceFingerprint()
    void fetch(`${AUTH_BASE}/api/health`, { keepalive: true }).catch(() => {})
  }, [])

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
      setMsg({ kind: 'err', text: t('account.errEmailRequired') })
      return
    }
    if (countdown > 0) return
    setBusy(true)
    try {
      await sendCode(email, purpose)
      setCountdown(60)
      setMsg({ kind: 'ok', text: t('account.codeSent') })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function handleSubmitAuth() {
    setMsg(null)
    if (!email || !password) {
      setMsg({ kind: 'err', text: t('account.errEmailPassRequired') })
      return
    }
    if (tab === 'register' && !code) {
      setMsg({ kind: 'err', text: t('account.errCodeRequired') })
      return
    }
    setBusy(true)
    try {
      const acc =
        tab === 'register'
          ? await register(email, password, code, nickname.trim() || undefined, avatar)
          : await login(email, password)
      // 成功后按勾选状态更新记住列表:勾选 = 记住/刷新该账号(置顶),取消 = 移除该账号。
      const em = email.trim()
      const list = readSavedLogins().filter((x) => x.email !== em)
      if (remember && password) list.unshift({ email: em, password, savedAt: Date.now() })
      writeSavedLogins(list)
      try {
        localStorage.setItem(LAST_LOGIN_EMAIL_KEY, em)
      } catch {
        /* 忽略 */
      }
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
      setMsg({ kind: 'err', text: t('account.errAllRequired') })
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
        t('device.revokeConfirm'),
      )
    )
      return
    try {
      await revokeOtherDevices()
      fetchDevices()
        .then((d) => setDevices(d.devices))
        .catch(() => setDevices([]))
      setMsg({ kind: 'ok', text: t('device.revokeOthersDone') })
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
      ? t('account.changePassword')
      : view === 'devices'
        ? t('device.manage')
        : tab === 'login'
          ? t('account.loginTitle')
          : t('account.registerTitle')

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
          <button type="button" className="account-modal-close" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>

        {view === 'auth' ? (
          <>
            <div className="segmented-control" aria-label={t('account.authTabsAria')}>
              <button
                type="button"
                className={tab === 'login' ? 'is-selected' : ''}
                onClick={() => {
                  setTab('login')
                  setMsg(null)
                }}
              >
                {t('login.title')}
              </button>
              <button
                type="button"
                className={tab === 'register' ? 'is-selected' : ''}
                onClick={() => {
                  setTab('register')
                  setMsg(null)
                }}
              >
                {t('account.registerTab')}
              </button>
            </div>
            {tab === 'register' ? (
              <div className="account-reg-top">
                <button
                  type="button"
                  className="account-avatar-btn account-avatar-sm"
                  title={t('account.avatarOptionalTitle')}
                  onClick={() => document.getElementById('account-avatar-input')?.click()}
                >
                  <img src={avatar ?? defaultAvatar} alt={t('account.avatarAlt')} />
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
                  placeholder={t('account.nickOptionalPlaceholder')}
                  onChange={(e) => setNickname(e.target.value)}
                />
              </div>
            ) : null}
            {tab === 'login' && savedLogins.length > 0 ? (
              <div style={{ position: 'relative' }}>
                <Field
                  label={t('account.emailLabel')}
                  value={email}
                  placeholder="you@example.com"
                  onChange={setEmail}
                  onInputFocus={() => setShowSaved(true)}
                  onInputClick={() => setShowSaved(true)}
                  onInputBlur={() => window.setTimeout(() => setShowSaved(false), 120)}
                />
                {showSaved ? (
                  <div className="account-saved-pop">
                    {savedLogins.map((s) => (
                      <button
                        key={s.email}
                        type="button"
                        className={`account-saved-item${s.email === email.trim() ? ' is-active' : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          // 选中历史账号:带出该账号记住的密码并自动勾选。
                          setEmail(s.email)
                          setPassword(s.password)
                          setRemember(true)
                          setShowSaved(false)
                        }}
                      >
                        <span>{s.email}</span>
                        {s.email === email.trim() ? <span className="account-saved-check">{t('account.currentTag')}</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <Field label={t('account.emailLabel')} value={email} placeholder="you@example.com" onChange={setEmail} />
            )}
            <Field
              label={t('account.passwordLabel')}
              type="password"
              value={password}
              placeholder={t('account.passwordPlaceholder')}
              onChange={setPassword}
            />
            {tab === 'login' ? (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 13,
                  margin: '-2px 0 0',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                {t('account.rememberMe')}
              </label>
            ) : null}
            {tab === 'register' ? (
              <div className="account-code-row">
                <Field label={t('account.codeLabel')} value={code} placeholder={t('account.codePlaceholder')} onChange={setCode} />
                <button
                  type="button"
                  className="sync-now-button account-code-btn"
                  onClick={() => void handleSendCode('register')}
                  disabled={busy || countdown > 0}
                >
                  {countdown > 0 ? `${countdown}s` : t('account.getCode')}
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="sync-now-button"
              onClick={handleSubmitAuth}
              disabled={busy}
            >
              {busy ? t('dataDir.busy') : tab === 'register' ? t('account.registerAndLogin') : t('login.title')}
            </button>
            <button
              type="button"
              className="account-link"
              onClick={() => {
                setTab('login')
                onOpenReset()
              }}
            >
              {t('account.forgotPassword')}
            </button>
            <div className="sync-status" style={{ fontSize: 11 }}>
              {t('account.loginHint')}
            </div>
            {msgEl}
          </>
        ) : null}

        {view === 'password' ? (
          <>
            <Field label={t('account.emailLabel')} value={email} placeholder={t('account.registeredEmailPlaceholder')} onChange={setEmail} />
            <div className="account-code-row">
              <Field label={t('account.codeLabel')} value={code} placeholder={t('account.codePlaceholder')} onChange={setCode} />
              <button
                type="button"
                className="sync-now-button account-code-btn"
                onClick={() => void handleSendCode('reset')}
                disabled={busy || countdown > 0}
              >
                {countdown > 0 ? `${countdown}s` : t('account.getCode')}
              </button>
            </div>
            <Field
              label={t('account.newPasswordLabel')}
              type="password"
              value={password}
              placeholder={t('account.passwordPlaceholder')}
              onChange={setPassword}
            />
            <button
              type="button"
              className="sync-now-button"
              onClick={handlePassword}
              disabled={busy}
            >
              {busy ? t('feedback.submitting') : t('account.confirmChange')}
            </button>
            <div className="sync-status" style={{ fontSize: 11 }}>
              {t('account.passwordChangedHint')}
            </div>
            {msgEl}
          </>
        ) : null}

        {view === 'devices' ? (
          <>
            {devices === null ? (
              <div className="sync-status">{t('common.loading')}</div>
            ) : devices.length === 0 ? (
              <div className="sync-status">{t('device.empty')}</div>
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
                        {d.deviceName || t('device.untitled')}
                        {d.current ? t('device.currentSuffix') : ''}
                      </div>
                      <div style={{ fontSize: 11, opacity: 0.6 }}>
                        {t('device.lastActive', { time: new Date(d.lastSeenAt).toLocaleString('zh-CN') })}
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
                        {t('device.revoke')}
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
                    {t('device.revokeOthers')}
                  </button>
                ) : null}
                <div className="sync-status">{t('device.hint')}</div>
              </div>
            )}
            {msgEl}
          </>
        ) : null}
      </div>
    </div>
  )
}
