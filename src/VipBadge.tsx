// 会员专属(VIP)角标:标记「仅会员可用」的功能字段。
// 由设置页各会员功能入口在 restricted && !trialActive 时渲染(条件在 useAccount().showVip)。
import type { ReactNode } from 'react'

export function VipBadge({ title }: { title?: string }): ReactNode {
  return (
    <span className="vip-badge" title={title ?? '会员专属功能'}>
      VIP
    </span>
  )
}
