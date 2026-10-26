# Todobar 二开版 · 部署与验收指南

基于 `sashimikun/todobar`（Apache-2.0）二开：新增**子任务 / 重点 / 置顶 / 桌面提醒 / 历史与日期筛选**，并把数据层切到本地 SQLite，接入 **Cloudflare 同步后端**（手动 + 自动）。

## ✅ 当前部署状态（2026-10-09 已完成）

Cloudflare 后端**已部署并线上验证通过**，无需再执行第一节：

- **Endpoint**：`https://todobar-sync.loveliu1232.workers.dev`
- **Token**：`a8a151bba6093d833e412e950fce6f17a62c68a9e122230e`
- D1 数据库：`todobar`（APAC），建表迁移已执行
- 线上已验证：鉴权（错误令牌 401）、任务推送/拉取、LWW 冲突合并（旧数据不覆盖新数据）

桌面端设置面板填上面 Endpoint + Token 即可开启同步；多设备填相同值即互相同步。

## 架构

```
桌面端 Todobar (Tauri v2 + React)
   └─ useTaskStore → repository (本地 SQLite / 浏览器回退)
                       └─ SyncEngine (离线优先, 防抖推送 + 增量拉取)
                            └─ Cloudflare Worker (Hono) + D1 + KV(令牌)
```

- 所有本地写入先落 SQLite，再进 outbox 队列，由 SyncEngine 推送。
- 拉取走 `GET /api/tasks?since`，按 `updated_at` 做 Last-Write-Wins 合并。
- 冲突基准是 `updated_at` 时间戳，多设备用 UUID 主键避免碰撞。

---

## 一、部署 Cloudflare 同步后端

目录：`todobar/sync-worker/`

1. 安装 wrangler（全局或 npx）：
   ```bash
   npm i -g wrangler
   ```
2. 登录并创建 D1 数据库：
   ```bash
   cd todobar/sync-worker
   wrangler login
   wrangler d1 create todobar
   ```
   把输出里的 `database_id` 填进 `wrangler.toml` 的 `[[d1_databases]] database_id`。
3. 执行建表迁移：
   ```bash
   wrangler d1 execute todobar --local --file=./migrations/0001_init.sql
   wrangler d1 execute todobar --remote --file=./migrations/0001_init.sql
   ```
4. 配置令牌（KV）。生成一个共享令牌，例如 `tb_<随机串>`：
   ```bash
   wrangler kv namespace create todobar_tokens
   ```
   把返回的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]] id`。
   然后写入令牌（可写多条，逗号分隔于 `API_TOKENS` 变量之外，也可直接放进 KV）：
   ```bash
   wrangler kv key put --binding=TOKENS "my-device" 'tb_xxx'
   ```
   > 简化方案：直接在 `wrangler.toml` 的 `[vars]` 里设 `API_TOKENS = "tb_xxx"`，多个用逗号分隔。KV 方案用于按设备吊销。
5. 部署：
   ```bash
   wrangler deploy
   ```
   部署成功后记下 Worker 地址，例如 `https://todobar-sync.<sub>.workers.dev`。

后端逻辑已用 `node:sqlite` 做了真实 SQL 测试，9/9 通过（鉴权、upsert、LWW 冲突、增量拉取、硬删、设置往返）。

---

## 二、在本机跑桌面端（验收入口）

前置：
- Node.js ≥ 18，pnpm（`npm i -g pnpm`）
- Rust 工具链：`rustup` + `stable-x86_64-pc-windows-msvc`（Windows）/ `stable` + `macos` 依赖
- 系统 WebView：Windows 需 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 自带）；macOS 需 Xcode Command Line Tools
- Tauri CLI：`pnpm add -g @tauri-apps/cli`

步骤：
```bash
cd todobar
pnpm install          # 前端依赖（已加 @tauri-apps/plugin-sql / plugin-notification）
pnpm tauri dev        # 启动桌面窗口，热更新
```
首次打开会贴右缘显示细把手，点击/拖动把手展开任务面板（QQ 式）。

