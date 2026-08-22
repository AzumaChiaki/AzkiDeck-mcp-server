# 部署

## 要求

- Node.js ≥ 22.13(内置 `node:sqlite`;22.5~22.12 需加 `--experimental-sqlite`)
- 公网部署**必须 TLS**(否则令牌与调用内容裸奔)

## 直接运行

```bash
npm install -g azkideck-mcp-server
ADMIN_TOKEN=<随机长串> azkideck-mcp-server serve
```

数据在 `./data/`(可用 `DATA_DIR` 改)。

## systemd(推荐)

把可执行包装成服务:

```ini
# /etc/systemd/system/azkideck-mcp-server.service
[Unit]
Description=AzkiDeck MCP relay server
After=network.target

[Service]
Type=simple
User=azkideck
WorkingDirectory=/var/lib/azkideck-mcp
Environment=DATA_DIR=/var/lib/azkideck-mcp/data
Environment=PORT=8787
Environment=ADMIN_TOKEN=换成随机长串
# 内置 TLS(二选一;用反代就别设):
# Environment=TLS_CERT=/etc/letsencrypt/live/azki.example.com/fullchain.pem
# Environment=TLS_KEY=/etc/letsencrypt/live/azki.example.com/privkey.pem
ExecStart=/usr/bin/azkideck-mcp-server serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

(仓库 `deploy/azkideck-mcp-server.service` 有同样示例。)

```bash
sudo systemctl enable --now azkideck-mcp-server
```

## 反代 TLS(Caddy 示例)

```
azki.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 自动签证书,WebSocket 无需额外配置。nginx 同理,记得带 `Upgrade`/`Connection` 头。

## 公开 / 私有模式

```bash
# 查看
azkideck-mcp-server mode get

# 转私有:新设备注册必须带部署密钥;--reauth 让已配对设备也必须重新认证
azkideck-mcp-server mode set private --key <32位hex> [--reauth]

# 转回公开
azkideck-mcp-server mode set public
```

也可以在运行中的服务器上改(立即踢设备生效):

```bash
curl -X POST https://azki.example.com/admin/mode \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"private","deployment_key":"<hex>","require_reauth":true}'
```

## 关闭自动注册(最严格)

`AUTO_REGISTER=false` 后,设备凭证必须先预置:

```bash
azkideck-mcp-server tenants create          # 生成并打印一次凭证
azkideck-mcp-server tenants create <hex>    # 预置已有凭证(如手机 App 里已有的令牌)
```

## 备份

只需备份 `DATA_DIR` 下的 SQLite 文件(`azkideck-mcp.db`)。丢了的代价:租户哈希表消失,所有设备需在 App 里重新配对(凭证不变,公开模式自动重建)。

## 升级

```bash
npm update -g azkideck-mcp-server && sudo systemctl restart azkideck-mcp-server
```
