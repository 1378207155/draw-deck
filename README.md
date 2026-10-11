# DrawDeck — 多模型 AI 生图

聚合智谱 / 商汤 / Agnes / Cloudflare / 魔搭 五家图像模型，内置提示词中英互译、图生提示词、提示词库的单文件 Web 工具。

## 目录结构

```
image-create/
├─ image-view.html      主程序（单文件：HTML + CSS + JS）
├─ server.py            本地开发服务器（Python，无需构建）
├─ start.bat            Windows 双击启动本地服务
├─ lib/                 Three.js / Vanta 等本地库（离线可用）
├─ functions/           Cloudflare Pages Functions（部署到 CF 时生效）
│  ├─ _lib.js             共享：上游地址 / CORS / 转发 / 图片代理
│  ├─ _middleware.js      统一处理 OPTIONS 预检
│  ├─ ping.js             /ping
│  ├─ img.js              /img?url= 图片代理（绕防盗链）
│  ├─ v1/[[path]].js      /v1/*      → 商汤
│  ├─ agnes/v1/[[path]].js /agnes/v1/* → Agnes
│  ├─ ms/v1/[[path]].js   /ms/v1/*   → 魔搭
│  └─ cf/run/[[path]].js  /cf/run/*  → Cloudflare Workers AI
├─ _routes.json         声明哪些路径走 Function（其余静态托管）
└─ wrangler.toml        CF Pages 部署配置（项目名 = drawdeck）
```

## 本地开发

双击 `start.bat`（或 `python server.py`），浏览器打开 `http://localhost:8000`。

- `server.py` 每次请求重读 `image-view.html`，改完前端 **Ctrl+F5 即时生效**。
- 本地用 `server.py` 提供转发（`/v1` `/agnes/v1` `/ms/v1` `/cf/run` `/img` `/dl-zip` `/ping`），`functions/` 在本地不生效（那是给 CF 的）。

## 部署到 Cloudflare Pages（连 Git）

1. 把本目录推到 GitHub / GitLab 仓库（`git init` 后 push）。
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → 选该仓库。
3. 构建配置：
   - **Framework preset**：None
   - **Build command**：`cp image-view.html index.html`（让 CF 构建时生成默认入口 index.html）
   - **Build output directory**：`.`（若本目录是仓库根）或 `image-create`（若本目录是仓库子目录）
4. **Save and Deploy**。CF 会自动识别 `functions/` 目录并编译成 Worker 路由，与静态资源同域。

部署后访问 `https://drawdeck.pages.dev`（项目名见 `wrangler.toml`，若被占用 CF 会提示改名）。

> 之后每次 push 代码，CF 自动重新构建部署。

## 模型 / Key 说明

各家 API Key 在「API Key」页签填写，存本机 localStorage，**各自用自己的 Key**，请求经 Functions 透传到上游（Bearer Token 原样转发）。

- 智谱 / 商汤 / Agnes / 魔搭：走对应 Function 转发（浏览器无法直连这些上游的 CORS）。
- Cloudflare：需填 **API Token + 账户 ID**，账户 ID 经 `X-CF-Account-Id` 头传给 Function 拼路径；留空则用 `functions/_lib.js` 里的 `DEFAULT_CF_ACCOUNT` 兜底。
- 图生提示词（反推）：支持智谱 glm-4.6v-flash、商汤、Agnes、魔搭（默认 `deepseek-ai/DeepSeek-V4.1-Flash`，可改成任意魔搭视觉模型名）。

## 安全提醒

公开部署后，任何人能访问页面、填自己的 Key 跑生成。流量算你的。建议：
- 加 **Cloudflare Access**（零信任）给页面加邮箱/密码验证；或
- 在 `functions/_middleware.js` 里加个简单的访问密码校验。

## 批量下载

纯前端实现：首次点「批量下载」时按需加载 JSZip（jsdelivr CDN），从 `/img` 代理逐张取 blob，浏览器端打包成 zip。无需服务端 `/dl-zip`。
