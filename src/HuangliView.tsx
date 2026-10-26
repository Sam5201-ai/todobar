import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { getMonthCells, getHuangliDetail, hlKey, type HlCell, type HlDetail } from './huangli'

const WEEK_HEADERS = ['一', '二', '三', '四', '五', '六', '日']

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
  const now = new Date()
  const todayKey = hlKey(now.getFullYear(), now.getMonth() + 1, now.getDate())
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 })
  const [selectedKey, setSelectedKey] = useState(todayKey)

  const cells = useMemo(() => getMonthCells(cursor.year, cursor.month, todayKey), [cursor, todayKey])
  const detail: HlDetail = useMemo(() => {
    const [y, m, d] = selectedKey.split('-').map(Number)
    return getHuangliDetail(y, m, d)
  }, [selectedKey])

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
          <button type="button" className="hl-nav-btn" aria-label="上一年" onClick={() => setCursor((c) => ({ ...c, year: c.year - 1 }))}>
            <ChevronLeft size={13} />
          </button>
          <select
            className="hl-select"
            value={cursor.year}
            onChange={(e) => setCursor((c) => ({ ...c, year: Number(e.target.value) }))}
            aria-label="选择年份"
          >
            {yearOptions().map((y) => (
              <option key={y} value={y}>
                {y}年
              </option>
            ))}
          </select>
          <button type="button" className="hl-nav-btn" aria-label="下一年" onClick={() => setCursor((c) => ({ ...c, year: c.year + 1 }))}>
            <ChevronRight size={13} />
          </button>
        </div>
        <div className="hl-nav-group">
          <button type="button" className="hl-nav-btn" aria-label="上一月" onClick={() => shiftMonth(-1)}>
            <ChevronLeft size={13} />
          </button>
          <select
            className="hl-select"
            value={cursor.month}
            onChange={(e) => setCursor((c) => ({ ...c, month: Number(e.target.value) }))}
            aria-label="选择月份"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m}月
              </option>
            ))}
          </select>
          <button type="button" className="hl-nav-btn" aria-label="下一月" onClick={() => shiftMonth(1)}>
            <ChevronRight size={13} />
          </button>
        </div>
        <button type="button" className="hl-today-btn" onClick={gotoToday}>
          回到今天
        </button>
      </div>

      {/* 月历 */}
      <div className="hl-grid" role="grid" aria-label={`${cursor.year}年${cursor.month}月黄历`}>
        <div className="hl-grid-title">
          {cursor.year}年{cursor.month}月
        </div>
        <div className="hl-week-row">
          {WEEK_HEADERS.map((w) => (
            <div key={w} className={`hl-week-cell ${w === '六' || w === '日' ? 'is-weekend' : ''}`}>
              {w}
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
          {cell.badge === 'work' ? '班' : '休'}
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
  return (
    <div className="hl-detail">
      <div className="hl-detail-banner">
        {detail.year}年{detail.month}月{detail.day}日 详细信息{isToday ? ' · 今天' : ''}
      </div>

      {/* 大日期卡 */}
      <div className="hl-big-card">
        <div className="hl-big-head">
          {detail.year}年 {detail.month}月（{detail.lunarMonthSize}）星期{detail.weekCn}
        </div>
        <div className="hl-big-num">{detail.day}</div>
        <div className="hl-big-lunar">{detail.lunarMonthDay}</div>
        <div className="hl-big-ganzhi">
          {detail.yearGZ}年【{detail.shengXiao}年】 {detail.monthGZ}月 {detail.dayGZ}日
        </div>
      </div>

      <div className="hl-tags-block">
        {detail.festivals.length > 0 && (
          <div className="hl-tag-row">
            <i className="hl-tag-label tone-info">节日</i>
            <div className="hl-tags">
              {detail.festivals.map((f) => (
                <span key={f} className="hl-tag tone-info">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}
        <TagRow label="宜" tags={detail.yi} tone="good" />
        <TagRow label="忌" tags={detail.ji} tone="bad" />
        <TagRow label="吉神宜趋" tags={detail.jiShen} tone="good" />
        <TagRow label="凶神宜忌" tags={detail.xiongSha} tone="bad" />
      </div>

      {/* 详细信息表 */}
      <div className="hl-info-grid">
        <InfoItem label="生肖" value={detail.shengXiao} />
        <InfoItem label="星座" value={detail.xingZuo} />
        <InfoItem label="冲" value={detail.chong} />
        <InfoItem label="煞" value={detail.sha} />
        <InfoItem label="彭祖百忌" value={detail.pengZu} wide />
        <InfoItem label="胎神占方" value={detail.taiZhan} />
        <InfoItem label="年五行" value={detail.yearNaYin} />
        <InfoItem label="月五行" value={detail.monthNaYin} />
        <InfoItem label="日五行" value={detail.dayNaYin} />
        <InfoItem label="季节" value={detail.season} />
        <InfoItem label="星宿" value={detail.xiuFull ? `${detail.xiu}宿（${detail.xiuFull}）· ${detail.xiuLuck}` : ''} wide />
        <InfoItem label="节气" value={detail.jieQiText} wide />
        <InfoItem label="儒略日" value={String(detail.julianDay)} />
        <InfoItem label="佛历年" value={detail.buddhistYear} />
        <InfoItem label="伊斯兰历" value={detail.islamic} />
        <InfoItem label="六曜" value={detail.liuYao} />
        <InfoItem label="十二神" value={detail.zhiXing ? `${detail.zhiXing}执位` : ''} />
        <InfoItem label="喜神方位" value={detail.posXi} />
        <InfoItem label="财神方位" value={detail.posCai} />
        <InfoItem label="日禄" value={detail.dayLu} wide />
        <InfoItem label="数九" value={detail.shuJiu} />
        <InfoItem label="三伏" value={detail.fu} />
      </div>
    </div>
  )
}
