/**
 * 设置页「通用」区块:界面语言 + 地区切换器(P0 新增)。
 *
 * - 语言/地区存独立 key(prefs.json 的 locale/region + localStorage todobar.i18n.v1),
 *   不进 SidebarSettings v19 —— 与现有设置体系互不干扰;
 * - 切换即时生效:setLocale/setRegion 更新 i18n 单例 → Provider 重渲染本窗,
 *   并经 localStorage/storage 事件同步其余 8 个窗口,无需重启;
 * - 地区下拉仅切换地区轴(节假日/黄历/货币默认值),不影响语言轴,两轴正交。
 */

import { LOCALES, REGIONS, t, useI18n, type Locale, type LocaleKey, type Region } from './i18n'

const LOCALE_LABEL: Record<Locale, LocaleKey> = {
  'zh-CN': 'lang.zh-CN',
  'zh-TW': 'lang.zh-TW',
  en: 'lang.en',
  ja: 'lang.ja',
  ko: 'lang.ko',
}

const REGION_LABEL: Record<Region, LocaleKey> = {
  CN: 'region.CN',
  TW: 'region.TW',
  JP: 'region.JP',
  KR: 'region.KR',
  US: 'region.US',
  GLOBAL: 'region.GLOBAL',
}

export function GeneralSetting() {
  const { locale, region, setLocale, setRegion } = useI18n()

  return (
    <div className="settings-group" title={t('settings.general.hint')}>
      <div className="settings-group-title">{t('settings.group.general')}</div>
      <div className="labeled-select">
        <span>{t('settings.general.language')}</span>
        <select
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
          aria-label={t('settings.general.language')}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(LOCALE_LABEL[l])}
            </option>
          ))}
        </select>
      </div>
      <div className="labeled-select">
        <span>{t('settings.general.region')}</span>
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value as Region)}
          aria-label={t('settings.general.region')}
        >
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {t(REGION_LABEL[r])}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
