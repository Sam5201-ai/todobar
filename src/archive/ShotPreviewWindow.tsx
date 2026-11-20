/**
 * 归档截图预览覆盖窗（2026-11-19）——独立整屏透明窗口的页面组件。
 *
 * 为什么是独立窗口：主窗是小条带窗口，任何「临时放大」都会产生可见伪影
 * （tao setFullscreen 改样式=系统框闪现；setSize/setPosition=几何跳变闪屏），
 * 而晾衣绳预览完美是因为绳窗本身恒为整屏、预览零几何变化。所以预览必须在
 * 「本来就在整屏的表面」上进行：Rust 按绳窗同款参数创建本窗口（透明 + 无边框 +
 * 不进任务栏 + 不抢焦点），视觉与晾衣绳遮罩完全一致，主窗彻底零改动。
 *
 * 显示时序（防预览图闪烁）：Rust 建窗/复用时只定位不 show；本组件把图片
 * 解码完成（img onLoad）后才 invoke archive_preview_reveal 让 Rust show ——
 * 窗口出现即完整画面，配合 .apv-root 的 180ms 淡入，无空窗闪现。
 *
 * 数据链路与绳窗一字不差：clReadPreview → base64 data URL。
 * cardId 来源：挂载时 invoke archive_preview_current（首建路径，无事件竞态）；
 * 复用（hide/show）走 archive-preview-show 事件。
 * 无焦点 ⇒ 不处理键盘；Esc 由主窗 ArchiveView 监听后 invoke hide，
 * 窗口内点击空白 / ✕ 也会关。
 */
import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { clReadPreview } from '../clothesline/bridge'
import { useI18n } from '../i18n'
import './archive.css'

export default function ShotPreviewWindow() {
  const { t } = useI18n()
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  /** 每次载入新图 +1：作为 .apv-root 的 key 强制重挂载（重触发淡入动画 + img onLoad）。 */
  const [tick, setTick] = useState(0)

  const load = useCallback((cardId: string) => {
    setFailed(false)
    void clReadPreview(cardId)
      .then((url) => {
        setSrc(url)
        setTick((t) => t + 1)
      })
      .catch(() => {
        setSrc(null)
        setFailed(true)
        setTick((t) => t + 1)
      })
  }, [])

  /** 挂载即拉取待显示卡片（首建路径，规避建窗与监听挂载的竞态）。 */
  useEffect(() => {
    void invoke<string | null>('archive_preview_current')
      .then((cardId) => {
        if (cardId) load(cardId)
      })
      .catch(() => undefined)
  }, [load])

  /** 复用路径：主窗再次打开预览 → 事件携带新 cardId。 */
  useEffect(() => {
    let un: (() => void) | undefined
    void listen<string>('archive-preview-show', (e) => load(e.payload))
      .then((fn) => {
        un = fn
      })
      .catch(() => undefined)
    return () => un?.()
  }, [load])

  /** 加载失败也要 reveal（显示失败提示），否则窗口永远隐藏、点击预览无响应。 */
  useEffect(() => {
    if (failed) void invoke('archive_preview_reveal').catch(() => undefined)
  }, [failed, tick])

  const close = useCallback(() => {
    void invoke('archive_preview_hide').catch(() => undefined)
  }, [])

  return (
    <div className="apv-root" key={tick} onClick={close}>
      {src ? (
        <img
          className="apv-img"
          src={src}
          alt={t('shot.previewAlt')}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          // 图片真正解码完成的时刻：此刻 show 窗口 = 出现即完整画面（防闪烁核心）
          onLoad={() => void invoke('archive_preview_reveal').catch(() => undefined)}
        />
      ) : (
        <div className="apv-tip">{failed ? t('shot.imgLoadFail') : t('common.loading')}</div>
      )}
      <button
        type="button"
        className="apv-close"
        onClick={(e) => {
          e.stopPropagation()
          close()
        }}
        aria-label={t('clothesline.preview.closeAria')}
      >
        ✕
      </button>
      <div className="apv-hint">{t('shot.previewCloseHint')}</div>
    </div>
  )
}
