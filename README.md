# AzkiDeck-mcp-server

AzkiDeck 的多租户 **MCP 中继服务器**:让 MCP 客户端(Claude Desktop / Claude Code 等)随时随地连到用户手机上的 [AzkiDeck](https://github.com/AzumaChiaki) App(Android / iOS),把通知推上手表、安装表盘/快应用、管理通知图标——不再要求手机与电脑处于同一局域网。

```
MCP 客户端(Claude Desktop 等)
        │  POST /mcp  (Streamable HTTP, 无状态, Bearer 令牌)
        ▼
┌─────────────────────────────────────────────┐
│            azkideck-mcp-server              │
│  node:http ─┬─ /mcp      → MCP 分发          │
│             ├─ /device   → 设备接入(WS)      │
│             ├─ /admin/*  → 管理面            │
│             └─ /healthz                     │
│  多租户:凭证即租户,SHA-256 哈希隔离         │
│  持久化:SQLite(node:sqlite,零原生依赖)     │
└─────────────────────────────────────────────┘
        ▲  wss://server/device (手机出站连接,绕开 NAT)
        │  register → mcp-request/response ↔ replay
   Android / iOS App(复用 App 内已有的 MCP 核心)
```

## 特性

- **多租户隔离**:凭证即租户。凭证由手机 App 生成并持有(复用 App 的局域网桥接令牌),服务器只存 SHA-256 哈希;不同租户的设备、工具、缓冲完全隔离
- **多设备聚合**:同一凭证可挂多台手机(iPhone + 安卓),工具列表自动去重合并,调用路由到最近活跃的设备
- **离线补发**:设备断连 10 分钟内重连,补发最近 5 分钟内的通知类调用(进度类自动压实为最新一条,被 clear 的通知不再补);超窗判离线不补发
- **公开/私有双模式**:公开模式填地址即可配对;私有模式还需部署密钥;运行中可切换,切换时可选择是否要求已配对设备重新认证
- **极简依赖**:运行时仅 `ws` 一个依赖;Node ≥ 22.13(使用内置 `node:sqlite`)

## 快速开始

```bash
# 需要 Node.js ≥ 22.13。尚未发布到 npm registry,从源码安装:
git clone https://github.com/AzumaChiaki/AzkiDeck-mcp-server.git
cd AzkiDeck-mcp-server
npm ci && npm run build

node dist/cli.js serve     # 默认监听 0.0.0.0:8787
# 可选:npm link 注册全局 azkideck-mcp-server 命令
```

公网部署必须启用 TLS(内置 `TLS_CERT`/`TLS_KEY`,或用 Caddy/nginx 反代),详见 [docs/deployment.md](docs/deployment.md)。

### 手机端配置

1. App → 工具箱 → AI 通知桥接:确认已开启(令牌即在这里)
2. 中继模式(设置页):填入服务器地址,凭证自动复用桥接令牌;服务器为私有模式时还需填部署密钥
3. App 显示「中继已连接」即完成配对

### MCP 客户端接入

```bash
claude mcp add --scope user --transport http azki-watch \
  https://你的服务器/mcp --header "Authorization: Bearer <手机 App 里的令牌>"
```

多个客户端(电脑、笔记本、CI)可共享同一令牌。

### 假设备联调(无需手机)

```bash
azkideck-mcp-server serve &
node scripts/fake-device.mjs --server ws://127.0.0.1:8787 --credential <任意32位hex>
# 之后 Claude 里调用 send_notification,假设备终端会打印 payload
```

## 管理

```bash
azkideck-mcp-server tenants list                    # 租户列表
azkideck-mcp-server tenants create                  # 预置租户(AUTO_REGISTER=false 时)
azkideck-mcp-server tenants revoke <id前缀>         # 撤销
azkideck-mcp-server tenants allow <id前缀>          # 恢复
azkideck-mcp-server mode get                        # 查看公开/私有模式
azkideck-mcp-server mode set private --key <hex> [--reauth]
```

运行时管理 API(`ADMIN_TOKEN` 环境变量启用):

| 端点 | 说明 |
|---|---|
| `GET /healthz` | 公开健康检查,只含计数 |
| `GET /admin/tenants` | 租户列表(id 仅显示 8 位前缀) |
| `GET /admin/tenants/:id/devices` | 在线设备 |
| `POST /admin/tenants/:id/revoke` / `allow` | 撤销/恢复 |
| `GET /admin/mode` / `POST /admin/mode` | 查看/切换模式;`{"mode":"private","deployment_key":"<hex>","require_reauth":true}` |

## 配置(环境变量)

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | 8787 / 0.0.0.0 | 监听地址 |
| `DATA_DIR` | `./data` | SQLite 数据目录 |
| `AUTO_REGISTER` | `true` | 公开模式下设备首连自动建租户 |
| `ADMIN_TOKEN` | (无) | 设置后启用 `/admin/*` |
| `TLS_CERT` / `TLS_KEY` | (无) | 都设置则启用内置 HTTPS/WSS |
| `CALL_TIMEOUT_MS` / `INSTALL_TIMEOUT_MS` | 30000 / 60000 | 工具调用超时 |
| `BUFFER_TTL_MS` | 300000 | 离线缓冲保留 5 分钟 |
| `RECONNECT_WINDOW_MS` | 600000 | 断连补发窗口 10 分钟 |
| `RATE_MCP_PER_MINUTE` / `RATE_WS_PER_MINUTE` / `RATE_AUTH_FAIL_PER_MINUTE` | 120 / 600 / 20 | 限流 |

## 安全模型

- 服务器**永不存储凭证明文**(SHA-256 哈希),比较使用常量时间算法
- 公网部署请强制 TLS;令牌有 128bit 熵,401 按来源 IP 限流
- 撤销凭证立即生效:在线设备被踢、MCP 侧 401、且不会自动复活
- 私有模式把「谁能配对」收敛到持有部署密钥的人;`require_reauth` 切换可强制全部已配对设备重新认证

## 与局域网模式的关系

| | 局域网直连(App 内置) | 中继服务器 |
|---|---|---|
| 要求 | 电脑手机同网段 | 手机能上网即可 |
| 地址 | 换 Wi-Fi 会变 | 固定 |
| 数据路径 | 不经过第三方 | 经过中继(服务器只见哈希与转发的密文/调用内容) |
| 离线 | 直接失败 | 通知类排队补发 |

两者可同时开启,互不影响。

## 开发

```bash
npm install
npm run dev        # tsx watch
npm test           # vitest(含 e2e:真实端口 + 假设备)
npm run lint && npm run typecheck
```

协议细节见 [docs/protocol.md](docs/protocol.md)(手机端实现规范)。

## License

[Apache-2.0](LICENSE)
