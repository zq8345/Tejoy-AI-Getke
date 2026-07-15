// 规范客户分类：把 AI 自由生成的 customer_type（很碎、中英文混杂）归一到固定几类，
// 用于列表徽章 + 多维筛选。AI 的细分描述仍保留在 customer_type，用于详情展示。

export const CUSTOMER_CATEGORIES = [
  "安装/集成",   // installer / integrator / 智能家居 / 影音 / 系统集成
  "经销/零售",   // reseller / retailer / 批发 / 电商 / 配件商
  "船舶/海事",   // marine
  "房车/RV",     // RV dealer / upfitter / 露营 / overland
  "离网/偏远",   // off-grid / remote / rural ISP / WISP / 户外
  "企业/IT",     // 企业 IT 部署 / BPO / 数据中心 / 矿业石油 / 模块化建筑 / 项目部署
  "其他",        // 论坛社区 / 媒体 / 无法判定
] as const;

export type CustomerCategory = typeof CUSTOMER_CATEGORIES[number];

// 把任意自由文本类型归一。顺序敏感：越容易误判/越具体的先判。
export function categorizeCustomerType(raw?: string | null): CustomerCategory {
  const s = (raw || "").toLowerCase();
  if (!s) return "其他";
  const has = (re: RegExp) => re.test(s);

  // 1) 论坛/社区/媒体/目录 —— 非直接买家（先拦，避免“房车论坛”被归到房车）
  if (has(/论坛|社区|媒体|资讯|博客|forum|community|blog|magazine|directory|目录/)) return "其他";
  // 2) 船舶/海事
  if (has(/船|海事|游艇|码头|marine|boat|yacht|vessel|maritime|nautical/)) return "船舶/海事";
  // 3) 房车/RV/露营
  if (has(/房车|露营|拖挂|rv\b|motorhome|caravan|camper|overland|van life|vanlife/)) return "房车/RV";
  // 4) 离网/偏远/远程网络
  if (has(/离网|偏远|户外|野外|乡村|off.?grid|remote|rural|wisp|starlink.*rural|远程网络/)) return "离网/偏远";
  // 5) 企业/IT/项目部署（含矿业石油、模块化建筑等重项目场景）
  if (has(/企业|it\s*部署|it部署|数据中心|bpo|模块化建筑|建筑|矿业|石油|油气|应急|项目部署|corporate|enterprise|modular|construction|mining|oil|gas|deployment|managed service/)) return "企业/IT";
  // 6) 经销/零售/批发/电商
  if (has(/经销|零售|批发|商城|电商|门店|配件商|reseller|retail|dealer|wholesal|distribut|storefront|e-?commerce|marketplace/)) return "经销/零售";
  // 7) 安装/集成（含智能家居/影音/网络布线/系统集成）
  if (has(/安装|集成|智能家居|影音|布线|installer|install|integrat|smart.?home|home theater|a\/?v\b|low.?voltage|networking|cabling/)) return "安装/集成";
  return "其他";
}
