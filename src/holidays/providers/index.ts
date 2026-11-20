/**
 * 地区节假日 provider(P0 骨架,P2 补全多地区数据)。
 *
 * 设计:
 * - CN 委托现有 src/holidays.ts(内置 2024-2026 数据 + 远程热更新),行为零变化;
 * - JP/KR/US/GLOBAL 在官方法定假日数据落地前一律返回 false(只排周末)——
 *   宁缺勿错,避免用「通用公历节日表」污染计薪/工作日计算;
 * - P2 为 jp/kr/us 内置官方数据源(远程仅作热更新通道),并给
 *   OFFICIAL_HOLIDAYS_URL 增加按地区分文件与缓存 key 隔离。
 */

import { isLegalHoliday } from '../../holidays'
import type { Region } from '../../i18n/types'

export interface HolidayProvider {
  /** 该地区此日期是否为法定节假日(不含周末)。 */
  isHoliday: (d: Date) => boolean
  /** 数据是否就绪(false = 尚无该地区数据,仅周末排班)。 */
  ready: boolean
}

const cnProvider: HolidayProvider = {
  isHoliday: (d) => isLegalHoliday(d),
  ready: true,
}

/** 未落地地区的占位 provider:只排周末。 */
const emptyProvider: HolidayProvider = {
  isHoliday: () => false,
  ready: false,
}

export function getHolidayProvider(region: Region): HolidayProvider {
  switch (region) {
    case 'CN':
      return cnProvider
    case 'TW':
      // 台湾法定假日数据未落地前与 CN 不可混用,暂按空表(仅周末)。
      return emptyProvider
    case 'JP':
    case 'KR':
    case 'US':
    case 'GLOBAL':
    default:
      return emptyProvider
  }
}
