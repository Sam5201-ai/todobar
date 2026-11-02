-- v2 统计口径:analytics_events 补 uid/device/sess,新增 identity_links + site_downloads
-- 下载站与 App 埋点改用统一的账号/设备/会话三层身份,解决漏斗各层口径不一致问题。

ALTER TABLE analytics_events ADD COLUMN uid TEXT NOT NULL DEFAULT '';
ALTER TABLE analytics_events ADD COLUMN device TEXT NOT NULL DEFAULT '';
ALTER TABLE analytics_events ADD COLUMN sess TEXT NOT NULL DEFAULT '';
ALTER TABLE analytics_events ADD COLUMN ip TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_events_device ON analytics_events(device, ts);
CREATE INDEX IF NOT EXISTS idx_events_uid ON analytics_events(uid, ts);

CREATE TABLE IF NOT EXISTS identity_links (
  device     TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_uid ON identity_links(uid);

CREATE TABLE IF NOT EXISTS site_downloads (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL DEFAULT '',
  ip     TEXT NOT NULL DEFAULT '',
  ua     TEXT NOT NULL DEFAULT '',
  ts     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_dl_ts ON site_downloads(ts);
CREATE INDEX IF NOT EXISTS idx_site_dl_device ON site_downloads(device, ts);
