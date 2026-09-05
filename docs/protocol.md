# AzkiDeck 中继协议 v1(设备 ↔ 服务器)

本文档是手机端(Android/iOS)实现中继客户端的规范。服务器实现在 `src/relay/deviceSocket.ts`。

## 连接

- 地址:`wss://<服务器>/device`(本地开发可为 `ws://`)。只有 `/device` 路径接受 WS upgrade
- 每条消息是一个 JSON 文本帧,顶级必含 `type` 字段
- 连接建立后 **10 秒内**必须发送 `register`,否则服务器关闭连接
- 凭证只在 `register` 里携带(不放 WS 握手头),这样鉴权失败能收到结构化的 `register_error`,App 可以区分「凭证错」与「网络错」

## 消息

### register(设备 → 服务器,连接后首条)

```jsonc
{
  "type": "register",
  "protocol": 1,
  "credential": "<20~64 位小写 hex;即 App 局域网桥接令牌>",
  "deployment_key": "<仅私有模式必填>",
  "device_id": "<UUID,首启生成并持久化>",
  "platform": "android",            // "android" | "ios"
  "app_version": "1.4.2",
  "server_name": "azki-watch",
  "tools": [ { "name": "send_notification", "description": "…", "inputSchema": {…},
    "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": true } } ]
}
```

`tools` 就是该端 `tools/list` 的完整快照(与 App 内 McpEndpoint 的输出一致)。每个工具应显式声明四项布尔 `annotations`。中继保留有效提示,补全旧设备/旧缓存中的缺失字段,并按中继副作用校正;未知工具使用保守默认值。详见 [tool-annotations.md](tool-annotations.md)。

### registered(服务器 → 设备)

```jsonc
{ "type": "registered", "protocol": 1, "device_id": "…",
  "heartbeat_interval_ms": 25000, "replayed": 2, "server_time": 1789000000000 }
```

`replayed` 是紧随其后的 `replay` 消息里的条目数(没有则不会收到 `replay`)。

### register_error(服务器 → 设备,随后关闭连接)

```jsonc
{ "type": "register_error", "code": "credential_revoked", "message": "凭证已被管理员撤销" }
```

| code | 含义 | 设备端建议 |
|---|---|---|
| `invalid_credential` | 凭证格式不合法 | 提示重新生成令牌,不重连 |
| `credential_revoked` | 凭证被管理员撤销 | 提示用户,不重连 |
| `auto_register_disabled` | 服务器关闭自动注册且凭证未预置 | 提示联系管理员,不重连 |
| `deployment_key_required` | 私有模式,缺少部署密钥 | 提示填部署密钥,不重连 |
| `bad_deployment_key` | 部署密钥错误 | 提示检查密钥,不重连 |
| `unsupported_protocol` | protocol 版本不支持 | 提示升级 App,不重连 |
| `rate_limited` | 过频 | 退避重连 |

### mcp-request(服务器 → 设备)

```jsonc
{ "type": "mcp-request", "rid": "r_01JZK…",
  "payload": { "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {…} } }
```

- `rid` 由服务器分配,回包时原样带回
- `payload` 是原始 JSON-RPC 请求(batch 已在服务器拆成单条;通知类永不下发)

设备侧处理 = 把 payload 喂给 App 已有的 MCP 核心(Android `McpEndpoint.handle()` / iOS `McpEndpoint.handle`),输出作为回包:

```jsonc
// 成功
{ "type": "mcp-response", "rid": "r_01JZK…",
  "payload": { "jsonrpc": "2.0", "id": 7, "result": { "content": […], "isError": false } } }
// 处理异常
{ "type": "mcp-response", "rid": "r_01JZK…",
  "error": { "code": -32000, "message": "手表未连接" } }
```

### replay(服务器 → 设备,紧随 registered)

```jsonc
{ "type": "replay", "items": [
  { "rid": "replay_…", "queued_at": 1788999999000,
    "payload": { "jsonrpc": "2.0", "id": "replay-1", "method": "tools/call", "params": {…} } } ] }
```

离线期间排队的通知类调用。设备照常吃进 MCP 核心并逐条回 `mcp-response`(服务器只记录日志)。UI 日志可据 `replay_` 前缀标记为「补发」。

### ping / pong(应用层兜底)

```jsonc
{ "type": "ping", "ts": 1789000000000 }   // 服务器 → 设备
{ "type": "pong", "ts": 1789000000000 }   // 设备 → 服务器(回 ping,v1 只需照回)
```

主心跳是 WS 协议级 ping/pong(OkHttp 与 URLSessionWebSocketTask 都自动应 pong):服务器每 25s 一次,连续 2 次未 pong(≈60s)判定断开。

### error(双向通用)

```jsonc
{ "type": "error", "code": "bad_envelope", "message": "…" }
// code ∈ bad_envelope / oversized / not_registered
```

## 关闭码约定

| code | 含义 | 设备端行为 |
|---|---|---|
| 1000 | 正常 | 按退避重连 |
| 4000 | `replaced` 同 deviceId 新连接顶替 | **延迟 5s±jitter 再重连**(防互踢风暴) |
| 4001 | 鉴权失败 | 不重连,提示检查凭证/密钥 |
| 4002 | 限流 | 退避重连 |
| 4003 | `reauth_required` 模式切换要求重新认证 | 用「令牌 + 部署密钥」重新 register 即可恢复 |

## 重连策略(设备端)

指数退避 1s→2s→4s…封顶 30s,±20% jitter;收到 `registered` 后重置。服务器补发窗口是 10 分钟,封顶 30s 的退避保证断网恢复后有充足的补发机会。

## 离线补发语义(服务器侧行为,设备无需实现)

- 设备全员断连后开始计时:10 分钟内任一设备重连 → 补发最近 5 分钟内的通知类调用;超窗丢弃
- 缓冲上限 200 条/租户;`report_progress` 同 task 只留最新;`clear_notification` 抵消对应的待发通知
- 非通知类工具离线期间立即失败(-32002),不排队

## deviceId

App 首启生成 UUID 持久化(Android SharedPreferences / iOS UserDefaults),不随登出清除。卸载重装视为新设备,无副作用(工具归属表随 register 重建)。
