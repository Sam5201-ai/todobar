import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary'
import { hydrateIdentity } from './account'
import { I18nProvider, initI18n, t } from './i18n'

// i18n 初始化:同步部分只读 localStorage(不阻塞首帧),磁盘回灌异步补齐。
// 必须在任何渲染前执行,showFatal / ErrorBoundary 才能拿到正确语言。
initI18n()

// —— 启动兜底:任何未捕获错误 / Promise 拒绝 / 挂载超时,都在窗口里显示【可见】错误面板,
// 避免"白屏静默卡死"无法排查。窗口本身是 transparent,故错误面板用不透明背景确保看得见。
// 启动早期错误面板:此时能力表尚未加载,用 UA 仅作「数据目录文案」分流(不涉及功能门控)。
const IS_MAC_UA = /Mac/i.test(navigator.userAgent)
// 数据目录提示:路径原样保留,连接词按当前语言取词条(调用时取值,跟随语言切换)。
const dataDirHint = () =>
  IS_MAC_UA
    ? t('fatal.dataDirMac')
    : t('fatal.dataDirWin')

function showFatal(title: string, detail?: string) {
  const root = document.getElementById('root')
  if (!root) return
  if (root.childElementCount > 0) return // 已正常挂载,不覆盖
  root.style.background = '#ffffff'
  const box = document.createElement('div')
  box.style.cssText =
    'position:fixed;top:0;right:0;bottom:0;left:0;padding:24px;font:14px/1.6 system-ui,sans-serif;color:#b00;background:#fff;overflow:auto;z-index:99999'
  box.innerHTML =
    '<div style="font-weight:700;font-size:16px;margin-bottom:8px">' +
    title +
    '</div>' +
    (detail
      ? '<div style="white-space:pre-wrap;color:#333;font-family:monospace">' +
        String(detail).slice(0, 2000) +
        '</div>'
      : '') +
    '<div style="margin-top:16px;color:#555">' +
    t('fatal.hint', { os: IS_MAC_UA ? 'macOS' : 'Windows', dir: dataDirHint() }) +
    '</div>'
  root.appendChild(box)
}

window.addEventListener('error', (e) => {
  showFatal(t('fatal.title'), e.message + (e.filename ? `\n${e.filename}:${e.lineno}` : ''))
})
window.addEventListener('unhandledrejection', (e) => {
  const r = (e as PromiseRejectionEvent).reason
  showFatal(t('fatal.titlePromise'), (r && (r.stack || r.message)) || String(r))
})

// 挂载看门狗:若 12 秒内界面仍未挂载(初始化阻塞 / 卡死),给出诊断提示而非静默白屏。
window.setTimeout(() => {
  const root = document.getElementById('root')
  if (root && root.childElementCount === 0) {
    showFatal(
      t('fatal.titleTimeout'),
      t('fatal.timeoutBody', { dir: dataDirHint() }),
    )
  }
}, 12000)

// 复位 WebView 缩放:WebView2 的 Ctrl+滚轮缩放状态会持久化在用户数据目录里,
// 一旦被缩到 ≠100%,界面内容(固定 CSS 宽度)就与窗口(按物理像素计算宽)不匹配,
// 表现为主面板一侧露出空白甚至整体错位、像"打不开"。启动时强制复位为 100%,
// 配合 tauri.conf.json 的 zoomHotkeysEnabled:false 彻底禁用缩放热键,根治该问题。
void (async () => {
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    await getCurrentWebview().setZoom(1)
  } catch {
    /* 非 Tauri 环境或无权限时忽略 */
  }
})()

