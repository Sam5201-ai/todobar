const { DatabaseSync } = require('node:sqlite')
const src = require('fs').readFileSync(require('path').join(__dirname, 'src/db.ts'), 'utf8')
const m = src.match(/const SCHEMA_SQL = `([\s\S]*?)`/)
const sql = m[1]
const stmts = sql.split(';').map((s) => s.trim()).filter(Boolean)

console.log('=== 场景1:全新库 ===')
const db = new DatabaseSync(':memory:')
for (const [i, s] of stmts.entries()) {
  try {
    db.exec(s + ';')
    console.log(i, 'OK  ', s.slice(0, 44).replace(/\n/g, ' '))
  } catch (e) {
    console.log(i, 'FAIL', s.slice(0, 44).replace(/\n/g, ' '), '::', e.message)
  }
}

console.log('=== 场景2:老库(只有 tasks/settings/birthdays/release_notes) ===')
const db2 = new DatabaseSync(':memory:')
db2.exec(
  'CREATE TABLE tasks (id TEXT PRIMARY KEY, updated_at TEXT); CREATE TABLE settings (user_id TEXT PRIMARY KEY); CREATE TABLE birthdays (id TEXT PRIMARY KEY, updated_at TEXT); CREATE TABLE release_notes (version TEXT PRIMARY KEY);',
)
for (const [i, s] of stmts.entries()) {
  try {
    db2.exec(s + ';')
  } catch (e) {
    console.log('stmt', i, 'FAIL::', e.message.slice(0, 140))
  }
}
for (const t of ['users', 'email_codes', 'sessions', 'release_notes']) {
  try {
    db2.prepare(`SELECT count(*) c FROM ${t}`).get()
    console.log(t, 'SELECT OK')
  } catch (e) {
    console.log(t, 'SELECT FAIL::', e.message)
  }
}
