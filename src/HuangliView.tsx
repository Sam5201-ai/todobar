import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { getMonthCells, getHuangliDetail, hlKey, type HlCell, type HlDetail } from './huangli'
import { useI18n, type LocaleKey } from './i18n'

/** 周表头(周一→周日,渲染期 t() 取词)。 */
const WEEK_HEADERS: LocaleKey[] = ['huangli.week.1', 'huangli.week.2', 'huangli.week.3', 'huangli.week.4', 'huangli.week.5', 'huangli.week.6', 'huangli.week.7']

/** 用中文数字渲染年份/月份选择器选项。 */
function yearOptions(): number[] {
  const now = new Date().getFullYear()
  const out: number[] = []
  for (let y = now - 30; y <= now + 30; y++) out.push(y)
  return out
}

/**
 * 黄历页:月份筛选 + 月历(节假日/节气/农历) + 选中日期的万年历详情。
 * 自包含组件,工具栏用 sticky 固定在滚动区顶部。
 */
export function HuangliView() {
  const { t, locale } = useI18n()
  const now = new Date()
  const todayKey = hlKey(now.getFullYear(), now.getMonth() + 1, now.getDate())
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 })
  const [selectedKey, setSelectedKey] = useState(todayKey)

  const cells = useMemo(() => getMonthCells(cursor.year, cursor.month, todayKey), [cursor, todayKey])
  const detail: HlDetail = useMemo(() => {
    const [y, m, d] = selectedKey.split('-').map(Number)
    return getHuangliDetail(y, m, d)
  }, [selectedKey, locale])

  const shiftMonth = (delta: number) => {
    setCursor((c) => {
      const d = new Date(c.year, c.month - 1 + delta, 1)
      return { year: d.getFullYear(), month: d.getMonth() + 1 }
    })
  }
  const gotoToday = () => {
    setCursor({ year: now.getFullYear(), month: now.getMonth() + 1 })
    setSelectedKey(todayKey)
  }
  const selectFromKey = (key: string) => {
    setSelectedKey(key)
    const [y, m] = key.split('-').map(Number)
    if (y !== cursor.year || m !== cursor.month) setCursor({ year: y, month: m })
  }

  return (
    <div className="huangli-view">
      {/* 工具栏:年月筛选 + 回到今天 */}
      <div className="hl-toolbar">
        <div className="hl-nav-group">
          <button type="button" className="hl-nav-btn" aria-label={t('huangli.prevYear')} onClick={() => setCursor((c) => ({ ...c, year: c.year - 1 }))}>
            <ChevronLeft size={13} />
          </button>
          <select
            className="hl-select"
            value={cursor.year}
            onChange={(e) => setCursor((c) => ({ ...c, year: Number(e.target.value) }))}
            aria-label={t('huangli.selectYear')}
          >
            {yearOptions().map((y) => (
              <option key={y} value={y}>
                {t('huangli.yearOption', { n: y })}
              </option>
            ))}
          </select>
          <button type="button" className="hl-nav-btn" aria-label={t('huangli.nextYear')} onClick={() => setCursor((c) => ({ ...c, year: c.year + 1 }))}>
            <ChevronRight size={13} />
          </button>
        </div>
        <div className="hl-nav-group">
          <button type="button" className="hl-nav-btn" aria-label={t('huangli.prevMonth')} onClick={() => shiftMonth(-1)}>
            <ChevronLeft size={13} />
          </button>
          <select
            className="hl-select"
            value={cursor.month}
            onChange={(e) => setCursor((c) => ({ ...c, month: Number(e.target.value) }))}
            aria-label={t('huangli.selectMonth')}
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {t('huangli.monthOption', { n: m })}
              </option>
            ))}
          </select>
          <button type="button" className="hl-nav-btn" aria-label={t('huangli.nextMonth')} onClick={() => shiftMonth(1)}>
            <ChevronRight size={13} />
          </button>
        </div>
        <button type="button" className="hl-today-btn" onClick={gotoToday}>
          {t('huangli.today')}
        </button>
      </div>

      {/* 月历 */}
      <div className="hl-grid" role="grid" aria-label={t('huangli.gridAria', { y: cursor.year, m: cursor.month })}>
        <div className="hl-grid-title">
          {t('huangli.yearMonth', { y: cursor.year, m: cursor.month })}
        </div>
        <div className="hl-week-row">
          {WEEK_HEADERS.map((w, i) => (
            <div key={w} className={`hl-week-cell ${i >= 5 ? 'is-weekend' : ''}`}>
              {t(w)}
            </div>
          ))}
        </div>
        <div className="hl-day-grid">
          {cells.map((cell, i) =>
            cell ? (
              <DayCell key={cell.key} cell={cell} selected={cell.key === selectedKey} onSelect={() => selectFromKey(cell.key)} />
            ) : (
              <div key={`blank-${i}`} className="hl-cell is-blank" />
            ),
          )}
        </div>
      </div>

      {/* 选中日期的万年历详情 */}
      <DetailPanel detail={detail} isToday={detail.key === todayKey} />
    </div>
  )
}

