-- 版本更新记录(官网下载页读取)
CREATE TABLE IF NOT EXISTS release_notes (
  version      TEXT    NOT NULL,
  release_date TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  items        TEXT    NOT NULL DEFAULT '[]',
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (version)
);
