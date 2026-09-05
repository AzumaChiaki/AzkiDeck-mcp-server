# MCP 工具行为提示

中继没有固定的完整工具目录:手机在 `register.tools` 上报能力,服务器向 MCP 客户端聚合发布。已核对 Android/iOS 的 `McpEndpoint`、`AgentNotifier`、`AgentInstallService` 和 `AgentIconService`;目前两端共有以下 12 个工具。`scripts/fake-device.mjs` 只模拟其中 5 个,声明真实中继契约的保守风险,实际只打印调用并返回 `ok`。

## 逐工具判定

下表针对通过本中继调用的行为。R = `readOnlyHint`,D = `destructiveHint`,I = `idempotentHint`,O = `openWorldHint`。

| 工具 | R | D | I | O | 依据 |
|---|---|---|---|---|---|
| `send_notification` | false | true | false | true | 可指定已有 notification_id 覆盖通知;未指定则分配新 ID;每次生成新时间戳并推送。 |
| `report_progress` | false | true | false | true | 同 task 覆盖已有通知内容;在线重复调用仍刷新时间戳并发送,离线压实不等于全路径幂等。 |
| `request_action` | false | false | false | true | 新增待办提醒,每次产生通知;仅展示请求,不自动执行用户操作或回传选择。 |
| `clear_notification` | false | true | false | true | 删除设备通知并抵消待发通知;单设备删除本身可重复,但中继重复调用可增加队列项、挤掉旧项,也可路由到另一设备,故不承诺中继全路径幂等。 |
| `install_resource` | false | true | false | true | 下载或解码文件后创建新安装作业,可替换已有资源或切换当前表盘;重复调用会再次提交。 |
| `install_status` | true | false | true | true | 读取手机端安装作业记录,不创建或变更作业。 |
| `list_installed` | true | false | true | true | 查询手表上的表盘/快应用列表,不安装或删除资源。 |
| `set_watch_face` | false | true | false | true | 替换当前表盘选择;单设备设置固定 ID 可收敛到同一状态,但中继多设备路由没有固定目标或幂等键,重试可能修改另一台设备。 |
| `set_notification_icon` | false | true | false | true | 下载/解码图片,覆盖 app_id 对应的图标文件/登记状态;同 URL 内容可能变化,重复登记会重置上传状态。 |
| `list_notification_icons` | true | false | true | true | 读取图标目录及上传状态。 |
| `sender_info` | true | false | true | true | 读取默认发件人设置。 |
| `watch_status` | true | false | true | true | 读取设备连接、型号、电量快照。 |

`destructiveHint: true` 包含覆盖或删除已有状态,不等同于“存在漏洞”或“永久损坏”。读取结果随时间变化不影响读取的幂等性。这里所有 `openWorldHint` 都为 true:中继实际跨网络访问用户控制的手机/手表,安装和图标工具还可访问调用者提供的 URL;即便在手机内属于本地读取,从中继视角仍跨越外部边界。

## 兼容与校正

- 注册清洗保留有效的布尔提示和 `title`,不把字符串 `"false"` 当作布尔值。
- 已知工具缺失字段按上表补齐;设备明确声明更保守的风险时保留。设备不能用较宽松标注降低已知工具风险。
- 未知工具保留有效提示;缺失/非布尔字段使用 MCP 默认值 `false / true / false / true`,不根据名字前缀猜测只读或安全。
- `tools/list` 对旧数据库缓存也补齐字段,无需先迁移缓存或升级手机。多台在线设备提供同名工具时,风险取并集,不能只取先注册设备的安全声明。
- 手机端局域网直连目录属于各 App 仓库,本次只修改中继仓库;该直连模式不会自动获得这里的标注。

这些提示不构成鉴权、执行限制或设备可信性证明。参见 [MCP 官方 ToolAnnotations 说明](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) 和 [官方 SDK 字段定义](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/server/mcp.html)。

## M8ven 复查

截图中的 5/5 缺失提示来自可扫描的 5 个示例工具,不能代表手机全部能力。除了检查静态源代码,也应配对设备后检查 `/mcp` 的 `tools/list`,确认四字段在所有实际工具上均为布尔。远端扫描只有在维护者自行发布更新、M8ven 抓取新 commit 后才可能变化,本地修改不能直接改变评分。
