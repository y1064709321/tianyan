/**
 * 题材关键词过滤 —— 回归用例
 *
 * 用法: node scripts/test-genre-filter.js
 * 需要先编译: npx tsc -p tsconfig.json (脚本直接 require 编译产物 dist/agents/genreFilter.js,
 * 保证测的是**真实代码**, 不是抄一份副本 —— 抄副本等于词表改了这边忘了那边)
 *
 * 每次调 GENRE_KEYWORDS / GENRE_TITLE_KEYWORDS 后必须跑这个脚本, 双向验证:
 *   - 该拦的拦住 (都市赘婿文不许判成仙侠)
 *   - 该放的放过 (真仙侠书不许误杀)
 * 历史上单靠"跑一遍扫榜看顺不顺眼"调了三次都没调对。
 */
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "agents", "genreFilter.js");
if (!fs.existsSync(DIST)) {
  console.error("找不到 " + DIST + "\n请先编译: node node_modules/typescript/bin/tsc -p tsconfig.json");
  process.exit(2);
}
const { matchGenre, normGenre } = require(DIST);

// —— 用例: [书名, 简介, 题材, 期望是否命中] ——
// 全部来自真实扫榜现场抓回来的书, 不是编的。
const CASES = [
  // ① 不该判成仙侠的 (用户当场指出番茄数据不对的那两本都市赘婿文)
  ["极品全才神婿", "一代仙尊重生都市，成为豪门弃婿。他一手医术通天道，一手武力镇乾坤，曾经欺辱过他的人，都将付出代价！", "东方仙侠", false],
  ["最强龙婿", "入赘三年，所有人都以为可以骑在我头上。直到那一天，我的真实身份曝光……", "东方仙侠", false],
  ["都市极品医神", "他身怀绝世医术，重返都市，各路权贵纷至沓来。", "东方仙侠", false],
  // ② 该判成仙侠的 (收紧过度时最容易误杀的几类: 书名无"修仙"连续两字 / 只有单字"仙")
  ["苟在初圣魔门当人材", "魔门底层弟子，靠一手炼丹绝活苟活。灵气稀薄，宗门倾轧，他只想活下去。", "东方仙侠", true],
  ["没钱修什么仙？", "灵气复苏，宗门林立。一个穷小子偏要踏上修真路。", "东方仙侠", true],
  ["大乘期才有逆袭系统", "渡劫失败，元婴破碎，重生回到三百年前。", "仙侠", true],
  ["我师兄实在太稳健了", "修仙界险恶，师兄凡事谋定后动，金丹期便已名震仙门。", "修仙", true],
  // ③ 题材归一化: 带前缀 / 别名必须能查表
  ["一念永恒", "修真世界，宗门林立，少年踏上飞升之路。", "古典仙侠", true],
  ["斗破苍穹", "斗气大陆，实力为尊。", "东方玄幻", true],
  // ④ 无法识别的题材: 不做过滤, 全放过 (宁可全量也不瞎砍)
  ["随便一本书", "随便一段简介。", "赛博朋克蒸汽波", true],
];

let fail = 0;
console.log("—— 题材过滤回归用例 ——");
for (const [title, blurb, genre, want] of CASES) {
  const got = matchGenre(title, blurb, genre);
  const ok = got === want;
  if (!ok) fail++;
  console.log(
    (ok ? "PASS" : "FAIL") + " | 《" + title + "》 题材=" + genre +
    " →命中=" + got + (ok ? "" : " (期望 " + want + ")")
  );
}

// 归一化单独验: 这些写法都必须归到标准题材, 否则 genreKws 为空 → 过滤全程失效
const NORM_CASES = [
  ["东方仙侠", "仙侠"], ["古典仙侠", "仙侠"], ["现代修仙", "仙侠"], ["仙侠 / 第一人称", "仙侠"],
  ["东方玄幻", "玄幻"], ["现代都市", "都市"], ["古代言情", "言情"], ["乱写的题材", ""],
];
console.log("—— 题材归一化 ——");
for (const [g, want] of NORM_CASES) {
  // 项目里 genre 常写 "东方仙侠 / 第一人称", 传参前要取主体材, 这里一并覆盖
  const got = normGenre(String(g).split(/[\/、,，]/)[0].trim());
  const ok = got === want;
  if (!ok) fail++;
  console.log((ok ? "PASS" : "FAIL") + " | " + g + " → " + (got || "(空)") + (ok ? "" : " (期望 " + (want || "(空)") + ")"));
}

console.log(fail === 0 ? "\n全部通过 (" + (CASES.length + NORM_CASES.length) + " 条)" : "\n失败 " + fail + " 条");
process.exit(fail === 0 ? 0 : 1);
