import type { D1Database, KVNamespace } from '@cloudflare/workers-types'

export type AuthEnv = {
  DB: D1Database
  TOKENS?: KVNamespace
  /** Local-dev convenience: comma-separated list of valid bearer tokens. */
  API_TOKENS?: string
}

/**
 * Resolve the userId for a request's bearer token.
 *
 * Resolution order (first hit wins):
 *  - KV mode (legacy manual tokens): the token is a key in the TOKENS namespace
 *    whose value is the userId. This lets one person issue several device tokens
 *    that all map to the same data set.
 *  - Env mode (local dev): any token listed in API_TOKENS is accepted and the
 *    userId is derived as `user:<token>`.
 *  - Session mode (P1): the token is a row in `sessions` whose `user_id` becomes
 *    the account id that all sync data is scoped to. This is what login issues.
 *
 * Returns null when the token is missing or invalid.
 */
export async function resolveUser(
  env: AuthEnv,
  request: Request,
): Promise<string | null> {
  const header = request.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  let token = match ? match[1].trim() : null
  // 经国内代理(托管平台会剥离 Authorization 头)时,改从自定义头取令牌。
  if (!token) token = request.headers.get('x-sync-token')?.trim() ?? null
  if (!token) return null

  if (env.TOKENS) {
    const userId = await env.TOKENS.get(token)
    if (userId) return userId
  }

  if (env.API_TOKENS) {
    const allowed = env.API_TOKENS.split(',').map((t) => t.trim())
    if (allowed.includes(token)) return `user:${token}`
  }

  // 会话令牌 → 账号 id(同步数据天然按账号隔离)
  try {
    const row = await env.DB.prepare(
      'SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?',
    )
      .bind(token, new Date().toISOString())
      .first<{ user_id: string }>()
    if (row) {
      // 黑名单(后台拉黑)用户:令牌立即失效,同步 / 资料 / 兑换一律拒绝
      const u = await env.DB.prepare('SELECT disabled FROM users WHERE id = ?')
        .bind(row.user_id)
        .first<{ disabled: number }>()
      if (u && u.disabled) return null
      return row.user_id
    }
  } catch {
    /* sessions 表尚未建立(极老库),按未授权处理 */
  }

  return null
}

export function unauthorized(message = 'Unauthorized'): Response {
  return new Response(message, {
    status: 401,
    headers: { 'WWW-Authenticate': 'Bearer' },
  })
}

// ---------------------------------------------------------------------------
// 密码哈希(PBKDF2-SHA256, Workers 原生 WebCrypto,每用户独立盐)
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 100_000

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** 生成 16 字节随机盐 + PBKDF2 哈希,返回 hex 串。 */
export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const saltBuf = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBuf, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return { hash: toHex(bits), salt: toHex(saltBuf.buffer) }
}

export async function verifyPassword(
  password: string,
  saltHex: string,
  hashHex: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    )
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      key,
      256,
    )
    return toHex(bits) === hashHex
  } catch {
    return false
  }
}

/** 生成 32 字节随机会话令牌(hex)。 */
export function randomToken(): string {
  const buf = crypto.getRandomValues(new Uint8Array(32))
  return toHex(buf.buffer)
}

/** 对验证码做一次性哈希(与密码同套,盐独立),不落明文。 */
export async function hashCode(code: string): Promise<{ hash: string; salt: string }> {
  return hashPassword(code)
}

export async function verifyCode(code: string, saltHex: string, hashHex: string): Promise<boolean> {
  return verifyPassword(code, saltHex, hashHex)
}
