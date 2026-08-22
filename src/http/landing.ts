/** GET / 落地页:项目简介、特性、接入方式、开源地址。自包含 HTML,无外部资源。 */

export const REPO_URL = 'https://github.com/AzumaChiaki/AzkiDeck-mcp-server';

export function landingPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AzkiDeck MCP 中继服务器</title>
<style>
  :root {
    --bg: #faf9f7; --fg: #1c1b1a; --muted: #6b6862; --card: #ffffff;
    --line: #e6e3de; --accent: #b35900; --accent-soft: #f7ecdf;
    --code-bg: #f2f0ec;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161513; --fg: #eceae6; --muted: #a09c94; --card: #201e1b;
      --line: #373430; --accent: #e8913d; --accent-soft: #33261a;
      --code-bg: #292724;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font: 16px/1.7 -apple-system, "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 48px 20px 64px; }
  header { margin-bottom: 40px; }
  .badge {
    display: inline-block; font-size: 12px; letter-spacing: .12em;
    color: var(--accent); background: var(--accent-soft);
    border-radius: 999px; padding: 3px 12px; margin-bottom: 16px;
  }
  h1 { font-size: 30px; line-height: 1.3; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin-top: 10px; }
  h2 { font-size: 18px; margin: 36px 0 12px; }
  p { margin: 8px 0; }
  .cards { display: grid; gap: 12px; grid-template-columns: 1fr; margin-top: 16px; }
  .card {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 12px; padding: 16px 18px;
  }
  .card h3 { font-size: 15px; margin-bottom: 4px; }
  .card p { font-size: 14px; color: var(--muted); }
  code, pre {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px;
  }
  pre {
    background: var(--code-bg); border: 1px solid var(--line);
    border-radius: 10px; padding: 14px 16px; overflow-x: auto; margin: 10px 0;
    white-space: pre;
  }
  p code { background: var(--code-bg); border-radius: 5px; padding: 1px 6px; }
  ol { padding-left: 22px; }
  ol li { margin: 6px 0; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .repo {
    display: inline-flex; align-items: center; gap: 8px; margin-top: 28px;
    border: 1px solid var(--line); border-radius: 999px; padding: 10px 20px;
    background: var(--card); font-size: 14px; font-weight: 500;
  }
  footer { margin-top: 48px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="badge">开源 · 自托管</span>
    <h1>AzkiDeck MCP 中继服务器</h1>
    <p class="sub">把你的手机变成随身携带的 MCP 服务器:Claude 等 AI 客户端随时随地调用手机能力——向手表推通知、装表盘、管图标,不再受局域网限制。</p>
  </header>

  <h2>它能做什么</h2>
  <div class="cards">
    <div class="card"><h3>📡 突破局域网</h3><p>手机 App 主动出站连接本服务器,绕开 NAT;换 Wi-Fi、用蜂窝网络都不影响,电脑端配置一次永久有效。</p></div>
    <div class="card"><h3>👥 多用户隔离</h3><p>一台服务器服务多人:凭证即租户,服务器只存凭证哈希,各用户的设备、工具、消息缓冲完全隔离。</p></div>
    <div class="card"><h3>📱 多设备聚合</h3><p>同一凭证可同时挂 iPhone 和安卓,工具列表自动合并,调用路由到最近活跃的设备。</p></div>
    <div class="card"><h3>🔁 离线补发</h3><p>手机断连 10 分钟内恢复,自动补发最近 5 分钟的通知;进度类自动合并,被清除的通知不再打扰。</p></div>
    <div class="card"><h3>🔒 公开/私有双模式</h3><p>公开模式填地址即可配对;私有模式额外要求部署密钥,可随时切换并强制已配对设备重新认证。</p></div>
  </div>

  <h2>三步接入</h2>
  <ol>
    <li>部署服务器(Node.js ≥ 22.13):
      <pre>npm install -g azkideck-mcp-server
azkideck-mcp-server serve</pre>
    </li>
    <li>手机 App(AzkiDeck,Android / iOS)→ 工具箱 → AI 通知桥接 → 中继模式:填入本服务器地址。凭证复用 App 的桥接令牌,私有模式再填部署密钥。</li>
    <li>MCP 客户端接入(以 Claude 为例):
      <pre>claude mcp add --scope user --transport http azki-watch \\
  https://你的服务器/mcp \\
  --header "Authorization: Bearer &lt;App 里的令牌&gt;"</pre>
    </li>
  </ol>
  <p>详细协议与部署文档见仓库 <code>docs/</code> 目录。</p>

  <a class="repo" href="${REPO_URL}">⭐ GitHub: AzumaChiaki/AzkiDeck-mcp-server(Apache-2.0)</a>

  <footer>AzkiDeck — 让腕上设备接入 AI 工作流。</footer>
</div>
</body>
</html>`;
}
