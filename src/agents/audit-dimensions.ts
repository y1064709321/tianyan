// ===== 36 维质检清单 — 单一数据源 =====
// 之前质检维度散落在 runner.ts 的两份临时表 (AUDIT_DIMS 7 条 + RULE_DIMS 6 条) 和一段提示词文本里,
// 36 维里只有 12 维 (含重叠) 有确定性规则, 其余 24 维完全靠 LLM 自觉输出, 没输出就等于没审。
// 这里把 36 维收敛成一张表: 每维都有 id/名称/分组/严重度/确定性规则, 规则覆盖不到的显式标 llmOnly。
//
// 设计原则:
//  1. 强规则 (confidence="strong") 命中 → 按严重度生效, S1 直接一票否决;
//  2. 弱规则 (confidence="weak") 命中 → 最多升到 CONCERNS, 绝不打回 (启发式误报不能卡死创作);
//  3. 规则命中但 LLM 也审过该维 → 两者都进报告, 由终审裁决, 规则层不覆盖 LLM 的创意判断;
//  4. LLM 没审且没有规则 → 记 unaudited, 在覆盖率里如实暴露, 不再假装审过。

import * as store from "../store.js";
import { detectAIHeuristic, similarityCheck } from "../deterministic.js";
import { estimateDensity } from "../arc.js";

export type Severity = "S1" | "S2" | "S3" | "S4";
export type Confidence = "strong" | "weak";
export type DimSource = "llm" | "rule" | "unaudited";

/** 质检上下文 — 规则判定需要的全部输入 (不只正文) */
export interface AuditContext {
  pid: string;
  text: string;
  outline?: string;
  genre?: string;
  chapterId?: string;
  /** 已建档角色名 */
  characters: string[];
  /** 角色档案 (含语言风格, 用于口头禅一致性) */
  profiles: Array<{ name: string; speechStyle?: string; personality?: string }>;
  /** 已死亡/退场角色名 */
  deadCharacters: string[];
  /** 设定元素名 (法宝/地点/设定) */
  elementNames: string[];
  /** 伏笔条目 */
  foreshadowings: Array<{ keyword: string; status?: string }>;
  /** 弧线目标爽点密度 */
  targetDensity: number;
}

export interface RuleHit {
  confidence: Confidence;
  detail: string;
  extra?: Record<string, unknown>;
}

export interface DimensionDef {
  id: number;
  name: string;
  group: string;
  sev: Severity;
  /** 确定性规则。null = 未命中; 返回 RuleHit = 命中。缺省则该维只能靠 LLM */
  rule?: (ctx: AuditContext) => RuleHit | null;
  /** 无确定性规则, 只能 LLM 判 (报告里如实标出, 不伪造覆盖) */
  llmOnly?: boolean;
  /** 给 LLM 的判定要点 */
  hint?: string;
}

// ---------- 文本工具 ----------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const countOf = (t: string, re: RegExp): number => (t.match(re) || []).length;
const sentences = (t: string): string[] =>
  t.split(/[。！？!?…\n]+/).map((s) => s.trim()).filter(Boolean);
const dialogueLines = (t: string): string[] => t.match(/["“「『].*?["”」』]/g) || [];
const speaks = (t: string, name: string): boolean =>
  new RegExp(`${esc(name)}[^。！？]{0,8}(说|道|问|答|喊|喝|笑|骂)`).test(t);
const per1k = (n: number, t: string): number => n / Math.max(1, t.length / 1000);

/** bigram 覆盖率: 大纲的 bigram 有多少出现在正文里 (0-1)。用于"偏离大纲" */
function outlineCoverage(text: string, outline: string): number {
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    const clean = s.replace(/[\s\p{P}]/gu, "");
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  };
  const o = grams(outline);
  if (o.size === 0) return 1;
  const t = grams(text);
  let hit = 0;
  for (const g of o) if (t.has(g)) hit++;
  return hit / o.size;
}

