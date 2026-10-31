# DrawDeck — 多模型 AI 创作（生图 + 生视频）

聚合智谱 / 商汤 / Agnes / Cloudflare / 魔搭 五家图像模型 + Agnes 视频模型，内置提示词中英互译、图生提示词、提示词库、多场景文生视频、角色设定图、参考图、动态背景的一体化 Web 工具。

## 功能

- **文生图**：多模型聚合（智谱 CogView-3-Flash、商汤日日新 U1.5 Lite、Cloudflare Flux1 / SDXL-Lightning / SDXL-Base、Agnes Image 2.1 / 2.5 Flash、魔搭 Z-Image Turbo），单选/多选，自定义尺寸与张数，多组并发生成，按模型分组展示。
- **提示词中英互译**：Chrome 内置 Translator API 端侧翻译（不联网、数据不出设备），提示词 / 翻译结果双栏滑动切换。
- **图生提示词（反推）**：上传图片，视觉模型识别并生成提示词，可一键「📝 填入文生图」；支持智谱 glm-4.6v-flash / 商汤 / Agnes / 魔搭。
- **文生视频**：Agnes Video 2.5 Flash，多场景 + 场景衔接（一镜到底），720P、4–12 秒，结果集中展示、可批量下载。
- **角色设定图 / 参考图**：生成并共享角色设定图，跨场景保持角色一致；参考图支持 URL 或本地上传。
- **提示词库**：生成历史本地保存，中英双语、可复用。
- **动态背景**：默认渐变 / Vanta 动态特效（鸟群、圆环、星点、地球）/ 图片背景，选择持久化。
- **状态持久化**：提示词、模型勾选、尺寸、数量、反推模型、背景、当前页签等刷新不丢。
- **批量下载**：图片 / 视频一键打包下载（浏览器端 JSZip，无需服务端）。

## 目录结构

```
image-create/
├─ image-view.html      页面骨架（HTML 结构 + 弹层）
├─ assets/
│  ├─ style.css           全局样式
│  └─ js/                 模块化脚本（common → image → viewer → video → init）
├─ lib/                 Three.js / Vanta 等本地库（离线可用）
├─ functions/           Cloudflare Pages Functions（部署到 CF 时生效）
│  ├─ _lib.js             共享：上游地址 / CORS / 转发 / 图片代理
│  ├─ _middleware.js      统一处理 OPTIONS 预检
│  ├─ ping.js             /ping
│  ├─ img.js              /img?url= 图片代理（绕防盗链）
│  ├─ vimg.js             /vimg?url= 视频透传代理
│  ├─ agnesapi.js         /agnesapi 视频任务查询（轮询）
│  ├─ v1/[[path]].js      /v1/*      → 商汤
│  ├─ agnes/v1/[[path]].js /agnes/v1/* → Agnes
│  ├─ ms/v1/[[path]].js   /ms/v1/*   → 魔搭
│  └─ cf/run/[[path]].js  /cf/run/*  → Cloudflare Workers AI
└─ _routes.json         声明哪些路径走 Function（其余静态托管）
```

## 部署到 Cloudflare Pages（连 Git）

1. 把本目录推到 GitHub / GitLab 仓库（`git init` 后 push）。
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → 选该仓库。
3. 构建配置：
   - **Framework preset**：None
   - **Build command**：`cp image-view.html index.html`（让 CF 构建时生成默认入口 index.html）
   - **Build output directory**：`.`（若本目录是仓库根）或 `image-create`（若本目录是仓库子目录）
4. **Save and Deploy**。CF 会自动识别 `functions/` 目录并编译成 Worker 路由，与静态资源同域。

> 之后每次 push 代码，CF 自动重新构建部署。

## 模型 / Key 说明

各家 API Key 在「API Key」页签填写，存本机 localStorage，**各自用自己的 Key**，请求经 Functions 透传到上游（Bearer Token 原样转发）。

- 智谱 / 商汤 / Agnes / 魔搭：走对应 Function 转发（浏览器无法直连这些上游的 CORS）。
- Cloudflare：需填 **API Token + 账户 ID**，账户 ID 经 `X-CF-Account-Id` 头传给 Function 拼路径；留空则用 `functions/_lib.js` 里的 `DEFAULT_CF_ACCOUNT` 兜底。
- 图生提示词（反推）：支持智谱 glm-4.6v-flash、商汤、Agnes、魔搭（默认魔搭 `Qwen/Qwen3.8-27B`，可改成任意魔搭视觉模型名）。
- 文生视频：只用 Agnes **Video 2.5 Flash**，与 Agnes 图片共用同一个 Key。

## 安全提醒

公开部署后，任何人能访问页面、填自己的 Key 跑生成。流量算你的。建议：
- 加 **Cloudflare Access**（零信任）给页面加邮箱/密码验证；或
- 在 `functions/_middleware.js` 里加个简单的访问密码校验。

## 批量下载

纯前端实现：首次点「批量下载」时按需加载 JSZip（jsdelivr CDN），从 `/img` 代理逐张取 blob，浏览器端打包成 zip。无需服务端 `/dl-zip`。