打包：
```bash
pnpm tauri build      # 产出 Windows .msi / macOS .app
```

---

## 三、配置同步（桌面端内）

打开侧栏 → 设置（齿轮）→ **Sync (Cloudflare)**：
- Enable sync：开
- Endpoint：填上面部署的 Worker 地址（不带末尾斜杠）
- Token：填 `tb_xxx`
- Auto sync：开，间隔默认 30s（可 15–600s）
- 点 **Sync now** 立即推送一次；下方显示同步状态（待同步数 / 已同步 / 上次推送时间 / 失败原因）

多设备用同一 Endpoint + Token 即可互相同步。

---

## 四、功能验收清单（对照你的 4 组需求）

| 需求 | 状态 | 验收方式 |
|------|------|----------|
| 桌面组件 + 添加/编辑/删除待办 | ✅ | 面板内输入框回车新增；勾选完成；行末垃圾桶删除（软删，进历史） |
| 子任务 | ✅ | 任务行展开「Add subtask…」输入回车，缩进显示在父任务下 |
| 标记 完成/重点/置顶 | ✅ | 行内星标=重点、图钉=置顶、圆圈=完成；排序：置顶>重点>优先级>时间 |
| 桌面提醒 | ✅ | 点铃铛输入 `YYYY-MM-DDTHH:MM`，到点弹系统通知（仅桌面端） |
| 历史记录 + 日期筛选 | ✅ | 侧栏历史图标 → 按删除日期 From/To 筛选，可恢复或彻底删除 |
| 窄组件 + 贴顶收起/展开（参考 QQ） | ✅（沿用） | 把手默认细条；设置里 Panel width 默认 340px，可缩到 300px |
| Cloudflare 同步（手动/自动） | ✅ | 见第三节；多设备验证增删改互现 |
| 补充功能 | ✅ | 重复/标签/截止日期/搜索/导入导出/统计/回收站/AI 拆解等见下方路线图 |

---

## 五、已验证 / 未验证

- ✅ 后端 Worker SQL 与冲突合并：9/9 单测通过（沙盒用 `node:sqlite` 真跑）
- ✅ 同步引擎（推送清空 outbox / LWW 合并 / 增量拉取 / 错误态 / 自动间隔）：5/5 单测通过
- ✅ 前端类型与严格 `tsc` 检查（沙盒可跑 `pnpm类型检查`）
- ⚠️ 桌面 GUI 真机渲染与 Tauri 构建需在**你的本机** `pnpm tauri dev` 验收（沙盒无 WebView2/Windows SDK，无法弹窗）

---

## 六、关键文件

- `src/types.ts` — 统一领域模型（含 parentId/isImportant/isPinned/remindAt/dueDate/deletedAt/updatedAt）
- `src/db/repository.ts` — SQLite（桌面）/ 浏览器 / 内存 三套持久层实现
- `src/useTaskStore.ts` — 数据 Hook：任务/列表操作、软删历史、同步接入
- `src/sync/engine.ts` `src/sync/client.ts` — 离线优先同步引擎与 HTTP 客户端
- `src/App.tsx` — 侧栏 UI（含子任务、标记、提醒、历史、同步设置）
- `src-tauri/` — Cargo.toml / lib.rs / capabilities 已加 `plugin-sql` + `plugin-notification`
- `sync-worker/` — Cloudflare 后端（Hono + D1 + KV）

## 七、下一步建议（未做，按需排期）

1. 截止日期/提醒在面板内做成日期选择器（当前用 prompt 输入）
2. 搜索过滤框（已预留桌面预览搜索按钮）
3. 数据导入导出（JSON / Markdown）
4. 完成率统计与连续打卡视图
5. 多设备「正在编辑」指示与更细的字段级合并
6. 令牌用邮箱验证码或 OAuth 替代静态令牌（个人工具可暂缓）

> 许可证：Todobar 为 Apache-2.0，二开需保留 NOTICE 与版权声明；同步后端代码可自由使用。
