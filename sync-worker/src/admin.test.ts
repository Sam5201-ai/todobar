import { describe, expect, it } from 'vitest'
import worker from './index'
import { makeD1 } from '../test/d1-shim.mjs'

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext

const ADMIN = { email: '396770760@qq.com', password: '66666666' }

async function makeEnv() {
  const env = { DB: await makeD1() } as any
  // 首个请求同步建表(与线上 ensureSchema 同一路径)
  await worker.fetch(new Request('https://x/api/health'), env, ctx)
  return env
}

async function adminLogin(env: any, creds = ADMIN) {
  const res = await worker.fetch(
    new Request('https://x/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(creds),
    }),
    env,
    ctx,
  )
  return res
}

function adminGet(env: any, path: string, token: string) {
  return worker.fetch(
    new Request(`https://x${path}`, { headers: { 'x-admin-token': token } }),
    env,
    ctx,
  )
}

function adminPost(env: any, path: string, token: string, body: unknown) {
  return worker.fetch(
    new Request(`https://x${path}`, {
      method: 'POST',
      headers: { 'x-admin-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  )
}

/** 直接造一个已注册用户 + 会话令牌,返回 token。 */
async function seedUser(env: any, id: string, email: string, opts: { activated?: boolean } = {}) {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, salt, nickname, activated, trial_ends_at, created_at, disabled)
     VALUES (?, ?, 'x', 'y', NULL, ?, ?, ?, 0)`,
  )
    .bind(id, email, opts.activated ? 1 : 0, new Date(Date.now() + 86_400_000).toISOString(), now)
    .run()
  const token = 'sess_' + id
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, device_name, created_at, last_seen_at, expires_at)
     VALUES (?, ?, 'test', ?, ?, ?)`,
  )
    .bind(token, id, now, now, new Date(Date.now() + 86_400_000).toISOString())
    .run()
  return token
}

describe('admin auth', () => {
  it('logs in with the fixed credentials and rejects wrong ones', async () => {
    const env = await makeEnv()
    const ok = await adminLogin(env)
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(typeof body.token).toBe('string')

    const bad = await adminLogin(env, { email: ADMIN.email, password: 'wrong' })
    expect(bad.status).toBe(401)
  })

  it('guards /api/admin/* without a token', async () => {
    const env = await makeEnv()
    const res = await worker.fetch(new Request('https://x/api/admin/overview'), env, ctx)
    expect(res.status).toBe(401)
    const ok = await adminLogin(env)
    const { token } = await ok.json()
    const authed = await adminGet(env, '/api/admin/overview', token)
    expect(authed.status).toBe(200)
  })
})

describe('tracking', () => {
  it('accepts site events and reflects them in the overview', async () => {
    const env = await makeEnv()
    const res = await worker.fetch(
      new Request('https://x/api/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'site',
          events: [
            { event: 'pageview', visitor: 'v1', device: 'fps1' },
            // 同一设备进入两次:访客数=1,点击数(进入次数)=2
            { event: 'site_visit', visitor: 'v1', device: 'fps1' },
            { event: 'site_visit', visitor: 'v1', device: 'fps1' },
            { event: 'download_click', visitor: 'v1', device: 'fps1' },
            { event: 'bogus_event', visitor: 'v1', device: 'fps1' }, // 白名单外,应被丢弃
          ],
        }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).accepted).toBe(4)

    const login = await (await adminLogin(env)).json()
    const ov = await (await adminGet(env, '/api/admin/overview?days=30', login.token)).json()
    expect(ov.funnel.visitors).toBe(1)
    expect(ov.funnel.clicks).toBe(2)
    expect(ov.trends.days.length).toBe(30)
    expect(ov.users.total).toBe(0)
  })

  it('安装按设备去重;注册需绑定设备先有安装;活跃用户已登录按账号去重', async () => {
    const env = await makeEnv()

    // 两台设备上报安装(fpA 上报两次验证去重),时间在注册之前
    const t0 = new Date(Date.now() - 3600_000).toISOString()
    for (const device of ['fpA', 'fpA', 'fpB']) {
      await env.DB.prepare(
        `INSERT INTO analytics_events (source, event, device, ip, ts) VALUES ('app', 'install', ?, '1.1.1.1', ?)`,
      )
        .bind(device, t0)
        .run()
    }
    // u_fun1 绑定 fpA 且晚于安装注册 → 计入注册数
    // u_fun2 无绑定 → 不计入;u_fun3 绑定了从未安装的 fpC → 不计入
    const now = new Date().toISOString()
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
    for (const [id, email] of [
      ['u_fun1', 'fun1@example.com'],
      ['u_fun2', 'fun2@example.com'],
      ['u_fun3', 'fun3@example.com'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO users (id, email, password_hash, salt, activated, trial_ends_at, created_at, disabled)
         VALUES (?, ?, 'x', 'y', 0, ?, ?, 0)`,
      )
        .bind(id, email, tomorrow, now)
        .run()
    }
    await env.DB.prepare(
      `INSERT INTO identity_links (device, uid, first_seen, last_seen) VALUES ('fpA', 'u_fun1', ?, ?)`,
    )
      .bind(now, now)
      .run()
    await env.DB.prepare(
      `INSERT INTO identity_links (device, uid, first_seen, last_seen) VALUES ('fpC', 'u_fun3', ?, ?)`,
    )
      .bind(now, now)
      .run()

    // 活跃用户:u_fun1 在两台设备启动(账号去重=1) + 一台未登录设备(按指纹) → 今日活跃=2
    for (const [uid, device] of [
      ['u_fun1', 'devA'],
      ['u_fun1', 'devB'],
      ['', 'devC'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO analytics_events (source, event, uid, device, ts) VALUES ('app', 'app_open', ?, ?, ?)`,
      )
        .bind(uid, device, now)
        .run()
    }

    const login = await (await adminLogin(env)).json()
    const ov = await (await adminGet(env, '/api/admin/overview?days=30', login.token)).json()
    expect(ov.funnel.installs).toBe(2)
    expect(ov.funnel.registrations).toBe(1)
    expect(ov.active.today).toBe(2)
  })
})

describe('activation codes', () => {
  it('batch-generates, lists, issues and deletes codes', async () => {
    const env = await makeEnv()
    const { token } = await (await adminLogin(env)).json()

    const gen = await adminPost(env, '/api/admin/codes', token, {
      count: 3,
      prefix: 'TK',
      note: '首批',
    })
    expect(gen.status).toBe(200)
    const genBody = await gen.json()
    expect(genBody.created).toBe(3)
    expect(genBody.codes).toHaveLength(3)
    expect(genBody.codes[0].startsWith('TK-')).toBe(true)

    const list = await (await adminGet(env, '/api/admin/codes', token)).json()
    expect(list.total).toBe(3)
    expect(list.counts).toEqual({ unissued: 3, issued: 0, used: 0 })

    const issue = await adminPost(env, '/api/admin/codes/issue', token, {
      codes: [genBody.codes[0]],
    })
    expect((await issue.json()).issued).toBe(1)
    const after = await (await adminGet(env, '/api/admin/codes?status=issued', token)).json()
    expect(after.total).toBe(1)

    // 已发放但未使用的码允许删除(即撤回发放)
    const delIssued = await adminPost(env, '/api/admin/codes/delete', token, {
      codes: [genBody.codes[0]],
    })
    expect((await delIssued.json()).deleted).toBe(1)
    const delFree = await adminPost(env, '/api/admin/codes/delete', token, {
      codes: [genBody.codes[1], genBody.codes[2]],
    })
    expect((await delFree.json()).deleted).toBe(2)
    const empty = await (await adminGet(env, '/api/admin/codes', token)).json()
    expect(empty.total).toBe(0)
  })

  it('redeems a code once and activates the account', async () => {
    const env = await makeEnv()
    const { token: adminToken } = await (await adminLogin(env)).json()
    const gen = await (await adminPost(env, '/api/admin/codes', adminToken, { count: 1 })).json()
    const code = gen.codes[0]
    await adminPost(env, '/api/admin/codes/issue', adminToken, { codes: [code] })

    const userToken = await seedUser(env, 'u_redeem', 'redeem@example.com')
    const redeem = await worker.fetch(
      new Request('https://x/api/activation/redeem', {
        method: 'POST',
        headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
      env,
      ctx,
    )
    expect(redeem.status).toBe(200)

    // 同一用户重复兑换 → 409
    const again = await worker.fetch(
      new Request('https://x/api/activation/redeem', {
        method: 'POST',
        headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
      env,
      ctx,
    )
    expect(again.status).toBe(409)

    // 不存在的码 → 404
    const missing = await worker.fetch(
      new Request('https://x/api/activation/redeem', {
        method: 'POST',
        headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'TK-NOPE' }),
      }),
      env,
      ctx,
    )
    expect(missing.status).toBe(404)

    // 账号已被激活
    const user = await env.DB.prepare('SELECT activated FROM users WHERE id = ?')
      .bind('u_redeem')
      .first()
    expect(user.activated).toBe(1)
  })
})

describe('user management', () => {
  it('lists users and blacklisting kills the session', async () => {
    const env = await makeEnv()
    const { token: adminToken } = await (await adminLogin(env)).json()
    await seedUser(env, 'u_list', 'list@example.com')
    await seedUser(env, 'u_member', 'member@example.com', { activated: true })

    const list = await (await adminGet(env, '/api/admin/users', adminToken)).json()
    expect(list.total).toBe(2)
    expect(list.rows.map((r: any) => r.id).sort()).toEqual(['u_list', 'u_member'])
    const members = await (
      await adminGet(env, '/api/admin/users?status=member', adminToken)
    ).json()
    expect(members.total).toBe(1)
    expect(members.rows[0].email).toBe('member@example.com')

    // 拉黑 → 该用户同步请求立即 401
    const victim = await seedUser(env, 'u_victim', 'victim@example.com')
    const before = await worker.fetch(
      new Request('https://x/api/tasks', { headers: { authorization: `Bearer ${victim}` } }),
      env,
      ctx,
    )
    expect(before.status).toBe(200)
    const block = await adminPost(env, '/api/admin/users/blacklist', adminToken, {
      id: 'u_victim',
      disabled: true,
    })
    expect(block.status).toBe(200)
    const after = await worker.fetch(
      new Request('https://x/api/tasks', { headers: { authorization: `Bearer ${victim}` } }),
      env,
      ctx,
    )
    expect(after.status).toBe(401)
  })
})

describe('release notes admin', () => {
  it('creates, updates and deletes a version record', async () => {
    const env = await makeEnv()
    const { token } = await (await adminLogin(env)).json()

    // 种子记录(0.1.5 ~ 0.2.3)已在列表中
    const seeded = await (await adminGet(env, '/api/admin/releases', token)).json()
    expect(seeded.releases.length).toBeGreaterThanOrEqual(9)
    expect(seeded.releases.map((r: any) => r.version)).toContain('0.2.3')

    const create = await adminPost(env, '/api/admin/releases', token, {
      version: '9.9.9',
      release_date: '2026-10-16',
      title: '测试版本',
      items: ['第一条', '第二条'],
    })
    expect(create.status).toBe(200)

    const update = await worker.fetch(
      new Request('https://x/api/admin/releases', {
        method: 'PUT',
        headers: { 'x-admin-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ version: '9.9.9', release_date: '2026-10-16', title: '改后的标题' }),
      }),
      env,
      ctx,
    )
    expect(update.status).toBe(200)
    const afterUpdate = await (await adminGet(env, '/api/admin/releases', token)).json()
    const row = afterUpdate.releases.find((r: any) => r.version === '9.9.9')
    expect(row.title).toBe('改后的标题')

    const del = await worker.fetch(
      new Request('https://x/api/admin/releases?version=9.9.9', {
        method: 'DELETE',
        headers: { 'x-admin-token': token },
      }),
      env,
      ctx,
    )
    expect(del.status).toBe(200)
    const afterDelete = await (await adminGet(env, '/api/admin/releases', token)).json()
    expect(afterDelete.releases.map((r: any) => r.version)).not.toContain('9.9.9')

    // 公开读取接口不受影响
    const pub = await worker.fetch(new Request('https://x/api/releases'), env, ctx)
    expect(pub.status).toBe(200)
  })
})

describe('admin users trial', () => {
  it('设为试用过期后 trial_ends_at 变为过去,恢复试用后重置 activated=0 且未来到期', async () => {
    const env = await makeEnv()
    const login = await adminLogin(env)
    expect(login.status).toBe(200)
    const { token } = (await login.json()) as { token: string }

    // seedUser 默认 trial_ends_at = 明天(试用中)
    await seedUser(env, 'u-trial', 'trial@example.com')

    // 设为试用过期
    const expire = await adminPost(env, '/api/admin/users/trial', token, { id: 'u-trial', expired: true })
    expect(expire.status).toBe(200)
    const afterExpire = await env.DB.prepare('SELECT activated, trial_ends_at FROM users WHERE id = ?').bind('u-trial').first<any>()
    expect(afterExpire.activated).toBe(0)
    expect(new Date(afterExpire.trial_ends_at).getTime()).toBeLessThan(Date.now())

    // 恢复试用
    const restore = await adminPost(env, '/api/admin/users/trial', token, { id: 'u-trial', expired: false })
    expect(restore.status).toBe(200)
    const afterRestore = await env.DB.prepare('SELECT activated, trial_ends_at FROM users WHERE id = ?').bind('u-trial').first<any>()
    expect(afterRestore.activated).toBe(0)
    expect(new Date(afterRestore.trial_ends_at).getTime()).toBeGreaterThan(Date.now())

    // 用户不存在 → 404
    const missing = await adminPost(env, '/api/admin/users/trial', token, { id: 'nope', expired: true })
    expect(missing.status).toBe(404)
  })
})
