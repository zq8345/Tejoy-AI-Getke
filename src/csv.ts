// 轻量 CSV 解析：支持逗号分隔、双引号包裹、引号内换行与转义 ("")
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += ch;
    }
  }
  // 收尾最后一个字段/行
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // 去掉全空行
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export interface LeadRow {
  company_name: string;
  website: string;
  email: string;
  country: string;
  keyword: string;
}

// 表头别名映射：容忍中英文/常见写法
const ALIASES: Record<keyof LeadRow, string[]> = {
  company_name: ["company_name", "company", "name", "公司", "公司名", "公司名称", "客户名称"],
  website: ["website", "url", "site", "web", "网站", "网址", "官网"],
  email: ["email", "mail", "e-mail", "邮箱", "邮件"],
  country: ["country", "region", "国家", "地区"],
  keyword: ["keyword", "keywords", "关键词", "标签"],
};

export function mapRowToLead(header: string[], cells: string[]): LeadRow | null {
  const find = (field: keyof LeadRow): string => {
    for (const alias of ALIASES[field]) {
      const idx = header.indexOf(alias);
      if (idx !== -1) return (cells[idx] ?? "").trim();
    }
    return "";
  };
  return {
    company_name: find("company_name"),
    website: normalizeUrl(find("website")),
    email: find("email").toLowerCase(),
    country: find("country"),
    keyword: find("keyword"),
  };
}

function normalizeUrl(u: string): string {
  const t = u.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t.replace(/\/+$/, "");
  return "https://" + t.replace(/\/+$/, "");
}