function DayCell({ cell, selected, onSelect }: { cell: HlCell; selected: boolean; onSelect: () => void }) {
  const { t } = useI18n()
  const numCls = cell.badgeLegal || cell.weekend ? 'is-red' : ''
  return (
    <button
      type="button"
      role="gridcell"
      className={`hl-cell ${cell.weekend ? 'is-weekend' : ''} ${cell.badgeLegal ? 'is-legal' : ''} ${
        cell.today ? 'is-today' : ''
      } ${selected ? 'is-selected' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${cell.key}${cell.sub}`}
    >
      {cell.badge && (
        <i className={`hl-badge ${cell.badge === 'work' ? 'is-work' : cell.badgeLegal ? 'is-legal' : 'is-rest'}`}>
          {cell.badge === 'work' ? t('huangli.badge.work') : t('huangli.badge.rest')}
        </i>
      )}
      <strong className={`hl-day-num ${numCls}`}>{cell.day}</strong>
      <span className={`hl-sub type-${cell.subType}`}>{cell.sub}</span>
    </button>
  )
}

function TagRow({ label, tags, tone }: { label: string; tags: string[]; tone: 'good' | 'bad' | 'info' }) {
  if (tags.length === 0) return null
  return (
    <div className="hl-tag-row">
      <i className={`hl-tag-label tone-${tone}`}>{label}</i>
      <div className="hl-tags">
        {tags.map((t) => (
          <span key={t} className={`hl-tag tone-${tone}`}>
            {t}
          </span>
        ))}
      </div>
    </div>
  )
}

function InfoItem({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  if (!value) return null
  return (
    <div className={`hl-info-item ${wide ? 'is-wide' : ''}`}>
      <i className="hl-info-label">{label}</i>
      <span className="hl-info-value">{value}</span>
    </div>
  )
}

function DetailPanel({ detail, isToday }: { detail: HlDetail; isToday: boolean }) {
  const { t } = useI18n()
  // 星期:农历库的 weekCn 是中文字符专名,这里按日期换算本地星期再取词条(周日→huangli.week.7)。
  const dow = new Date(detail.year, detail.month - 1, detail.day).getDay()
  const week = t(WEEK_HEADERS[(dow + 6) % 7])
  return (
    <div className="hl-detail">
      <div className="hl-detail-banner">
        {t('huangli.detailTitle', { y: detail.year, m: detail.month, d: detail.day })}
        {isToday ? t('huangli.todaySuffix') : ''}
      </div>

      {/* 大日期卡 */}
      <div className="hl-big-card">
        <div className="hl-big-head">
          {t('huangli.bigHead', { y: detail.year, m: detail.month, size: detail.lunarMonthSize, week })}
        </div>
        <div className="hl-big-num">{detail.day}</div>
        <div className="hl-big-lunar">{detail.lunarMonthDay}</div>
        <div className="hl-big-ganzhi">
          {t('huangli.gzLine', { y: detail.yearGZ, sx: detail.shengXiao, m: detail.monthGZ, d: detail.dayGZ })}
        </div>
      </div>

      <div className="hl-tags-block">
        {detail.festivals.length > 0 && (
          <div className="hl-tag-row">
            <i className="hl-tag-label tone-info">{t('huangli.tag.festival')}</i>
            <div className="hl-tags">
              {detail.festivals.map((f) => (
                <span key={f} className="hl-tag tone-info">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}
        <TagRow label={t('huangli.tag.yi')} tags={detail.yi} tone="good" />
        <TagRow label={t('huangli.tag.ji')} tags={detail.ji} tone="bad" />
        <TagRow label={t('huangli.tag.jiShen')} tags={detail.jiShen} tone="good" />
        <TagRow label={t('huangli.tag.xiongSha')} tags={detail.xiongSha} tone="bad" />
      </div>

      {/* 详细信息表 */}
      <div className="hl-info-grid">
        <InfoItem label={t('huangli.info.shengXiao')} value={detail.shengXiao} />
        <InfoItem label={t('huangli.info.xingZuo')} value={detail.xingZuo} />
        <InfoItem label={t('huangli.info.chong')} value={detail.chong} />
        <InfoItem label={t('huangli.info.sha')} value={detail.sha} />
        <InfoItem label={t('huangli.info.pengZu')} value={detail.pengZu} wide />
        <InfoItem label={t('huangli.info.taiZhan')} value={detail.taiZhan} />
        <InfoItem label={t('huangli.info.yearNaYin')} value={detail.yearNaYin} />
        <InfoItem label={t('huangli.info.monthNaYin')} value={detail.monthNaYin} />
        <InfoItem label={t('huangli.info.dayNaYin')} value={detail.dayNaYin} />
        <InfoItem label={t('huangli.info.season')} value={detail.season} />
        <InfoItem
          label={t('huangli.info.xiu')}
          value={detail.xiuFull ? t('huangli.value.xiu', { xiu: detail.xiu, full: detail.xiuFull, luck: detail.xiuLuck }) : ''}
          wide
        />
        <InfoItem label={t('huangli.info.jieQi')} value={detail.jieQiText} wide />
        <InfoItem label={t('huangli.info.julian')} value={String(detail.julianDay)} />
        <InfoItem label={t('huangli.info.buddhist')} value={detail.buddhistYear} />
        <InfoItem label={t('huangli.info.islamic')} value={detail.islamic} />
        <InfoItem label={t('huangli.info.liuYao')} value={detail.liuYao} />
        <InfoItem
          label={t('huangli.info.zhiXing')}
          value={detail.zhiXing ? t('huangli.value.zhiXing', { z: detail.zhiXing }) : ''}
        />
        <InfoItem label={t('huangli.info.posXi')} value={detail.posXi} />
        <InfoItem label={t('huangli.info.posCai')} value={detail.posCai} />
        <InfoItem label={t('huangli.info.dayLu')} value={detail.dayLu} wide />
        <InfoItem label={t('huangli.info.shuJiu')} value={detail.shuJiu} />
        <InfoItem label={t('huangli.info.fu')} value={detail.fu} />
      </div>
    </div>
  )
}
