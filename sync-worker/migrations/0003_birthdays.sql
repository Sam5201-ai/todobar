-- 生日记录（每年重复的事项：历法 + 月 + 日 + 提醒时分）
CREATE TABLE IF NOT EXISTS birthdays (
  id                 TEXT    NOT NULL,
  user_id            TEXT    NOT NULL,
  name               TEXT    NOT NULL DEFAULT '',
  relation           TEXT,
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
