// src/db.ts
var SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  parent_id    TEXT,
  list_id      TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  notes        TEXT,
  meta         TEXT,
  priority     TEXT    NOT NULL DEFAULT 'normal',
  is_important INTEGER NOT NULL DEFAULT 0,
  is_pinned    INTEGER NOT NULL DEFAULT 0,
  done         INTEGER NOT NULL DEFAULT 0,
  due_date     TEXT,
  remind_at    TEXT,
  deleted_at   TEXT,
  sort_order   INTEGER,
  recurrence   TEXT,
  completed_dates TEXT,
  deleted_dates TEXT,
  series_id    TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_updated ON tasks(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_parent  ON tasks(user_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_list    ON tasks(user_id, list_id);

CREATE TABLE IF NOT EXISTS birthdays (
  id                 TEXT    NOT NULL,
  user_id            TEXT    NOT NULL,
  name               TEXT    NOT NULL DEFAULT '',
  relation           TEXT,
  kind               TEXT    NOT NULL DEFAULT 'birthday',
  avatar             TEXT,
  calendar           TEXT    NOT NULL DEFAULT 'solar',
  month              INTEGER NOT NULL DEFAULT 1,
  day                INTEGER NOT NULL DEFAULT 1,
  is_leap_month      INTEGER NOT NULL DEFAULT 0,
  remind_enabled     INTEGER NOT NULL DEFAULT 1,
  remind_hour        INTEGER NOT NULL DEFAULT 9,
  remind_minute      INTEGER NOT NULL DEFAULT 0,
  remind_days_before INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  deleted_at         TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_birthdays_user_updated ON birthdays(user_id, updated_at);

CREATE TABLE IF NOT EXISTS settings (
  user_id    TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS release_notes (
  version      TEXT    NOT NULL,
  release_date TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  items        TEXT    NOT NULL DEFAULT '[]',
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (version)
);

INSERT OR IGNORE INTO release_notes (version, release_date, title, items, created_at) VALUES
('0.1.8', '2026-10-14', '\u56FD\u5185\u514D VPN \u540C\u6B65', '["\u7ECF\u56FD\u5185\u4EE3\u7406\u5730\u5740\u5373\u53EF\u540C\u6B65,\u65E0\u9700 VPN","\u4FEE\u590D\u8001\u7248\u672C\u4E91\u7AEF\u6570\u636E\u5E93\u7F3A\u5217\u5BFC\u81F4\u7684\u540C\u6B65\u5931\u8D25","\u540C\u6B65\u5931\u8D25\u65F6\u754C\u9762\u663E\u793A\u670D\u52A1\u5668\u8FD4\u56DE\u7684\u5177\u4F53\u539F\u56E0"]', '2026-10-14T10:00:00.000Z'),
('0.1.7', '2026-10-14', '\u540C\u6B65\u4FEE\u590D\u4E0E\u4F53\u9A8C\u4F18\u5316', '["\u4FEE\u590D\u8001\u7248\u672C\u4E91\u7AEF\u6570\u636E\u5E93\u5BFC\u81F4\u7684\u540C\u6B65\u5931\u8D25","\u540C\u6B65\u5931\u8D25\u65F6\u663E\u793A\u670D\u52A1\u5668\u8FD4\u56DE\u7684\u5177\u4F53\u539F\u56E0","\u4E0B\u8F7D\u9875\u754C\u9762\u4E00\u89C8\u652F\u6301\u5927\u56FE\u6A2A\u5411\u6EDA\u52A8\u6D4F\u89C8"]', '2026-10-14T08:00:00.000Z'),
('0.1.6', '2026-10-13', '\u5168\u65B0\u5916\u89C2\u4E0E\u540C\u6B65\u4F18\u5316', '["\u5168\u65B0\u5E94\u7528\u56FE\u6807\u4E0E\u5B98\u7F51\u914D\u8272","\u8BBE\u7F6E\u9875\u65B0\u589E\u8D5B\u535A\u3001\u52A8\u6F2B\u4E24\u6B3E\u7CBE\u9009\u80CC\u666F","\u81EA\u52A8\u540C\u6B65\u95F4\u9694\u53EF\u9009 5 \u5206\u949F\u81F3 12 \u5C0F\u65F6","\u5B98\u7F51\u65B0\u589E\u7248\u672C\u66F4\u65B0\u8BB0\u5F55\u9875\u9762"]', '2026-10-13T08:00:00.000Z'),
('0.1.5', '2026-10-12', '\u9996\u4E2A\u516C\u5F00\u7248\u672C', '["\u8D34\u8FB9\u60AC\u6D6E\u5F85\u529E\u680F,\u9F20\u6807\u4E00\u5212\u5373\u51FA","\u65E5 / \u5468 / \u6708\u89C6\u56FE\u4E0E\u4E07\u5E74\u5386\u8282\u5047\u65E5","\u751F\u65E5\u4E0E\u7EAA\u5FF5\u65E5\u63D0\u9192","\u5185\u7F6E\u8BA1\u7B97\u5668:\u8BA1\u7B97\u3001\u65E5\u671F\u3001\u6C47\u7387\u6362\u7B97","\u591A\u8BBE\u5907\u4E91\u540C\u6B65","\u81EA\u5B9A\u4E49\u5B57\u4F53\u4E0E\u80CC\u666F"]', '2026-10-12T08:00:00.000Z');
`;
async function applySchema(db) {
  const statements = SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean);
  for (const sql of statements) {
    try {
      await db.exec(sql + ";");
    } catch {
    }
  }
  const alters = [
    "ALTER TABLE tasks ADD COLUMN sort_order INTEGER",
    "ALTER TABLE tasks ADD COLUMN recurrence TEXT",
    "ALTER TABLE tasks ADD COLUMN completed_dates TEXT",
    "ALTER TABLE tasks ADD COLUMN deleted_dates TEXT",
    "ALTER TABLE tasks ADD COLUMN series_id TEXT",
    "ALTER TABLE birthdays ADD COLUMN kind TEXT NOT NULL DEFAULT 'birthday'",
    "ALTER TABLE birthdays ADD COLUMN avatar TEXT"
  ];
  for (const sql of alters) {
    try {
      await db.exec(sql);
    } catch {
    }
  }
}
var TASK_COLUMNS = [
  "id",
  "user_id",
  "parent_id",
  "list_id",
  "title",
  "notes",
  "meta",
  "priority",
  "is_important",
  "is_pinned",
  "done",
  "due_date",
  "remind_at",
  "deleted_at",
  "sort_order",
  "recurrence",
  "completed_dates",
  "deleted_dates",
  "series_id",
  "created_at",
  "updated_at"
];
async function listTasksSince(db, userId, since) {
  const sql = since ? `SELECT * FROM tasks WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC` : `SELECT * FROM tasks WHERE user_id = ? ORDER BY updated_at ASC`;
  const bind = since ? [userId, since] : [userId];
  const result = await db.prepare(sql).bind(...bind).all();
  return result.results;
}
async function upsertTasks(db, userId, tasks) {
  let accepted = 0;
  for (const t of tasks) {
    const sql = `
      INSERT INTO tasks (
        ${TASK_COLUMNS.join(", ")}
      ) VALUES (
        ${TASK_COLUMNS.map(() => "?").join(", ")}
      )
      ON CONFLICT(id) DO UPDATE SET
        user_id=excluded.user_id,
        parent_id=excluded.parent_id,
        list_id=excluded.list_id,
        title=excluded.title,
        notes=excluded.notes,
        meta=excluded.meta,
        priority=excluded.priority,
        is_important=excluded.is_important,
        is_pinned=excluded.is_pinned,
        done=excluded.done,
        due_date=excluded.due_date,
        remind_at=excluded.remind_at,
        deleted_at=excluded.deleted_at,
        sort_order=excluded.sort_order,
        recurrence=excluded.recurrence,
        completed_dates=excluded.completed_dates,
        deleted_dates=excluded.deleted_dates,
        series_id=excluded.series_id,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at
      WHERE excluded.updated_at > tasks.updated_at
        AND tasks.user_id = excluded.user_id
    `;
    const params = [
      t.id,
      userId,
      t.parent_id ?? null,
      t.list_id,
      t.title,
      t.notes ?? null,
      t.meta ?? null,
      t.priority,
      t.is_important ? 1 : 0,
      t.is_pinned ? 1 : 0,
      t.done ? 1 : 0,
      t.due_date ?? null,
      t.remind_at ?? null,
      t.deleted_at ?? null,
      t.sort_order ?? null,
      t.recurrence ?? null,
      t.completed_dates ?? null,
      t.deleted_dates ?? null,
      t.series_id ?? null,
      t.created_at,
      t.updated_at
    ];
    await db.prepare(sql).bind(...params).run();
    accepted += 1;
  }
  return accepted;
}
async function hardDeleteTasks(db, userId, ids) {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const sql = `DELETE FROM tasks WHERE user_id = ? AND id IN (${placeholders})`;
  const result = await db.prepare(sql).bind(userId, ...ids).run();
  return Number(result.meta.changes ?? ids.length);
}
async function getSettings(db, userId) {
  const row = await db.prepare("SELECT payload, updated_at FROM settings WHERE user_id = ?").bind(userId).first();
  return row ?? null;
}
async function putSettings(db, userId, payload, updatedAt) {
  await db.prepare(
    `INSERT INTO settings (user_id, payload, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         payload=excluded.payload,
         updated_at=excluded.updated_at
       WHERE excluded.updated_at > settings.updated_at`
  ).bind(userId, payload, updatedAt).run();
}
var BIRTHDAY_COLUMNS = [
  "id",
  "user_id",
  "name",
  "relation",
  "kind",
  "avatar",
  "calendar",
  "month",
  "day",
  "is_leap_month",
  "remind_enabled",
  "remind_hour",
  "remind_minute",
  "remind_days_before",
  "note",
  "deleted_at",
  "created_at",
  "updated_at"
];
async function listBirthdaysSince(db, userId, since) {
  const sql = since ? `SELECT * FROM birthdays WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC` : `SELECT * FROM birthdays WHERE user_id = ? ORDER BY updated_at ASC`;
  const bind = since ? [userId, since] : [userId];
  const result = await db.prepare(sql).bind(...bind).all();
  return result.results;
}
async function upsertBirthdays(db, userId, birthdays) {
  let accepted = 0;
  for (const b of birthdays) {
    const sql = `
      INSERT INTO birthdays (
        ${BIRTHDAY_COLUMNS.join(", ")}
      ) VALUES (
        ${BIRTHDAY_COLUMNS.map(() => "?").join(", ")}
      )
      ON CONFLICT(id) DO UPDATE SET
        user_id=excluded.user_id,
        name=excluded.name,
        relation=excluded.relation,
        kind=excluded.kind,
        avatar=excluded.avatar,
        calendar=excluded.calendar,
        month=excluded.month,
        day=excluded.day,
        is_leap_month=excluded.is_leap_month,
        remind_enabled=excluded.remind_enabled,
        remind_hour=excluded.remind_hour,
        remind_minute=excluded.remind_minute,
        remind_days_before=excluded.remind_days_before,
        note=excluded.note,
        deleted_at=excluded.deleted_at,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at
      WHERE excluded.updated_at > birthdays.updated_at
        AND birthdays.user_id = excluded.user_id
    `;
    const params = [
      b.id,
      userId,
      b.name,
      b.relation ?? null,
      b.kind ?? "birthday",
      b.avatar ?? null,
      b.calendar,
      b.month,
      b.day,
      b.is_leap_month ? 1 : 0,
      b.remind_enabled ? 1 : 0,
      b.remind_hour,
      b.remind_minute,
      b.remind_days_before,
      b.note ?? null,
      b.deleted_at ?? null,
      b.created_at,
      b.updated_at
    ];
    await db.prepare(sql).bind(...params).run();
    accepted += 1;
  }
  return accepted;
}
async function hardDeleteBirthdays(db, userId, ids) {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const sql = `DELETE FROM birthdays WHERE user_id = ? AND id IN (${placeholders})`;
  const result = await db.prepare(sql).bind(userId, ...ids).run();
  return Number(result.meta.changes ?? ids.length);
}
export {
  SCHEMA_SQL,
  applySchema,
  getSettings,
  hardDeleteBirthdays,
  hardDeleteTasks,
  listBirthdaysSince,
  listTasksSince,
  putSettings,
  upsertBirthdays,
  upsertTasks
};
