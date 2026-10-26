-- Todobar sync backend schema (D1 / SQLite)
-- Applied automatically by `wrangler deploy` using this migrations directory.

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
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_updated ON tasks(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_parent  ON tasks(user_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_list    ON tasks(user_id, list_id);

CREATE TABLE IF NOT EXISTS settings (
  user_id    TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (user_id)
);