// 先从磁盘恢复设备身份/登录态(~/.ticktask/)再挂载主界面:
// - 设备 ID 恢复后同一台机器不会被云端当成新设备;
// - 登录态恢复后 WebView 数据丢失不再等于登出。
//
// 但若当前窗口是「牛马计薪器 · 桌面组件」(label = salary_widget),则跳过登录态恢复,
// 直接挂载轻量的 WidgetView(组件窗口不需要账号/同步,只读取本地计薪配置即可)。
void (async () => {
  let label = ''
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    label = getCurrentWindow().label
  } catch {
    /* 非 Tauri 环境(纯浏览器预览)忽略 */
  }

  // 0.4.38: salary_widget_r2..r5 是 ghost label 修复引入的动态候选 label
  // (原 label 创建失败残留死句柄时换新 label 重建),用前缀匹配一并接管。
  if (label === 'salary_widget' || label === 'salary_float' || /^salary_widget_r\d+$/.test(label)) {
    // 0.4.23 踩坑: index.css 的透明背景/去滚动条规则挂在 html[data-runtime='tauri'] 上,
    // 而该标记此前只有主窗口的 App.tsx 会打 → 组件窗口一直是 :root 的灰白底(#f7f9fb)
    // + min-width:320px 溢出滚动条,表现为组件外面套了一圈「网页框」。
    // 组件窗口在此主动打上标记,复用同一套透明规则。
    document.documentElement.dataset.runtime = 'tauri'
    const { WidgetView } = await import('./WidgetView')
    createRoot(document.getElementById('root')!).render(
      <I18nProvider>
        <StrictMode>
          <ErrorBoundary label="计薪组件">
            <WidgetView />
          </ErrorBoundary>
        </StrictMode>
      </I18nProvider>,
    )
    return
  }

  // 浏览器预览组件样式(开发自查):?widget=1&style=candy|wide|sunset。生产路径不受影响。
  if (!label && new URLSearchParams(window.location.search).get('widget') === '1') {
    document.documentElement.dataset.runtime = 'tauri'
    const { WidgetView } = await import('./WidgetView')
    createRoot(document.getElementById('root')!).render(
      <I18nProvider>
        <StrictMode>
          <ErrorBoundary label="计薪组件预览">
            <WidgetView />
          </ErrorBoundary>
        </StrictMode>
      </I18nProvider>,
    )
    return
  }

  // 0.4.39 截图/贴图(B 路线):截图覆盖层与贴图窗口均为独立轻量页面,按 label 路由。
  // - capture-overlay / pin-*:静态预热窗(tauri.conf.json 定义)或 Rust 动态建窗,
  //   与主窗 additionalBrowserArgs 一致 → 共享 WebView2 用户数据目录 → localStorage 共享。
  // - 必须打 data-runtime='tauri' 标记,复用 index.css 的透明背景规则(否则白底)。
  // - 跳过登录态恢复(截图窗口不需要账号/同步)。
  if (label === 'capture-overlay') {
    document.documentElement.dataset.runtime = 'tauri'
    // screenshot.css 的透明窗口规则挂在 html.screenshot-mode 上。
    document.documentElement.classList.add('screenshot-mode')
    const { default: CaptureOverlay } = await import('./screenshot/CaptureOverlay')
    createRoot(document.getElementById('root')!).render(
      <I18nProvider>
        <StrictMode>
          <ErrorBoundary label="截图覆盖层">
            <CaptureOverlay />
          </ErrorBoundary>
        </StrictMode>
      </I18nProvider>,
    )
    return
  }

  // 贴图穿透控制条(独立不穿透小窗):label = pinctl-<贴图label>。
  // 注意放在 /^pin-/ 判断之前更直观(pinctl- 前缀实际不匹配 /^pin-/)。
  if (label.startsWith('pinctl-')) {
    document.documentElement.dataset.runtime = 'tauri'
    document.documentElement.classList.add('screenshot-mode')
    const { default: PinControlWindow } = await import('./screenshot/PinControlWindow')
    createRoot(document.getElementById('root')!).render(
      <I18nProvider>
        <StrictMode>
          <ErrorBoundary label="贴图控制条">
            <PinControlWindow />
          </ErrorBoundary>
        </StrictMode>
      </I18nProvider>,
    )
    return
  }

  if (/^pin-/.test(label)) {
    document.documentElement.dataset.runtime = 'tauri'
    document.documentElement.classList.add('screenshot-mode')
    const { default: PinWindow } = await import('./screenshot/PinWindow')
    createRoot(document.getElementById('root')!).render(
      <I18nProvider>
        <StrictMode>
          <ErrorBoundary label="贴图窗口">
            <PinWindow />
          </ErrorBoundary>
        </StrictMode>
      </I18nProvider>,
    )
    return
  }

  // 便利签窗口:label = note-<noteId>(数据在 notes/store.ts,与主窗共享 localStorage)。
  // - 必须打 data-runtime='tauri',复用 index.css 的透明背景规则(否则白底)。
  // - 跳过 hydrateIdentity:便利签不需要账号/同步,只读本地便签数据。
  if (/^note-/.test(label)) {
    document.documentElement.dataset.runtime = 'tauri'
    const { NoteWindow } = await import('./notes/NoteWindow')
    createRoot(document.getElementById('root')!).render(
      <I18nProvider>
        <StrictMode>
          <ErrorBoundary label="便利签窗口">
            <NoteWindow />
          </ErrorBoundary>
        </StrictMode>
      </I18nProvider>,
    )
    return
  }

  // 顶部晾衣绳窗口:label = clothesline(Rust 动态建窗,见 src-tauri/src/clothesline.rs)。
  // - 必须打 data-runtime='tauri',复用 index.css 透明背景规则(否则白底横幅)。
  // - 跳过 hydrateIdentity:绳窗只读本地晾衣绳数据,不需要账号/同步。
  // - ★R63:绳窗是透明置顶层,若动态 import / 挂载失败,showFatal 会在屏幕顶部刷出
  //   一块刺眼白横幅。这里在失败时塞一个透明占位节点(childElementCount>0),
  //   让 showFatal 的「已有内容则跳过」守卫与 12s 看门狗都不触发,失败静默化并只写日志。
  if (label === 'clothesline') {
    document.documentElement.dataset.runtime = 'tauri'
    document.documentElement.classList.add('clothesline-mode')
    const keepTransparentOnFailure = () => {
      const root = document.getElementById('root')
      if (root && root.childElementCount === 0) {
        const holder = document.createElement('div')
        holder.style.cssText = 'position:fixed;inset:0;pointer-events:none;background:transparent'
        root.appendChild(holder)
      }
    }
    try {
      const { ClotheslineView, ClotheslineErrorBoundary } = await import('./clothesline/ClotheslineView')
      createRoot(document.getElementById('root')!).render(
        <I18nProvider>
          <StrictMode>
            <ClotheslineErrorBoundary>
              <ClotheslineView />
            </ClotheslineErrorBoundary>
          </StrictMode>
        </I18nProvider>,
      )
    } catch (e) {
      keepTransparentOnFailure()
      console.error('[clothesline] 模块加载失败', e)
    }
    return
  }

  // 剪贴板历史浮窗:label = clipboard(Rust 后台线程监听 + 快捷键唤起,见 src-tauri/src/clipboard.rs)。
  // - 必须打 data-runtime='tauri',复用 index.css 的透明背景规则(否则白底)。
  // - 跳过 hydrateIdentity:剪贴板浮窗不需要账号 / 同步,只读本地剪贴板历史文件。
  if (label === 'clipboard') {
    document.documentElement.dataset.runtime = 'tauri'
    const { ClipboardView } = await import('./ClipboardView')
    createRoot(document.getElementById('root')!).render(
      <I18nProvider>
        <StrictMode>
          <ErrorBoundary label="剪贴板历史浮窗">
            <ClipboardView />
          </ErrorBoundary>
        </StrictMode>
      </I18nProvider>,
    )
    return
  }

  // 全局速记（随手记）录入窗:label = quick-note(Rust 动态建窗,见 src-tauri/src/quick_note.rs)。
  // - 必须打 data-runtime='tauri',复用 index.css 透明背景规则(否则白底)。
  // - 跳过 hydrateIdentity:录入窗只读本地账号态 + 晾衣绳数据,不依赖主窗同步。
  if (label === 'quick-note') {
    document.documentElement.dataset.runtime = 'tauri'
    const { default: QuickNoteWindow } = await import('./quickNote/QuickNoteWindow')
    createRoot(document.getElementById('root')!).render(
      <I18nProvider>
        <StrictMode>
          <ErrorBoundary label="随手记录入窗">
            <QuickNoteWindow />
          </ErrorBoundary>
        </StrictMode>
      </I18nProvider>,
    )
    return
  }

  // 归档截图预览覆盖窗:label = archive-preview(Rust 按绳窗同款参数动态建窗,
  // 见 src-tauri/src/lib.rs archive_preview_show)。透明整屏遮罩 + 居中大图,
  // 视觉与晾衣绳预览完全一致;主窗零改动 ⇒ 工具窗完全静止。
  // - 必须打 data-runtime='tauri',复用 index.css 透明背景规则(否则白底)。
  // - 跳过 hydrateIdentity:预览窗只读截图预览数据。
  if (label === 'archive-preview') {
    document.documentElement.dataset.runtime = 'tauri'
    const { default: ShotPreviewWindow } = await import('./archive/ShotPreviewWindow')
    createRoot(document.getElementById('root')!).render(
      <I18nProvider>
        <StrictMode>
          <ErrorBoundary label="归档截图预览">
            <ShotPreviewWindow />
          </ErrorBoundary>
        </StrictMode>
      </I18nProvider>,
    )
    return
  }

  await hydrateIdentity()
  // 截图/贴图设置:必须在 React 挂载**之前**从磁盘(~/.ticktask/screenshot-settings.json)
  // 恢复到 localStorage。此前在 App 挂载后的 effect 里恢复,设置面板的
  // useState(() => getSettings()) 初值可能读到空/旧缓存而显示「停用」,
  // 而快捷键按磁盘值注册 → 「面板显示停用、快捷键却可用」的不同步(用户复报两次)。
  try {
    const { hydrateSettings } = await import('./screenshot/store')
    await hydrateSettings()
  } catch {
    /* best-effort:失败时 App effect 内仍会重试 */
  }
  createRoot(document.getElementById('root')!).render(
    <I18nProvider>
      <StrictMode>
        <ErrorBoundary label="主界面">
          <App />
        </ErrorBoundary>
      </StrictMode>
    </I18nProvider>,
  )
})().catch((e) => showFatal(t('fatal.initFailed'), (e && (e.stack || e.message)) || String(e)))
