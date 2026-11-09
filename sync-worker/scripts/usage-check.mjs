/**
 * Cloudflare Workers Free 用量巡检
 * 输出一份中文 Markdown 报告：四项额度占比 + 50%/80% 阈值告警 + 近 7 日趋势。
 *
 * 用法：node scripts/usage-check.mjs
 * 依赖：sync-worker/.env 里的 CLOUDFLARE_API_TOKEN（需 Account Analytics Read 权限），
 *       或环境变量 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID 覆盖。
 * 说明：本机 curl 会自动使用系统代理，而 Node 内置 fetch 不会，故 HTTP 请求统一走 curl 子进程。
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '30b571afc22b411372befbba0492efb3';
const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

const WARN = 0.5;
const CRITICAL = 0.8;
const LIMITS = {
  requests: 100_000,
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  storageBytes: 5 * 1024 ** 3,
};

const nf = new Intl.NumberFormat('en-US');
const num = (n) => nf.format(Math.round(n || 0));
const pct = (r) => (r * 100).toFixed(r > 0 && r < 0.01 ? 2 : 1) + '%';
const humanBytes = (b) =>
  b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : (b / 1024 ** 2).toFixed(2) + ' MB';
const bjTime = (d) => {
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
};
const dayOf = (d) => d.toISOString().slice(0, 10);
const level = (r) => (r >= CRITICAL ? 2 : r >= WARN ? 1 : 0);
const LEVEL_TEXT = ['正常', '注意', '严重'];

function readToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim();
  let env;
  try {
    env = readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch {
    throw new Error(`找不到 ${path.join(ROOT, '.env')}，请先配置 CLOUDFLARE_API_TOKEN`);
  }
  const m = env.match(/^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.+?)\s*$/m);
  if (!m) throw new Error('.env 中缺少 CLOUDFLARE_API_TOKEN');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function gql(token, query) {
  const r = spawnSync(
    'curl',
    [
      '-sS',
      '-X', 'POST', GRAPHQL,
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Content-Type: application/json',
      '--data-binary', '@-',
    ],
    { input: JSON.stringify({ query }), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
  if (r.error) throw new Error(`curl 启动失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`curl 退出码 ${r.status}：${String(r.stderr || '').slice(0, 300)}`);
  let body;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    throw new Error(`GraphQL 返回非 JSON：${String(r.stdout || '').slice(0, 300)}`);
  }
  if (body.errors?.length) {
    throw new Error(`GraphQL 错误：${body.errors.map((e) => e.message).join('；')}`);
  }
  const accounts = body.data?.viewer?.accounts;
  if (!accounts?.length) throw new Error('GraphQL 未返回账户数据，请检查 accountTag 与 Account Analytics Read 权限');
  return accounts[0];
}

function sumField(rows, field) {
  return rows.reduce((s, r) => s + (r.sum?.[field] || 0), 0);
}

function dailyTotals(rows, fields) {
  const map = new Map();
  for (const r of rows) {
    const d = r.dimensions?.date;
    if (!d) continue;
    const cur = map.get(d) || Object.fromEntries(fields.map((f) => [f, 0]));
    for (const f of fields) cur[f] += r.sum?.[f] || 0;
    map.set(d, cur);
  }
  return map;
}

function peakOf(map, field) {
  let best = { date: '', value: 0 };
  for (const [date, v] of map) {
    if ((v[field] || 0) > best.value) best = { date, value: v[field] || 0 };
  }
  return best;
}

function main() {
  const token = readToken();
  const now = new Date();
  const today = dayOf(now);
  const startToday = `${today}T00:00:00Z`;
  const endNow = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const d7 = dayOf(new Date(now.getTime() - 7 * 86400_000));
  const yesterday = dayOf(new Date(Date.parse(startToday) - 86400_000));

  const query = `query {
    viewer {
      accounts(filter: { accountTag: "${ACCOUNT_ID}" }) {
        wToday: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: "${startToday}", datetime_leq: "${endNow}" }) {
          sum { requests errors } dimensions { scriptName }
        }
        wHist: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: "${d7}T00:00:00Z", datetime_leq: "${endNow}" }) {
          sum { requests errors } dimensions { date scriptName }
        }
        dToday: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: "${today}", date_leq: "${today}" }) {
          sum { rowsRead rowsWritten } dimensions { date databaseId }
        }
        dHist: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: "${d7}", date_leq: "${today}" }) {
          sum { rowsRead rowsWritten } dimensions { date databaseId }
        }
        storage: d1StorageAdaptiveGroups(limit: 10000, filter: { date_geq: "${d7}", date_leq: "${today}" }) {
          max { databaseSizeBytes } dimensions { date databaseId }
        }
      }
    }
  }`;

  const data = gql(token, query);
  const wToday = data.wToday || [];
  const dToday = data.dToday || [];
  const storageRows = data.storage || [];
  const wHist = dailyTotals(data.wHist || [], ['requests', 'errors']);
  const dHist = dailyTotals(data.dHist || [], ['rowsRead', 'rowsWritten']);

  const todayReq = sumField(wToday, 'requests');
  const todayErrors = sumField(wToday, 'errors');
  const todayRead = sumField(dToday, 'rowsRead');
  const todayWrite = sumField(dToday, 'rowsWritten');

  // D1 存储免费额度按账户全部数据库合计；取每个库最近一天的最大体积
  const latestByDb = new Map();
  for (const r of storageRows) {
    const id = r.dimensions?.databaseId;
    const date = r.dimensions?.date;
    const size = r.max?.databaseSizeBytes || 0;
    if (!id || !date) continue;
    const cur = latestByDb.get(id);
    if (!cur || date > cur.date) latestByDb.set(id, { date, size });
  }
  const storageBytes = [...latestByDb.values()].reduce((s, v) => s + v.size, 0);
  const biggestDb = [...latestByDb.entries()].sort((a, b) => b[1].size - a[1].size)[0];

  const metrics = [
    {
      name: 'Workers 请求 / 天',
      today: todayReq,
      limit: LIMITS.requests,
      yesterday: wHist.get(yesterday)?.requests,
      peak: peakOf(wHist, 'requests'),
      fmt: (v) => `${num(v)} 次`,
    },
    {
      name: 'D1 读取行数 / 天',
      today: todayRead,
      limit: LIMITS.rowsRead,
      yesterday: dHist.get(yesterday)?.rowsRead,
      peak: peakOf(dHist, 'rowsRead'),
      fmt: (v) => `${num(v)} 行`,
    },
    {
      name: 'D1 写入行数 / 天',
      today: todayWrite,
      limit: LIMITS.rowsWritten,
      yesterday: dHist.get(yesterday)?.rowsWritten,
      peak: peakOf(dHist, 'rowsWritten'),
      fmt: (v) => `${num(v)} 行`,
    },
    {
      name: 'D1 存储（账户累计）',
      today: storageBytes,
      limit: LIMITS.storageBytes,
      yesterday: null,
      peak: null,
      fmt: humanBytes,
    },
  ];

  for (const m of metrics) m.ratio = m.today / m.limit;
  const overall = Math.max(...metrics.map((m) => level(m.ratio)));

  const lines = [];
  lines.push(`# Cloudflare 免费版用量巡检 · 北京时间 ${bjTime(now)}`);
  lines.push('');
  lines.push(
    `数据窗口：UTC ${today} 00:00 ~ ${endNow.slice(11, 16)}（日额度于 UTC 00:00 / 北京 08:00 重置）`,
  );
  lines.push('');
  lines.push('| 指标 | 当前 UTC 日 | 占额度 | 免费版上限 | 昨日完整日 | 近 7 日峰值 | 状态 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const m of metrics) {
    const yest = m.yesterday == null ? '—' : m.fmt(m.yesterday);
    const peak = m.peak == null ? '—（累计值）' : `${m.fmt(m.peak.value)}（${m.peak.date.slice(5)}）`;
    const lim = m.name.startsWith('D1 存储') ? '5 GB' : num(m.limit);
    lines.push(
      `| ${m.name} | ${m.fmt(m.today)} | ${pct(m.ratio)} | ${lim} | ${yest} | ${peak} | ${LEVEL_TEXT[level(m.ratio)]} |`,
    );
  }
  lines.push('');
  lines.push(`**告警级别：${LEVEL_TEXT[overall]}**（阈值：≥50% 注意，≥80% 严重）`);
  lines.push('');

  const hit = metrics.filter((m) => level(m.ratio) >= 1);
  if (overall === 0) {
    lines.push('四项指标均低于日额度的 50%，服务不受配额影响。');
  } else {
    for (const m of hit) {
      lines.push(`- ${m.name} 已用 ${pct(m.ratio)}（${m.fmt(m.today)} / ${m.fmt(m.limit)}）。`);
    }
    if (overall === 2) {
      lines.push('- 建议立即升级 Workers Paid（$5/月起）：解除每日请求与 D1 读写硬限制，通常几分钟生效。');
    }
  }
  for (const m of metrics) {
    const pr = m.peak ? m.peak.value / m.limit : 0;
    if (m.peak && level(pr) >= 1 && level(m.ratio) < 1) {
      lines.push(
        `- 趋势提示：${m.name} 近 7 日峰值达 ${pct(pr)}（${m.peak.date}），虽今日不高，建议排查高消耗查询。`,
      );
    }
  }
  lines.push('');
  lines.push('**账户明细**');
  lines.push('');
  const byScript = new Map();
  for (const r of wToday) {
    const s = r.dimensions?.scriptName || '(unknown)';
    byScript.set(s, (byScript.get(s) || 0) + (r.sum?.requests || 0));
  }
  lines.push(
    `- Worker 今日请求：${[...byScript.entries()].map(([k, v]) => `${k} ${num(v)} 次`).join('；') || '无数据'}（账户共享 10 万/天）`,
  );
  lines.push(
    `- D1 数据库 ${latestByDb.size} 个，合计 ${humanBytes(storageBytes)} / 5 GB${biggestDb ? `；最大单库 ${humanBytes(biggestDb[1].size)}（${biggestDb[0].slice(0, 8)}…）` : ''}`,
  );
  lines.push(`- 今日 Worker 错误请求：${num(todayErrors)} 次`);
  lines.push('');
  lines.push('数据来源：Cloudflare GraphQL Analytics API（约数分钟延迟）。D1 读取行数按 SQL 扫描行数计，非返回行数。');
  lines.push('排查命令：`npx wrangler d1 info todobar`、`npx wrangler d1 insights todobar --sort-by=reads --time-period=7d --json`。');

  process.stdout.write(lines.join('\n') + '\n');
}

try {
  main();
} catch (e) {
  process.stdout.write(`# 用量巡检失败\n\n${e.message}\n\n请检查网络、API Token 权限（Account Analytics Read）与账户 ID。\n`);
  process.exitCode = 1;
}