// ---------- 36 维定义 ----------
export const AUDIT_DIMENSIONS: DimensionDef[] = [
  // ===== 角色一致性 (1-7) =====
  {
    id: 1, name: "主角性格矛盾", group: "角色一致性", sev: "S1",
    hint: "主角前后行为/价值观是否自洽",
    rule: (c) => (/性格大变|性情大变|判若两人|像换了个人|一改.{0,6}(常态|本性|作风)|忽然变得?(很)?(陌生|冷漠|暴躁|软弱)/.test(c.text)
      ? { confidence: "strong", detail: "出现性格突变描述, 需核对是否有铺垫" } : null),
  },
  {
    id: 2, name: "配角工具化", group: "角色一致性", sev: "S3",
    hint: "配角是否只有功能、没有自己的动机",
    rule: (c) => {
      if (c.characters.length < 3) return null;
      const withVoice = c.characters.filter((n) => speaks(c.text, n));
      if (withVoice.length <= 1) {
        return { confidence: "weak", detail: `本章出场角色 ${c.characters.length} 个, 有台词的仅 ${withVoice.length} 个` };
      }
      return null;
    },
  },
  {
    id: 3, name: "关系进展自然度", group: "角色一致性", sev: "S2",
    hint: "关系升温/结盟是否有足够铺垫",
    rule: (c) => {
      const first = /初次见面|第一次见|刚认识|素不相识|初见|萍水相逢/.test(c.text);
      const leap = /生死相依|托付终身|结为道侣|私定终身|至死不渝|愿意为你去死|生死与共/.test(c.text);
      return first && leap ? { confidence: "strong", detail: "同章内从初识直接跃迁到生死相托" } : null;
    },
  },
  {
    id: 4, name: "角色智商在线", group: "角色一致性", sev: "S2",
    hint: "角色是否做出明显低于其设定的判断",
    rule: (c) => (/竟然没(有)?(发现|察觉|注意到|认出|看出)|毫无察觉|完全没有察觉|视而不见|竟未察觉/.test(c.text)
      ? { confidence: "weak", detail: "出现'竟然没察觉'类描写, 需核对是否合理" } : null),
  },
  {
    id: 5, name: "口头禅统一", group: "角色一致性", sev: "S3",
    hint: "角色语言风格/口头禅是否前后一致",
    rule: (c) => {
      const misses: string[] = [];
      for (const p of c.profiles) {
        const style = (p.speechStyle || "").trim();
        if (style.length < 2 || style.length > 20) continue;
        if (!c.text.includes(p.name)) continue;      // 该角色未出场
        if (!speaks(c.text, p.name)) continue;       // 出场但没说话
        if (!c.text.includes(style)) misses.push(`${p.name}:「${style}」`);
      }
      return misses.length
        ? { confidence: "weak", detail: `角色有台词但语言风格未体现: ${misses.slice(0, 3).join("; ")}` }
        : null;
    },
  },
  {
    id: 6, name: "外貌一致性", group: "角色一致性", sev: "S2",
    hint: "同一角色的外貌描写是否前后矛盾",
    rule: (c) => {
      const pairs: Array<[RegExp, RegExp, string]> = [
        [/白发|银发|皓首/, /乌黑(的)?(长)?发|黑发|青丝/, "发色矛盾"],
        [/高大|魁梧|伟岸/, /矮小|瘦小|娇小/, "体型矛盾"],
        [/清瘦|骨瘦|羸弱/, /肥胖|臃肿|丰满/, "体态矛盾"],
      ];
      for (const [a, b, label] of pairs) {
        if (a.test(c.text) && b.test(c.text)) {
          return { confidence: "weak", detail: `外貌描写疑似冲突: ${label} (需核对是否指同一角色)` };
        }
      }
      return null;
    },
  },
  {
    id: 7, name: "角色时间线", group: "角色一致性", sev: "S1",
    hint: "已死亡/已退场角色是否又被写活",
    rule: (c) => {
      const ghost = c.deadCharacters.filter((n) => n && c.text.includes(n) && speaks(c.text, n));
      return ghost.length
        ? { confidence: "strong", detail: `已死亡/退场角色在本章仍有台词动作: ${ghost.slice(0, 3).join("、")}` }
        : null;
    },
  },

  // ===== 物资与战力 (8-13) =====
  {
    id: 8, name: "法宝遗忘", group: "物资与战力", sev: "S2",
    hint: "已获得的关键道具在后续章节是否被遗忘",
    rule: (c) => {
      if (c.text.length < 1500 || c.elementNames.length === 0) return null;
      if (!/战斗|交手|对决|出手|一剑|一刀|轰|攻击|追杀|逃/.test(c.text)) return null;
      const missing = c.elementNames.filter((n) => n.length >= 2 && !c.text.includes(n));
      return missing.length >= 2
        ? { confidence: "weak", detail: `本章有战斗, 但 ${missing.length} 个已建档设定/道具未提及 (${missing.slice(0, 3).join("、")})` }
        : null;
    },
  },
  {
    id: 9, name: "战力崩坏", group: "物资与战力", sev: "S1",
    hint: "战力标尺是否前后矛盾",
    rule: (c) => {
      const easy = /一招(击败|秒杀|制服|制伏)|轻松击败|碾压|秒杀|不堪一击|毫无还手之力|如砍瓜切菜/.test(c.text);
      const hard = /苦战|势均力敌|不相上下|拼尽全力|竭尽全力|艰难取胜|险胜|打得艰难/.test(c.text);
      if (easy && hard) return { confidence: "strong", detail: "同章内既有'碾压'又有'苦战', 战力标尺自相矛盾" };
      const overLevel = /越级|跨越.{0,4}(境界|等级|大阶)|以弱胜强|反杀(强|高)/.test(c.text);
      const cost = /代价|底牌|秘法|禁术|燃烧|透支|重伤|险些|拼死/.test(c.text);
      if (overLevel && !cost) return { confidence: "weak", detail: "越级取胜但未交代代价/底牌" };
      return null;
    },
  },
  {
    id: 10, name: "物资矛盾", group: "物资与战力", sev: "S2",
    hint: "已声明耗尽的物资是否又被使用",
    rule: (c) => {
      // 「只剩下三枚灵石，…」→ 数字+量词后捕获物品名 (惰性匹配到标点为止)
      const m = c.text.match(
        /(?:只剩|仅剩|只剩下|只剩得|再无|已无)\s*[一二三四五六七八九十两百千万\d]*\s*[枚颗块两文个张把件片粒]*\s*([\u4e00-\u9fa5]{1,4}?)\s*[，。、！？；\s]/,
      );
      if (!m || !m[1]) return null;
      const item = m[1];
      const after = c.text.slice(m.index || 0);
      const reuse = new RegExp(`(?:又|再|再次|重新)?(?:拿出|取出|掏出|使用|服用|动用)\\s*[一二三四五六七八九十百千万\d]*\\s*${esc(item)}`);
      return reuse.test(after)
        ? { confidence: "weak", detail: `「${item}」已声明耗尽, 后文又取出使用` }
        : null;
    },
  },
  {
    id: 11, name: "资源合理", group: "物资与战力", sev: "S3",
    hint: "实力/物资获取是否有消耗支撑",
    rule: (c) => {
      if (c.text.length < 800) return null;
      const gain = /炼制成功|成功炼制|突破到|进阶到|获得|得到|提升到|收获/.test(c.text);
      const cost = /耗费|消耗|代价|材料|灵石|丹药|资源|付出|辛苦|代价/.test(c.text);
      return gain && !cost
        ? { confidence: "weak", detail: "本章有实力/物资获取, 但未交代消耗或代价" }
        : null;
    },
  },
  {
    id: 12, name: "突破代价", group: "物资与战力", sev: "S2",
    hint: "突破/进阶是否付出相应代价",
    rule: (c) => {
      const brk = /突破|进阶|晋升|渡劫|冲破/.test(c.text);
      const cost = /付出|代价|牺牲|损耗|消耗|灵气|灵力|剧痛|重伤|风险|险些/.test(c.text);
      return brk && !cost ? { confidence: "strong", detail: "有突破描写但未写代价" } : null;
    },
  },
  {
    id: 13, name: "货币混乱", group: "物资与战力", sev: "S2",
    hint: "金额量级与货币单位是否自洽",
    rule: (c) => {
      const money = /灵石|晶石|金币|银币|铜币|贡献点|积分|灵玉/.test(c.text);
      if (!money) return null;
      const huge = /([\d]+)?\s*(万|亿|百万|千万)\s*(枚|块|颗|两|点)?\s*(灵石|晶石|金币|银币|铜币|贡献点)/.test(c.text);
      const tiny = /[一二三四五六七八九十]\s*(枚|块|颗|两|文|点)\s*(灵石|晶石|金币|银币|铜币|贡献点)/.test(c.text);
      return huge && tiny
        ? { confidence: "weak", detail: "同章出现万级与个级金额, 建议核对价值体系" }
        : null;
    },
  },

  // ===== 伏笔与逻辑 (14-20) =====
  {
    id: 14, name: "伏笔遗忘", group: "伏笔与逻辑", sev: "S1",
    hint: "未回收伏笔是否被长期搁置",
    rule: (c) => {
      const open = c.foreshadowings.filter((f) => {
        const s = String(f.status || "");
        return !/recovered|回收|已收|abandoned|放弃|作废/.test(s);
      });
      if (open.length < 4) return null;
      const touched = open.filter((f) => f.keyword.length >= 2 && c.text.includes(f.keyword));
      if (touched.length === 0) {
        return { confidence: "weak", detail: `未回收伏笔 ${open.length} 条, 本章未触碰任何一条` };
      }
      return null;
    },
  },
  {
    id: 15, name: "回收生硬", group: "伏笔与逻辑", sev: "S2",
    hint: "伏笔回收是否靠巧合式揭示硬凑",
    rule: (c) => {
      const reveal = countOf(c.text, /原来|竟然是|没想到|谁曾想|竟是|万万没想到/g);
      return reveal >= 3 && per1k(reveal, c.text) >= 2.5
        ? { confidence: "weak", detail: `反转式揭示 ${reveal} 次 (${per1k(reveal, c.text).toFixed(1)}/千字), 回收可能生硬` }
        : null;
    },
  },
  {
    id: 16, name: "逻辑漏洞", group: "伏笔与逻辑", sev: "S1",
    hint: "同一章内是否存在互斥状态",
    rule: (c) => {
      const pairs: Array<[RegExp, RegExp, string, Confidence]> = [
        [/已经?(死|殒)(了|去)|身亡|殒命|断气/, /还活着|尚在人世|活了下来|苏醒过来/, "死亡与存活描述并存", "strong"],
        [/失明|瞎了|看不见|双目已盲/, /看见|望见|瞧见|一眼就看到|目光所及/, "失明与视觉描写矛盾", "strong"],
        [/不识字|目不识丁/, /读(着|完|起)|看信|翻阅|展信/, "识字状态与阅读行为矛盾", "strong"],
        [/从未(离开|出过)|一直待在|足不出/, /刚(从|回)?(到|来)|归来|回到|返程/, "行踪描述互斥", "weak"],
        [/断(了|掉)(一)?(条)?(腿|臂|手)|残废/, /奔跑|健步|双手(紧握|举起)|飞奔/, "残疾与肢体动作矛盾", "weak"],
      ];
      for (const [a, b, label, conf] of pairs) {
        if (a.test(c.text) && b.test(c.text)) return { confidence: conf, detail: `疑似逻辑冲突: ${label}` };
      }
      return null;
    },
  },
  {
    id: 17, name: "巧合过多", group: "伏笔与逻辑", sev: "S2",
    hint: "情节推进是否过度依赖巧合",
    rule: (c) => {
      const n = countOf(c.text, /恰好|正好|恰巧|碰巧|巧的是|无巧不成书|赶巧|说来也巧/g);
      return n >= 4 && per1k(n, c.text) >= 2
        ? { confidence: "strong", detail: `巧合词 ${n} 次 (${per1k(n, c.text).toFixed(1)}/千字)` }
        : null;
    },
  },
  {
    id: 18, name: "时间线", group: "伏笔与逻辑", sev: "S1",
    hint: "章节内时间推进与回溯是否矛盾",
    rule: (c) => {
      const fwd = [...c.text.matchAll(/(次日|翌日|第二日|三日后|三日后|半月后|一个月后|一年后|三年后|十年后|数日后)/g)];
      if (fwd.length < 1) return null;
      const lastIdx = (fwd[fwd.length - 1]!.index || 0);
      const back = c.text.slice(lastIdx).match(
        /(前一天|前一日|[一二三四五六七八九十两]?[天日年]前|三日前|一年前|当年|当初|此前)/,
      );
      return back
        ? { confidence: "weak", detail: `时间已推进至「${fwd[fwd.length - 1]![1]}」后又出现回溯叙述「${back[1]}」, 建议核对时序` }
        : null;
    },
  },
  {
    id: 19, name: "信息获取", group: "伏笔与逻辑", sev: "S2",
    hint: "角色获知关键信息是否有渠道",
    rule: (c) => {
      const secret = /秘密|真相|内幕|真实身份|底牌|来历|隐情/.test(c.text);
      const knows = /(他|她|他们)(竟然|竟|怎么)?(会)?(知道|得知|知晓)|已然知晓|早已知晓/.test(c.text);
      const channel = /听(到|说|闻)|看见|目睹|偷听|偷看|察觉|发现|告知|透露|信件|传音|探查|查探|打探/.test(c.text);
      return secret && knows && !channel
        ? { confidence: "weak", detail: "角色获知关键信息, 但本章未交代信息渠道" }
        : null;
    },
  },
  {
    id: 20, name: "反派逻辑", group: "伏笔与逻辑", sev: "S2",
    hint: "反派行为是否有自洽动机",
    rule: (c) => {
      const harm = /追杀|暗算|陷害|下毒|偷袭|灭口|设局|围攻/.test(c.text);
      if (!harm) return null;
      const motive = /因为|为了|仇恨|报仇|利益|奉命|受命|争夺|嫉妒|报复|奉旨|交易|筹码/.test(c.text);
      return !motive ? { confidence: "weak", detail: "本章有加害行为, 但未见动机交代" } : null;
    },
  },

  // ===== 文风与表达 (21-27) =====
  {
    id: 21, name: "AI味", group: "文风与表达", sev: "S2",
    hint: "套话/高频AI腔是否超标",
    rule: (c) => {
      const ai = detectAIHeuristic(c.text);
      if (ai.score >= 7) return { confidence: "strong", detail: `AI味过重 ${ai.score}/10 (${ai.level}), 建议删减 ≤${Math.round(ai.deletionCap * 100)}%` };
      if (ai.score >= 4) return { confidence: "strong", detail: `AI味中等 ${ai.score}/10, 痕迹 ${ai.traces} 处` };
      return null;
    },
  },
  {
    id: 22, name: "描写冗长", group: "文风与表达", sev: "S3",
    hint: "长句占比是否过高",
    rule: (c) => {
      const ss = sentences(c.text);
      const long = ss.filter((s) => s.length > 50);
      const ratio = ss.length ? long.length / ss.length : 0;
      return long.length >= 3 && ratio > 0.15
        ? { confidence: "strong", detail: `超长句 ${long.length}/${ss.length} 句 (${(ratio * 100).toFixed(0)}%)` }
        : null;
    },
  },
  {
    id: 23, name: "战斗枯燥", group: "文风与表达", sev: "S2",
    hint: "战斗招式是否重复单调",
    rule: (c) => {
      if (c.text.length < 1200) return null;
      if (!/一剑|一刀|一拳|攻击|轰向|击中|格挡|躲开|交手|对决|出手/.test(c.text)) return null;
      const verbs = new Set((c.text.match(/劈|砍|刺|斩|挡|闪|躲|踢|轰|扫|砸|捏|擒/g) || []));
      return verbs.size <= 4
        ? { confidence: "weak", detail: `战斗动作词仅 ${verbs.size} 种, 招式重复` }
        : null;
    },
  },
  {
    id: 24, name: "情绪到位", group: "文风与表达", sev: "S2",
    hint: "情绪密度是否足以支撑情节",
    rule: (c) => {
      if (c.text.length < 1500) return null;
      const emo = countOf(c.text, /愤怒|震怒|悲|痛苦|喜悦|欣喜|恐惧|惊惧|震惊|绝望|激动|紧张|不安|失落|欣慰|酸涩|心颤/g);
      const d = per1k(emo, c.text);
      return d < 2 ? { confidence: "weak", detail: `情绪词密度 ${d.toFixed(1)}/千字, 情感偏平淡` } : null;
    },
  },
  {
    id: 25, name: "幽默自然", group: "文风与表达", sev: "S3",
    hint: "笑点是否有具体铺垫而非空笑",
    rule: (c) => {
      const laugh = countOf(c.text, /哈哈|嘿嘿|笑道|打趣|调侃|逗趣|开玩笑|忍俊不禁/g);
      const substance = /滑稽|狼狈|出丑|窘|尴尬|反差|吐槽|讽刺|自嘲|一愣|哭笑不得/.test(c.text);
      return laugh >= 4 && !substance
        ? { confidence: "weak", detail: `笑点标记 ${laugh} 处, 但未见具体笑料铺垫` }
        : null;
    },
  },
  {
    id: 26, name: "对话质量", group: "文风与表达", sev: "S2",
    hint: "对话是否碎片化、信息量低",
    rule: (c) => {
      const dl = dialogueLines(c.text);
      if (dl.length < 10) return null;   // 样本太少不下结论
      const short = dl.filter((d) => d.replace(/["“「」『』”\s]/g, "").length < 8);
      const ratio = short.length / dl.length;
      // 0.6 而非 0.4: 动作向网文本就多短句对话, 阈值太低会把正常文风误判为碎片化
      return ratio > 0.6
        ? { confidence: "strong", detail: `短对话 ${short.length}/${dl.length} (${(ratio * 100).toFixed(0)}%), 对话碎片化` }
        : null;
    },
  },
  {
    id: 27, name: "感官丰富", group: "文风与表达", sev: "S3",
    hint: "是否只靠视觉单一通道描写",
    rule: (c) => {
      if (c.text.length < 1000) return null;
      const groups: Array<[RegExp, string]> = [
        [/看|望|瞄|视|目光|眼前|映入/, "视觉"],
        [/听|闻声|声响|声音|轰鸣|寂静|嘈杂/, "听觉"],
        [/嗅|气味|香|臭|腥|刺鼻/, "嗅觉"],
        [/尝|味道|甜|苦|酸|辣|涩/, "味觉"],
        [/触|摸|冰冷|滚烫|粗糙|柔软|刺痛|黏腻|湿润/, "触觉"],
      ];
      const present = groups.filter(([re]) => re.test(c.text)).map(([, n]) => n);
      return present.length < 2
        ? { confidence: "weak", detail: `感官通道仅 ${present.join("/") || "无"}, 描写单薄` }
        : null;
    },
  },

  // ===== 结构与节奏 (28-32) =====
  {
    id: 28, name: "章节钩子", group: "结构与节奏", sev: "S2",
    hint: "章末是否留足悬念",
    rule: (c) => {
      if (c.text.length < 800) return null;
      const tail = c.text.slice(-200);
      const hook = /[？?！!]|突然|忽然|却|竟|不知|难道|危险|危机|然而|没想到|就在这时|只见|未完/.test(tail);
      return !hook ? { confidence: "weak", detail: "章末 200 字未见悬念/转折信号" } : null;
    },
  },
  {
    id: 29, name: "爽点密度", group: "结构与节奏", sev: "S2",
    hint: "单位字数内的爽点是否达标",
    rule: (c) => {
      if (c.text.length < 1000) return null;
      const d = estimateDensity(c.text);
      const target = c.targetDensity || 1.5;
      return d < target * 0.5
        ? { confidence: "strong", detail: `爽点密度 ${d.toFixed(2)}/千字 < 目标 ${target}` }
        : null;
    },
  },
  {
    id: 30, name: "开篇抓人", group: "结构与节奏", sev: "S2",
    hint: "前 200 字是否抓住读者",
    rule: (c) => {
      const head = c.text.trim().slice(0, 200);
      const flat = /^(这一天|话说|自古以来|传说|在一个|很久很久|起初|众所周知)/.test(c.text.trim())
        || /早上|清晨|起床|醒来|阳光透过|天刚亮|这一天|一如既往/.test(head);
      return head.length < 50 || flat
        ? { confidence: "strong", detail: `开篇平淡: 「${c.text.trim().slice(0, 18)}…」` }
        : null;
    },
  },
  {
    id: 31, name: "高潮燃度", group: "结构与节奏", sev: "S3",
    hint: "结尾强度是否高开低走",
    rule: (c) => {
      if (c.text.length < 1500) return null;
      const third = Math.floor(c.text.length / 3);
      const intensity = (s: string): number =>
        countOf(s, /[！!]|猛|骤|爆|轰|狂|瞬间|陡然|猛然|轰然/g) / Math.max(1, s.length / 1000);
      const headI = intensity(c.text.slice(0, third));
      const tailI = intensity(c.text.slice(-third));
      return tailI < headI * 0.6
        ? { confidence: "weak", detail: `结尾强度 ${tailI.toFixed(1)}/千字 < 开篇 ${headI.toFixed(1)}/千字, 高开低走` }
        : null;
    },
  },
  {
    id: 32, name: "支线挤压", group: "结构与节奏", sev: "S2",
    hint: "主线是否被支线抢占篇幅",
    rule: (c) => {
      if (c.text.length < 2000 || c.characters.length === 0) return null;
      const counts = c.characters
        .filter((n) => n.length >= 2)
        .map((n) => ({ n, c: countOf(c.text, new RegExp(esc(n), "g")) }))
        .sort((a, b) => b.c - a.c);
      const total = counts.reduce((s, x) => s + x.c, 0);
      if (!total || !counts[0]) return null;
      const share = counts[0]!.c / total;
      return share < 0.3
        ? { confidence: "weak", detail: `主角「${counts[0]!.n}」篇幅占比仅 ${(share * 100).toFixed(0)}%, 疑似被支线挤压` }
        : null;
    },
  },

  // ===== 大纲与偏离 (33-35) =====
  {
    id: 33, name: "偏离大纲", group: "大纲与偏离", sev: "S1",
    hint: "正文是否按本章大纲推进",
    rule: (c) => {
      const o = (c.outline || "").trim();
      if (o.length < 100) return null;
      const cov = outlineCoverage(c.text, o);
      return cov < 0.3
        ? { confidence: "strong", detail: `正文对大纲的覆盖率仅 ${(cov * 100).toFixed(0)}%, 疑似偏离` }
        : null;
    },
  },
  {
    id: 34, name: "对话密集", group: "大纲与偏离", sev: "S3",
    hint: "对话占比是否挤压叙事",
    rule: (c) => {
      if (c.text.length < 1000) return null;
      const dl = dialogueLines(c.text);
      const chars = dl.reduce((s, d) => s + d.length, 0);
      const ratio = chars / Math.max(1, c.text.length);
      return ratio > 0.6
        ? { confidence: "strong", detail: `对话占比 ${(ratio * 100).toFixed(0)}%, 叙事被挤压` }
        : null;
    },
  },
  {
    id: 35, name: "背景过多", group: "大纲与偏离", sev: "S3",
    hint: "开篇是否大段倾倒设定",
    rule: (c) => {
      const head = c.text.slice(0, 500);
      const bg = countOf(head, /传说|据说|自古以来|历史|背景|世界观|大陆|纪元|千年|万年|渊源|由来/g);
      const action = countOf(head, /说|走|跑|看|冲|拔|笑|喝|挥|转身/g);
      return bg >= 3 && action < 3
        ? { confidence: "weak", detail: `开篇 500 字设定词 ${bg} 处, 动作仅 ${action} 处` }
        : null;
    },
  },

  // ===== 第 36 维: 原创度 =====
  {
    id: 36, name: "原创度", group: "原创度", sev: "S1",
    hint: "是否存在照抄/自我重复 (确定性检测, 不靠 LLM)",
    rule: (c) => {
      const sim = similarityCheck({ pid: c.pid, currentChapterId: c.chapterId, text: c.text });
      if (sim.verdict === "plagiarized") {
        return {
          confidence: "strong",
          detail: `疑似照抄「${sim.worstSource}」 Jaccard=${sim.maxOverlap}`,
          extra: {
            verdict: sim.verdict, maxOverlap: sim.maxOverlap, worstSource: sim.worstSource,
            selfRepetition: sim.selfRepetition, reasons: sim.reasons,
            topSources: sim.sources.slice(0, 5),
          },
        };
      }
      if (sim.verdict === "suspect") {
        return {
          confidence: "weak",
          detail: sim.reasons[0] || "相似度偏高, 建议核对",
          extra: {
            verdict: sim.verdict, maxOverlap: sim.maxOverlap, worstSource: sim.worstSource,
            selfRepetition: sim.selfRepetition, reasons: sim.reasons,
            topSources: sim.sources.slice(0, 5),
          },
        };
      }
      return null;
    },
  },
];

export const TOTAL_DIMENSIONS = AUDIT_DIMENSIONS.length; // 36

/** 规则可确定性覆盖的维度数 (供诊断) */
export const RULE_COVERED_DIMENSIONS = AUDIT_DIMENSIONS.filter((d) => !!d.rule).length;

/** 给 LLM 的 36 维清单文本 — 由单一数据源生成, 杜绝提示词与代码不一致 */
export const AUDIT_DIMENSIONS_TEXT = (() => {
  const byGroup = new Map<string, DimensionDef[]>();
  for (const d of AUDIT_DIMENSIONS) {
    const arr = byGroup.get(d.group) || [];
    arr.push(d);
    byGroup.set(d.group, arr);
  }
  const lines: string[] = [`${TOTAL_DIMENSIONS}维度：`];
  for (const [group, dims] of byGroup) {
    const body = dims.map((d) => `${d.id}.${d.name}(${d.sev})`).join(" ");
    lines.push(`【${group}(${dims[0]!.id}-${dims[dims.length - 1]!.id})】${body}`);
  }
  lines.push("严重度: S1=一票否决(必须修), S2=中等, S3=轻微, S4=建议。");
  return lines.join("\n");
})();

// ---------- 上下文组装 ----------
export function buildAuditContext(opts: {
  pid: string;
  text: string;
  outline?: string;
  genre?: string;
  chapterId?: string;
}): AuditContext {
  const { pid, text, outline, genre, chapterId } = opts;
  let characters: string[] = [];
  let profiles: AuditContext["profiles"] = [];
  let deadCharacters: string[] = [];
  let elementNames: string[] = [];
  let foreshadowings: AuditContext["foreshadowings"] = [];
  let targetDensity = 1.5;
  try {
    profiles = (store.listCharacterProfiles(pid) || []).map((p) => ({
      name: String(p.name || ""),
      speechStyle: p.speechStyle || undefined,
      personality: p.personality || undefined,
    })).filter((p) => p.name.length >= 2);
    characters = profiles.map((p) => p.name);
  } catch { /* 档案不可用 → 角色类维度降级为 llmOnly */ }
  try {
    deadCharacters = (store.listCharacterStates(pid) || [])
      .filter((s) => /死|亡|殒|退场|dead|deceased/i.test(String(s.current_state || "")))
      .map((s) => String(s.character_name || ""))
      .filter(Boolean);
  } catch { /* ignore */ }
  try {
    elementNames = (store.listElements(pid) || [])
      .map((e) => String(e.name || ""))
      .filter((n) => n.length >= 2);
  } catch { /* ignore */ }
  try {
    foreshadowings = (store.listForeshadowings(pid) || []).map((f) => ({
      keyword: String(f.keyword || f.name || f.content || "").slice(0, 12),
      status: String(f.status || ""),
    }));
  } catch { /* ignore */ }
  try {
    targetDensity = store.getArcTarget(pid)?.targetDensity || 1.5;
  } catch { /* ignore */ }
  return { pid, text, outline, genre, chapterId, characters, profiles, deadCharacters, elementNames, foreshadowings, targetDensity };
}

// ---------- 审计执行 ----------
export interface DimensionAudit {
  id: number;
  name: string;
  group: string;
  sev: Severity;
  /** llm = 模型审过; rule = 规则层兜底; unaudited = 两层都没审 (如实暴露) */
  source: DimSource;
  /** 是否发现问题 */
  hit: boolean;
  confidence?: Confidence;
  detail?: string;
  llmIssue?: string;
}

export interface DimensionAuditReport {
  dims: DimensionAudit[];
  /** 规则层补审产生的 findings, 可直接并入 LLM findings */
  findings: Array<Record<string, unknown>>;
  /** 强规则命中 S1 → 一票否决 */
  forceReject: boolean;
  /** 其它命中 → 至少 CONCERNS */
  forceConcerns: boolean;
  /** 两层都没审的维度 id */
  unauditedIds: number[];
  coverage: {
    total: number;
    llmCovered: number;
    ruleCovered: number;
    unaudited: number;
    /** 规则库本身能确定性覆盖的维度数 (用于诊断"规则层到底能审多少维") */
    ruleDefined: number;
  };
  /** 第 36 维原创度明细 (前端沿用) */
  originality?: Record<string, unknown>;
}

/**
 * 跑 36 维确定性规则, 并与 LLM findings 合并。
 * 合并语义:
 *  - LLM 审过的维度: 以 LLM 为准, 规则命中也一并记录 (供终审对照), 但强规则 S1 仍可否决;
 *  - LLM 没审的维度: 规则层兜底, 强规则命中按严重度生效;
 *  - 两层都没审: 记 unaudited, 不伪造结论。
 */
export function auditDimensions(ctx: AuditContext, llmFindings: Array<Record<string, unknown>> = []): DimensionAuditReport {
  const llmById = new Map<number, Record<string, unknown>>();
  for (const f of llmFindings) {
    const id = Number(f?.dimension_id ?? f?.dimensionId ?? 0);
    if (id > 0 && !llmById.has(id)) llmById.set(id, f);
  }

  const dims: DimensionAudit[] = [];
  const findings: Array<Record<string, unknown>> = [];
  const unauditedIds: number[] = [];
  let forceReject = false;
  let forceConcerns = false;
  let llmCovered = 0;
  let ruleCovered = 0;
  let originality: Record<string, unknown> | undefined;

  for (const def of AUDIT_DIMENSIONS) {
    const llm = llmById.get(def.id);
    let hit: RuleHit | null = null;
    try {
      hit = def.rule ? def.rule(ctx) : null;
    } catch (e) {
      hit = null; // 规则自身异常不能拖垮质检
    }
    if (def.id === 36) {
      // 无论命中与否都回传原创度结论, 让上层/前端知道这一维确实查过了
      originality = hit?.extra || { verdict: "clean", maxOverlap: 0, worstSource: "", selfRepetition: 0, reasons: [] as string[], topSources: [] };
    }

    const hasLlm = !!llm;
    const hasRule = !!hit;
    const source: DimSource = hasLlm ? "llm" : (def.rule ? "rule" : "unaudited");

    if (source === "llm") llmCovered++;
    else if (source === "rule") ruleCovered++;
    else unauditedIds.push(def.id);

    // 规则层补审: 只有 LLM 没覆盖该维时才生成 finding (避免和 LLM 结论重复打架)
    if (hit && !hasLlm) {
      findings.push({
        severity: def.sev,
        dimension_id: def.id,
        dimension: def.name,
        location: "规则层补审",
        evidence: "",
        issue: hit.detail,
        fix: hit.confidence === "weak" ? "启发式命中, 请人工确认" : "按该维度标准修改",
        _source: "rule_fill",
        _confidence: hit.confidence,
      });
      if (hit.confidence === "strong" && def.sev === "S1") forceReject = true;
      else forceConcerns = true;
    } else if (hit && hasLlm) {
      // LLM 审过但强规则也命中 S1 → 仍可否决 (防弱模型放水)
      if (hit.confidence === "strong" && def.sev === "S1") forceReject = true;
    }

    dims.push({
      id: def.id,
      name: def.name,
      group: def.group,
      sev: def.sev,
      source,
      hit: !!hit || (hasLlm && String(llm.severity || "").toUpperCase().startsWith("S")),
      confidence: hit?.confidence,
      detail: hit?.detail || (hasLlm ? String(llm.issue || "") : undefined),
      llmIssue: hasLlm ? String(llm.issue || "") : undefined,
    });
  }

  return {
    dims,
    findings,
    forceReject,
    forceConcerns,
    unauditedIds,
    coverage: {
      total: TOTAL_DIMENSIONS,
      llmCovered,
      ruleCovered,
      unaudited: unauditedIds.length,
      ruleDefined: RULE_COVERED_DIMENSIONS, // 规则库本身能确定性覆盖的维度数
    },
    originality,
  };
}
