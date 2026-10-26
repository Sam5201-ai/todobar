/**
 * 验证码邮件发送:首推 Resend(免费 100 封/天,一个 fetch 即可接入)。
 *
 * 设计上把渠道抽象成单一函数,后续若国内送达率不行,只需把内部实现
 * 换成阿里云邮件推送,调用方(发码接口)完全不动。
 */

export type MailEnv = {
  RESEND_API_KEY?: string
  RESEND_FROM?: string
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

function defaultFrom(): string {
  // 没有配置发件域名时给一个占位;部署时务必在环境变量里填已验证的发信地址。
  return 'TickTask <noreply@ticktask.app>'
}

function buildHtml(code: string, purpose: string): string {
  const title = purpose === 'reset' ? '重置密码验证码' : '注册验证码'
  return `<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:420px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px">
  <h2 style="color:#0f172a;margin:0 0 12px">TickTask 验证码</h2>
  <p style="color:#334155;font-size:14px;line-height:1.6">你好,你的${title}是:</p>
  <div style="font-size:28px;font-weight:700;letter-spacing:6px;color:#1d7ef0;margin:12px 0">${code}</div>
  <p style="color:#64748b;font-size:12px;line-height:1.6">该验证码 10 分钟内有效。若非本人操作,请忽略此邮件。</p>
</div>`
}

/** 发送验证码邮件。成功返回 {ok:true};失败返回 {ok:false,error} 供接口回友好提示。 */
export async function sendCodeEmail(
  env: MailEnv,
  to: string,
  code: string,
  purpose: string,
): Promise<{ ok: boolean; error?: string }> {
  const key = env.RESEND_API_KEY
  if (!key) {
    console.error('[email] RESEND_API_KEY 未配置,无法发信')
    return { ok: false, error: '邮件服务未配置,暂不能发送验证码' }
  }
  const subject = purpose === 'reset' ? 'TickTask 密码重置验证码' : 'TickTask 注册验证码'
  const from = env.RESEND_FROM || defaultFrom()
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        text: `你的 TickTask 验证码是 ${code}(10 分钟内有效)。若非本人操作请忽略。`,
        html: buildHtml(code, purpose),
      }),
    })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      console.error('[email] Resend 返回', res.status, raw)
      let detail = ''
      try {
        const j = JSON.parse(raw)
        detail = String(j?.message || j?.name || raw || '')
      } catch {
        detail = raw || ''
      }
      detail = detail.replace(/\s+/g, ' ').trim().slice(0, 160)
      let error = `邮件发送失败(Resend ${res.status})`
      if (detail) error += `: ${detail}`
      // Resend 未验证域名时的典型限制:测试发件人只能发给注册 Resend 的邮箱
      if (/testing emails|own email address|verify a domain/i.test(detail)) {
        error += ' —— 说明:Resend 测试发件人(onboarding@resend.dev)只能发给你注册 Resend 用的那个邮箱;要发给任意邮箱(如 QQ 邮箱),需在 Resend 后台 Domains 里添加你的域名并完成 DNS 验证,再把 RESEND_FROM 改为该域名下的地址(如 TickTask <noreply@你的域名>)'
      }
      return { ok: false, error }
    }
    return { ok: true }
  } catch (e) {
    console.error('[email] 发送异常', e)
    return { ok: false, error: `邮件发送失败: ${String((e as Error)?.message || e).slice(0, 120)}` }
  }
}
