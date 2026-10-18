/**
 * 番茄三个榜的端到端回归 —— 站点改版时第一个跑这个。
 * 用法: node scripts/test-fanqie.cjs   (需先 node node_modules/typescript/bin/tsc -p tsconfig.json)
 *
 * 覆盖: ① 金番作家榜 ② 番茄巅峰榜 ③ 按题材分类榜(含 PUA 字体混淆二次还原) ④ 题材→分类映射边界
 * 判定: 三个榜都必须拿到非 0 条, 且还原后的书名里**不能出现私用区码点** (U+E000–U+F8FF),
 *       出现就说明详情页还原失效、字体混淆没解开, 输出会是豆腐块。
 */
const F = require("../dist/agents/fanqie.js");
const PUA = /[\uE000-\uF8FF]/;
let fail = 0;
const check = (ok, msg) => { if (!ok) fail++; console.log((ok ? "PASS" : "FAIL") + " | " + msg); };

(async () => {
  console.log("===== ① 金番作家榜 =====");
  const a = await F.fetchFanqieAuthorBoard();
  console.log(F.formatFanqieBooks(a.slice(0, 4), "番茄金番作家榜").join("\n"));
  check(a.length > 0, "金番作家榜拿到 " + a.length + " 位");
  check(a.some((x) => x.level === "殿堂作家") && a.some((x) => x.level === "金番作家"), "同时含殿堂作家和金番作家");
  check(!a.some((x) => PUA.test(x.title + x.author)), "作家名/代表作无混淆码点");

  console.log("\n===== ② 番茄巅峰榜 =====");
  const t = await F.fetchFanqieTopBooks(15);
  console.log(F.formatFanqieBooks(t.slice(0, 4), "番茄巅峰榜").join("\n"));
  check(t.length > 0, "巅峰榜拿到 " + t.length + " 部");
  check(t.every((x) => !!x.title), "巅峰榜书名全部非空");
  check(!t.some((x) => PUA.test(x.title + x.author)), "巅峰榜无混淆码点");

  console.log("\n===== ③ 分类榜: 东方仙侠 (字体混淆二次还原) =====");
  const cat = F.pickFanqieCategory("东方仙侠");
  check(!!cat && cat.id === 1140, "题材'东方仙侠' → 东方仙侠(id=1140)");
  if (cat) {
    const b = await F.fetchFanqieCategoryBoard(cat, 1);
    console.log(F.formatFanqieBooks(b.slice(0, 4), "番茄东方仙侠·阅读榜").join("\n"));
    check(b.length > 0, "分类榜还原成功 " + b.length + " 部");
    check(!b.some((x) => PUA.test(x.title)), "★ 分类榜书名无 PUA 混淆码点 (详情页还原生效)");
    check(b.every((x) => !!x.author), "分类榜作者全部非空");
  }

  console.log("\n===== ④ 题材 → 番茄分类 映射边界 =====");
  const cases = [["东方仙侠", "东方仙侠"], ["仙侠 / 第一人称", "东方仙侠"], ["现代都市", "都市日常"], ["东方玄幻", "传统玄幻"], ["言情", "现言脑洞"], ["武侠", null], ["乱写", null]];
  for (const [g, want] of cases) {
    const c = F.pickFanqieCategory(g);
    const got = c ? c.name : null;
    check(got === want, "  " + g.padEnd(16) + " → " + (got || "无对应(回退巅峰榜)") + (got === want ? "" : " 期望 " + (want || "无对应")));
  }

  console.log(fail === 0 ? "\n全部通过" : "\n失败 " + fail + " 条");
  process.exit(fail === 0 ? 0 : 1);
})();
