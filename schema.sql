-- TEJOY AI 自动获客系统 D1 表结构
-- 一次定稳，覆盖 P1-P4，后续阶段不用改库结构

-- 线索主表：客户生命周期的核心
-- status: new(新导入) -> analyzed(AI已打分) -> pending(待审核)
--        -> approved(批准) -> queued(待发) -> sent(已发)
--            -> replied / no_reply / unsubscribed / bounced
--        -> ignored(忽略) / blacklisted(黑名单)
CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name  TEXT,
  website       TEXT,
  email         TEXT,
  country       TEXT,
  source        TEXT,              -- csv / search_api / directory / expo ...
  keyword       TEXT,              -- 命中的关键词
  status        TEXT NOT NULL DEFAULT 'new',
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_email   ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_website ON leads(website);

-- AI 分析结果（P2 写入），与 leads 一对一
CREATE TABLE IF NOT EXISTS lead_analysis (
  lead_id           INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  customer_type     TEXT,          -- 客户类型（AI 自由描述，细分，详情展示用）
  customer_category TEXT,          -- 规范分类（固定枚举，列表徽章/筛选用，见 taxonomy.ts）
  match_score       INTEGER,       -- 匹配分数 0-100
  needed_products   TEXT,          -- 可能需求产品
  reason            TEXT,          -- 判断理由
  recommended_email TEXT,          -- 推荐开发信草稿
  model             TEXT,          -- 所用模型
  analyzed_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 发信记录（P3 写入）
CREATE TABLE IF NOT EXISTS emails (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id           INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  subject           TEXT,
  body              TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',  -- queued/sent/failed/bounced
  provider_id       TEXT,          -- Resend 返回的 id
  unsubscribe_token TEXT,          -- 退订 token
  sent_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_emails_lead   ON emails(lead_id);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);

-- 回复记录（P4 写入）
CREATE TABLE IF NOT EXISTS replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  category     TEXT,               -- interested/inquiry/not_interested/complaint...
  content      TEXT,
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_replies_lead ON replies(lead_id);

-- 关键词库（优化引擎，P5）
CREATE TABLE IF NOT EXISTS keywords (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword     TEXT UNIQUE NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  sent_count  INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 全局配置（客户画像、每日发信上限、黑名单规则等）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
