# TEJOY AI 自动获客系统

为 [tejoy.com](https://tejoy.com/)（星链 Starlink 配件电商）自动寻找有配件需求的 B2B 客户。
全 Serverless 架构：Cloudflare Workers + D1 + 静态资源 + OpenRouter + Resend + Migadu。

## 分阶段路线

- **P0 域名**（并行）：tejoy.net 配 SPF/DKIM/DMARC + Resend 发 + Migadu 收
- ✅ **P1 后台 + D1 + CSV 导入**
- ✅ **P2 接 OpenRouter**：抓官网 + 打分 + 写开发信 ← 当前（需填 OpenRouter key 才能实跑）
- **P3** 接 Resend：低量发信 + 退订 + 状态回写
- **P4** 接 Migadu：收回复 + 分类
- **P5** 自动搜索采集（数据验证有效后）

## 启用 AI 分析（P2）

1. 去 https://openrouter.ai/keys 生成 key，填进 `.dev.vars` 的 `OPENROUTER_API_KEY=`
2. 重启 `npm run dev`
3. 后台点某条线索 →「AI 分析」，或工具栏「批量 AI 分析」（一次处理 5 条 new 线索）
4. 模型可在 `wrangler.jsonc` 的 `vars` 里改：`SCORE_MODEL`（打分，便宜）、`EMAIL_MODEL`（写信，质量高）
5. 「客户画像」按钮可编辑打分/写信依据；抓取效果自查：`GET /api/debug/scrape?url=<网址>`

## 本地开发

```bash
npm install
npm run db:init:local     # 建表（本地 D1）
npm run db:seed:local     # 可选：灌 5 条样例数据
npm run dev               # 打开 http://localhost:8787
```

后台功能（P1）：客户列表（按状态分组）、详情、CSV 导入（自动去重）、批准/忽略/黑名单。

## 部署到 Cloudflare（P1 完成后）

```bash
npx wrangler login
npx wrangler d1 create tejoy_getke          # 把返回的 database_id 填进 wrangler.jsonc
npm run db:init:remote
npm run deploy
```

## 目录

- `src/index.ts` — Worker + Hono API
- `src/csv.ts` — CSV 解析与字段映射
- `public/index.html` — 后台前端（零构建）
- `schema.sql` — D1 表结构（覆盖 P1–P4）
- `wrangler.jsonc` — Cloudflare 配置
