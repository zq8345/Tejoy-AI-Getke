-- 迁移：给已有 lead_analysis 加规范分类列（customer_category）
-- 已存在则忽略报错即可（重复执行安全）
ALTER TABLE lead_analysis ADD COLUMN customer_category TEXT;
CREATE INDEX IF NOT EXISTS idx_analysis_category ON lead_analysis(customer_category);
