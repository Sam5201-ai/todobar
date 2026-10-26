# Todobar 同步后端域名部署教程（小白版）

> 目标：给 Todobar 的同步后端（Cloudflare Worker）绑定你自己的域名
> **`https://sync.tuanzhang.site`**
> 全程分两大块：先在 **Cloudflare** 添加站点，再回 **腾讯云** 加一条委派记录。
> 你现有的两个网站完全不受影响，放心操作。

---

## 开始前要准备的东西

| 东西 | 说明 |
|---|---|
| Cloudflare 账号 | 免费。去 dash.cloudflare.com 注册一个（邮箱注册即可） |
| 腾讯云已登录 | 截图里那个页面（我的域名）能用就行 |
| 大约 30 分钟 | 大部分时间是等生效，实际操作就几分钟 |

---

## 第一阶段：在 Cloudflare 添加站点（拿到两个 NS 地址）

**第 1 步**：浏览器打开 <https://dash.cloudflare.com>，登录你的 Cloudflare 账号。

**第 2 步**：在左侧菜单找到 **「Add a site / 添加站点」**（英文界面叫 Add a site，中文界面叫"添加站点"），点它。

**第 3 步**：在弹出的输入框里填写：

```
sync.tuanzhang.site
```

⚠️ **注意**：一定要填 **完整的子域名**（带 `sync.` 前缀），不要只填 `tuanzhang.site`。填错会导致后面所有步骤对不上。

**第 4 步**：选择套餐页面，选最左边的 **Free（免费）**，点 **Continue / 继续**。

**第 5 步**：Cloudflare 会自动扫描 DNS 记录。因为 `sync.tuanzhang.site` 是个全新子域、没有任何记录，**扫出来是空的很正常**，直接点 **Continue / 继续**。

**第 6 步**：这时 Cloudflare 会显示 **两个 nameserver（NS）地址**，长这样：

```
xxx.ns.cloudflare.com
yyy.ns.cloudflare.com
```

（xxx/yyy 是随机分配的两个字母，每个人不一样）

**把这两个地址复制下来**，粘到记事本里，下一步要贴到腾讯云。

---

## 第二阶段：在腾讯云添加委派记录

这一步的意思是告诉腾讯云："`sync.tuanzhang.site` 这个子域名的解析权，交给 Cloudflare 管，其他记录你们照旧。"

**第 1 步**：打开腾讯云控制台 <https://console.cloud.tencent.com>，登录，进到截图里那个 **「我的域名」** 页面（左侧菜单：域名与注册 → 我的域名）。

**第 2 步**：找到 `tuanzhang.site` 那一行，点最右边的 **「解析」** 按钮，进入 DNSPod 解析页面。

**第 3 步**：点页面上方的 **「添加记录」** 按钮，按下面填写**第一条**：

| 项目 | 填什么 |
|---|---|
| 主机记录 | `sync` |
| 记录类型 | `NS`（有的界面显示"NS-委派"，选它） |
| 线路类型 | 默认 |
| 记录值 | 粘贴 Cloudflare 给的**第一个** NS 地址 |
| TTL | 600（默认即可） |

点 **保存**。

**第 4 步**：再点一次 **「添加记录」**，填写**第二条**（和第一步几乎一样，只有记录值不同）：

| 项目 | 填什么 |
|---|---|
| 主机记录 | `sync` |
| 记录类型 | `NS` |
| 线路类型 | 默认 |
| 记录值 | 粘贴 Cloudflare 给的**第二个** NS 地址 |
| TTL | 600 |

点 **保存**。

**第 5 步**：确认记录列表里出现了**两条** `sync` 类型的 NS 记录。

> ⚠️ **千万不要动** `@`、`www` 等其他任何记录——它们是你现有网站的命根子，只加不改。
> 如果保存时提示"记录已存在"，说明这条已加过，跳过即可。

---

## 第三阶段：等待生效

**第 1 步**：回到 Cloudflare 的站点列表页面，找到 `sync.tuanzhang.site`，状态会显示 **Pending / 待处理**。

**第 2 步**：每隔几分钟点一下 **「Check nameservers / 重新检查」** 按钮（或直接刷新页面），等状态变成 **Active / 正常**。

