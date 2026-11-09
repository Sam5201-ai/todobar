# Release Checklist

Use this before any public beta release.

## Code

- build passes
- lint passes
- native smoke tests pass on Windows
- native smoke tests pass on macOS
- migrations tested from previous version
- export/import tested
- update check tested

## Product

- default shortcuts documented
- shortcut collision handling works
- launch-at-login setting works
- settings window works
- offline startup works
- no hidden network calls
- AI disabled unless configured
- connectors disabled unless configured

## Security And Privacy

- no API keys in repo
- no secrets in logs
- data export works
- delete-all-data works
- connector scopes visible
- external writes require confirmation
- audit log records AI/MCP actions
- privacy policy updated
- security policy updated

## Distribution

- Windows installer generated
- Windows installer signed for beta
- macOS DMG generated
- macOS app signed and notarized for beta
- updater artifacts generated and signed
- release notes written
- checksums published
- **`release/version.json` 已更新**：`version` / `url?v=<版本>` / `notes`（应用靠它判定新版本与安装包地址；`notes` 是弹窗文案的兜底）
- **后台版本记录已补录**：`POST /api/admin/releases` 写入本版本的 `version` / `release_date` / `title` / `items[]`。
  桌面端首页更新弹窗直接按版本号读这条记录取文案；漏录时虽会回退 `version.json.notes`，
  但跨版本场景下的「期间还发布了 N 个版本」计数会不准，且应用内「版本记录」页会缺一条
- **`release/changelog.html` 已补条目**并前移「最新」徽标与 CTA 版本号（该页是静态快照，不会自动生成）

## Open Source

- license present
- contributor guide present
- issue templates present
- known limitations documented
- roadmap current
- source bibliography current

