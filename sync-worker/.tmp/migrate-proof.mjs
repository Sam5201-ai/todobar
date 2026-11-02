import { DatabaseSync } from 'node:sqlite'
import { applySchema, upsertTasks } from './db.mjs'

// --- 1) 用 node:sqlite 模拟一个「老版本」D1:tasks 表缺 recurrence/sort_order 等列 ---
const nodeDb = new DatabaseSync(':memory:')
// 老表:只有最初版本的列(没有 recurrence/sort_order/completed_dates/deleted_dates/series_id)
nodeDb.exec(`
  CREATE TABLE tasks (
    id TEXT NOT NULL, user_id TEXT NOT NULL, parent_id TEXT, list_id TEXT NOT NULL,
    title TEXT NOT NULL, notes TEXT, meta TEXT, priority TEXT NOT NULL DEFAULT 'normal',
    is_important INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0, due_date TEXT, remind_at TEXT, deleted_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (id)
  );
  CREATE TABLE birthdays (
    id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', relation TEXT,
    calendar TEXT NOT NULL DEFAULT 'solar', month INTEGER NOT NULL DEFAULT 1, day INTEGER NOT NULL DEFAULT 1,
    is_leap_month INTEGER NOT NULL DEFAULT 0, remind_enabled INTEGER NOT NULL DEFAULT 1,
    remind_hour INTEGER NOT NULL DEFAULT 9, remind_minute INTEGER NOT NULL DEFAULT 0,
    remind_days_before INTEGER NOT NULL DEFAULT 0, note TEXT, deleted_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (id)
  );
  CREATE TABLE settings (user_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id));
`)
// 注入一条老数据(证明迁移不会破坏已有数据)
nodeDb.exec(`INSERT INTO tasks (id, user_id, list_id, title, priority, created_at, updated_at)
  VALUES ('old-1', 'u1', 'default', '老任务', 'normal', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)

// --- 2) 用 node:sqlite 实现 D1 接口的最小 mock ---
const mockD1 = {
  exec(sql) {
    nodeDb.exec(sql) // node:sqlite 的 exec 支持多语句
  },
  prepare(sql) {
    const stmt = nodeDb.prepare(sql)
    return {
      bind(...params) {
        return {
          async run() {
            const info = stmt.run(...params)
            return { meta: { changes: info.changes ?? 0 } }
          },
          async all() {
            return { results: stmt.all(...params) }
          },
        }
      },
    }
  },
}

const userId = 'u1'

// --- 3) 跑真实代码:applySchema(补列) ---
console.log('迁移前 tasks 列:', nodeDb.prepare('PRAGMA table_info(tasks)').all().map((r) => r.name).join(','))
try {
  await applySchema(mockD1)
  console.log('✓ applySchema 执行无异常')
} catch (e) {
  console.log('✗ applySchema 抛错:', String(e))
  process.exit(1)
}
console.log('迁移后 tasks 列:', nodeDb.prepare('PRAGMA table_info(tasks)').all().map((r) => r.name).join(','))

// --- 4) 用生产客户端会发的完整字段推送一条任务(含 recurrence) ---
const taskRow = {
  id: 'new-1', user_id: userId, parent_id: null, list_id: 'default', title: '带重复规则的新任务',
  notes: null, meta: null, priority: 'normal', is_important: 0, is_pinned: 0, done: 0,
  due_date: null, remind_at: null, deleted_at: null, sort_order: 3,
  recurrence: JSON.stringify({ freq: 'daily', interval: 1 }),
  completed_dates: null, deleted_dates: null, series_id: 's1',
  created_at: '2026-10-14T00:00:00.000Z', updated_at: '2026-10-14T00:00:00.000Z',
}
try {
  const accepted = await upsertTasks(mockD1, userId, [taskRow])
  console.log('✓ upsertTasks 成功, accepted =', accepted)
} catch (e) {
  console.log('✗ upsertTasks 抛错:', String(e))
  process.exit(1)
}

// --- 5) 验证:新任务的 recurrence 真的写进去了,老任务也在 ---
const rows = nodeDb.prepare('SELECT id, recurrence, sort_order FROM tasks ORDER BY id').all()
console.log('写入结果:', JSON.stringify(rows))
const newRow = rows.find((r) => r.id === 'new-1')
if (!newRow || newRow.recurrence !== taskRow.recurrence) {
  console.log('✗ recurrence 未正确落库')
  process.exit(1)
}
if (!rows.find((r) => r.id === 'old-1')) {
  console.log('✗ 老数据丢失')
  process.exit(1)
}
console.log('✓ 端到端验证通过:老表已补列,带 recurrence 的新任务成功写入,历史数据完好')