- 通常 **5～30 分钟**生效；
- 慢的话可能要几小时，都属正常，不用重复加记录。

---

## 第四阶段：部署 Worker 并绑定域名

等 Cloudflare 显示 **Active** 后，就可以部署后端了。

### 方式 A：把 token 给我，我来部署（最省事）

你需要一个 Cloudflare API Token（创建方法见文末附录），发给我，我会完成：
1. 部署 Worker（`todobar-sync`）
2. 自动绑定 `sync.tuanzhang.site` 自定义域名（wrangler 会替你在 Cloudflare 里建好 DNS 记录）
3. 执行 D1 数据库迁移
4. 验证 `https://sync.tuanzhang.site/api/health` 返回正常

### 方式 B：自己部署（会一点命令行的话）

**第 1 步**：在项目目录 `todobar/sync-worker/wrangler.toml` 末尾加上：

```toml
routes = [{ pattern = "sync.tuanzhang.site", custom_domain = true }]
```

**第 2 步**：创建 API Token（方法见文末附录），然后在命令行执行：

```bash
cd todobar/sync-worker
# Windows CMD:
set CLOUDFLARE_API_TOKEN=你的token
# Windows PowerShell:
$env:CLOUDFLARE_API_TOKEN="你的token"

npx wrangler deploy
npx wrangler d1 migrations apply todobar
```

部署成功后，wrangler 会提示域名绑定成功（它自动在 Cloudflare DNS 里创建了 CNAME 记录）。

---

## 第五阶段：验证

**第 1 步**：浏览器打开：

```
https://sync.tuanzhang.site/api/health
```

看到类似 `{"ok":true,"time":"..."}` 的返回，就说明**全部打通了**。

**第 2 步**：如果浏览器提示 **证书错误/不安全**，不要慌——Cloudflare 签发 SSL 证书需要约 15 分钟，等等再刷新就好了。

---

## 第六阶段：在 Todobar 里填上同步地址

**第 1 步**：打开 Todobar 桌面端 → 右上角**齿轮图标**（设置）。

**第 2 步**：找到同步配置区域，填写：

| 项目 | 填什么 |
|---|---|
| Worker 地址 | `https://sync.tuanzhang.site` |
| 同步令牌 | `a8a151bba6093d833e412e950fce6f17a62c68a9e122230e` |

**第 3 步**：保存，点 **「立即同步」**。看到"已同步"提示就大功告成了，之后家里几台电脑/设备填同样地址和令牌即可共享数据。

---

## 常见问题（遇到再看）

**Q1：Cloudflare 提示无法添加子域名站点 / 要求付费？**
→ 把两个 NS 地址发给我，我帮你确认；实在不行就用备选方案：不改 DNS，直接用 `todobar-sync.xxxx.workers.dev` 默认地址（功能完全一样，只是地址长、国内访问慢一点）。

**Q2：状态一直 Pending，不变 Active？**
→ 检查腾讯云那两条 NS 记录的主机记录是不是 `sync`（不是 `@`）、记录值有没有抄错。改完后最多再等 24 小时。

**Q3：我现有的网站打不开了！**
→ 理论上不可能。只可能误删/误改了 `@`、`www` 记录，去腾讯云解析页面检查这两个记录是否完好即可。

**Q4：D1 数据库报错 "no such table"？**
→ 迁移没跑。执行 `npx wrangler d1 migrations apply todobar` 即可（方式 A 我会帮你跑）。

---

## 附录：创建 Cloudflare API Token（方式 B 才需要）

**第 1 步**：Cloudflare 右侧头像 → **My Profile / 我的配置文件** → 左侧 **API Tokens / API 令牌** → **Create Token / 创建令牌**。

**第 2 步**：找到 **「Edit Cloudflare Workers」** 模板，点 **Use template / 使用模板**。

**第 3 步**：直接下拉到底，点 **Continue to summary / 继续** → **Create Token / 创建令牌**。

**第 4 步**：把生成的 token 复制下来（**只显示这一次**，弄丢了就重新建一个）。

> 🔐 **安全提醒**：这个 token 等于你 Cloudflare 的钥匙，不要发到群里或截图外传。如果你不放心，选方式 A 时也用同样方法创建，用完可以在 Cloudflare 里一键删除它。
