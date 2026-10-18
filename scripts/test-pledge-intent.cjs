// 承诺委派意图识别回归 (2026-10-18)
// 背景: 总编写"我这就派角色师执行 Step 3…归拢进设定集", isDelegationPledge 命中
// 但 intentMatch 词表没有 角色/设定/建档 → 接管块整段跳过 → 设定集永远空。
// 本脚本复刻 runner.ts 里的两段判定正则 (改动 runner 那两处时必须同步这里):
//   ① isDelegationPledge: !delegated && len<=300 && 意向动词+角色/成果关键词
//   ② isDelegationIntent:  (intentMatch || isDelegationPledge) && !delegated && !scan && 有阶段
const assert = require("node:assert");

const PLEDGE_RE = /(?:我将|我要|我马上|接下来|现在就|准备|打算|即将|稍后|随后|然后)?\s*(?:委派|交给|指派|安排|派给|让|执行|启动|调用|开展|开始|动笔)\s*[^。！？\n]{0,16}?(?:agent|专家|主笔|架构师|策划|资料员|审校|质检|角色|编剧|写作|撰文|正文|设定|Step|步骤|阶段|writer|architect|explorer|checker|designer|presenter)/i;
const INTENT_RE = /委派|@|\barchitect\b|\bwriter\b|\bdesigner\b|架构师|主笔|总编|拆书|正文|审稿|质检|角色|人设|人物|设定|建档|世界观|档案/i;
const SCAN_RE = /扫榜|扫.*榜|榜单|畅销榜|扫榜调研/i;

function decide(body, delegated = false) {
  const t = (body || "").trim();
  const isPledge = !delegated && t.length > 0 && t.length <= 300 && PLEDGE_RE.test(t);
  const isScan = !delegated && SCAN_RE.test(t);
  // 真实代码里接管块只在 isDegradedRound 时进入; LLM 健康且正文非空时 degraded ≡ isPledge
  const degraded = isPledge;
  const isDelegationIntent = !!((INTENT_RE.test(t) || isPledge) && !delegated && !isScan);
  return { takeover: degraded && isDelegationIntent, isPledge };
}

// ===== 应接管 (6 条) =====
const TAKEOVER = [
  "我这就派角色师（character-designer）执行 Step 3：把我们讨论定下来的核心设定（轮回百世、境界分层、金手指）全部归拢进设定集——包括主角档案、世界观管理。",
  "我将委派主笔 agent 撰写第一章正文。",
  "接下来让架构师搭建全书大纲。",
  "现在就执行 Step 4 大纲搭建。",
  "随后交给审校质检本章正文。",
  "打算派写手动笔写第二章正文。",
];
for (const t of TAKEOVER) {
  const d = decide(t);
  assert.ok(d.takeover, `应接管但未接管: ${t.slice(0, 30)}…`);
}

// ===== 应放过 (5 条) =====
const PASS = [
  // ① 长正文(>300字) 即使含角色词也是交付汇报
  "已完成角色档案建档。" + "设定细节".repeat(100),
  // ② 完成态汇报, 无意向动词
  "已完成角色档案建档，共落库 5 条设定，以下是明细。",
  // ③ 回顾上文, 无动词+关键词组合
  "上一轮角色师已建好档案，以下是成果汇报，请查收。",
  // ④ 扫榜意图走 scan 专用通道, 不进委派接管
  "接下来开始扫榜，抓取畅销榜数据。",
  // ⑤ 已委派过的收尾轮不再接管
  ["我将委派角色师继续补充设定。", true],
];
for (const item of PASS) {
  const [t, delegated] = Array.isArray(item) ? item : [item, false];
  const d = decide(t, delegated);
  assert.ok(!d.takeover, `应放过但接管了: ${String(t).slice(0, 30)}…`);
}

console.log(`OK: 承诺委派意图回归 ${TAKEOVER.length + PASS.length}/11 全绿 (6 应接管 / 5 应放过)`);
