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

// ============ 翻牌堆：按"被杀原因"分组 ============
//
// Joe 要能"扫组名整组略过，只在杀错的地方下钻"。所以分组必须映射到**打分器的一票否决理由**，
// 而不是随便切几段分数。
//
// ⚠️ 必须同时吃两种 reason（生产实测发现的，只匹配前缀会让第一天的翻牌堆全是「其他」）：
//   1) H3-v2 打的分：reason 以 `【不合格·纯内容/攻略/评测/新闻/百科/论坛/博客站】…` 开头（scoreLead 拼的）
//   2) 老 prompt 打的分：**没有前缀**，是自由文本，例如"疑似教程/内容页，非真实买家"、
//      "该公司主要提供光纤互联网服务，未提及星链配件"
//   生产现存的 <60 绝大多数是第 2 种 → 只认前缀等于分类器当场失效。
// 关键词匹配即可，不上 AI（总工的要求，也确实够用）。
export const KILL_REASONS = [
  // ⚠️ stale 排最前：这组是**已经被推翻的规则**杀的，几乎必然有错杀 —— Joe 该先看它
  { key: "stale",     label: "⚠️ 被旧规则按体量杀的", hint: "H3-v1 的「巨头/规模太大」一票压低 —— Joe 已明确推翻这条规则（Speedcast 就是这么被埋的）。这组大概率全是错杀，优先复核" },
  { key: "content",   label: "📰 纯内容/攻略站",   hint: "只教怎么装、不卖硬件 —— 老 H3 病根，这类最会靠满篇 Starlink 骗高分" },
  { key: "isp",       label: "📡 竞品运营商",       hint: "卖自家网络服务，星链是它的对手 —— 但装卫星硬件的集成商是目标客户，这组最容易杀错" },
  { key: "oem",       label: "🏗️ 自有品牌设备厂商", hint: "造自己的产品、通过经销商卖，不采购第三方配件" },
  { key: "china",     label: "🏭 中国同行铺货",     hint: "同质低价铺货，压毛利" },
  { key: "nohw",      label: "🔍 看不出卖/装硬件",  hint: "官网信息含糊 —— ⚠️ 也可能只是爬虫没抓到产品页，杀错重灾区" },
  { key: "notreal",   label: "👻 非真实经营实体",   hint: "没有可核实的经营痕迹" },
  { key: "other",     label: "❓ 其他低分",         hint: "没落进上面任何一类" },
] as const;
export type KillReasonKey = typeof KILL_REASONS[number]["key"];

/**
 * 从 reason（含可能的 buyer_type 前缀）推断"它是被哪条规则杀的"。
 * 顺序敏感：越具体、越容易被别的关键词误吸的放前面。
 */
export function classifyKillReason(reason?: string | null): KillReasonKey {
  const s = (reason || "").toLowerCase();
  if (!s.trim()) return "other";
  const has = (re: RegExp) => re.test(s);

  // ⓪ 被 H3-v1 的「体量」规则杀的 —— **最先判**：Joe 已推翻这条规则，这组大概率全是错杀。
  //    实测生产里真有：Telespazio（卫星系统集成商，被判"航天/企业级卫星巨头"）、
    //  AireSpring / Techone（被判"全国性电信/ISP 巨头"）。它们是 H3-v1 的遗留判决，
  //    新 prompt 已经不会这么判了，但存量分数还挂着 —— 重扫前它们就躺在翻牌堆里。
  if (has(/巨头|规模庞大|全国性电信|全国性.*运营商|大型系统集成|连锁大卖场|体量/)) return "stale";
  // ① 纯内容/攻略站 —— 先判，避免"教你怎么装 Starlink"被下面的"装硬件"关键词吸走
  if (has(/内容站|攻略|评测|资讯|教程|新闻|百科|论坛|博客|blog|guide|tutorial|how.?to|step.?by.?step|review|媒体|个人网站|旅行博客|非真实买家/)) return "content";
  // ② 自有品牌设备厂商（上批加的一票否决类）—— 先于 ISP 判，"制造商"不该被"通信/网络"吸走
  if (has(/自有品牌|设备厂商|制造商|manufacturer|oem\b|生产自有/)) return "oem";
  // ③ 中国铺货 —— 也先于 ISP/硬件判，它有独有特征词
  if (has(/中国同行|铺货|低价卖家|亚马逊同质|@163|@qq|@foxmail|ships from china|阿里|alibaba|1688/)) return "china";
  // ③ 竞品运营商（卖自家网络的 ISP/电信/宽带）
  //    生产实测的老文案：光纤互联网服务 / 固定无线互联网服务 / 电信服务提供商 / 主营业务为…互联网
  if (has(/竞品|运营商|isp\b|电信|宽带|光纤|自家网络|互联网服务|internet service|broadband|fiber|wisp|telecom/)) return "isp";
  // ④ 非真实经营实体
  if (has(/非真实|不是真实|无法核实|空壳|停运|域名停放|parked/)) return "notreal";
  // ⑤ 看不出在卖/装硬件（含"官网信息含糊/只有联系表单"）
  if (has(/看不出|未提及|没有.*证据|信息含糊|信息不足|只有联系表单|未明确|无法判断|不明确|未显示|没有显示/)) return "nohw";
  return "other";
}
