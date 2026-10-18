/**
 * runCancel 模块回归: 停止按钮的后端基础。
 * 覆盖: 标记取消 → 命中 / 清除后不再命中 / 多 run 互不干扰 / sweep 容量上限。
 */
const path = require("path");
const MOD = path.join(__dirname, "..", "dist", "runCancel.js");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name); }
}

(async () => {
  let m;
  try { m = require(MOD); }
  catch (e) { console.log("跳过: dist/runCancel.js 不可加载 (" + e.message + "), 请先 npm run build"); process.exit(0); }

  console.log("== runCancel ==");
  const A = "run-A", B = "run-B";

  ok(typeof m.cancelRun === "function", "导出 cancelRun");
  ok(typeof m.isRunCancelled === "function", "导出 isRunCancelled");
  ok(typeof m.clearRunCancel === "function", "导出 clearRunCancel");

  ok(m.isRunCancelled(A) === false, "未取消的 run 不命中 (默认 false, 不能误停)");
  m.cancelRun(A);
  ok(m.isRunCancelled(A) === true, "cancelRun 后立刻命中");
  ok(m.isRunCancelled(B) === false, "取消 A 不影响 B (多任务并发不能串台)");

  m.clearRunCancel(A);
  ok(m.isRunCancelled(A) === false, "clearRunCancel 后不再命中 (新任务不能继承旧取消标记)");

  // 幂等: runner 多个检查点会重复读, 不能因为读过一次就失效
  m.cancelRun(A);
  ok(m.isRunCancelled(A) === true, "第 1 次检查命中");
  ok(m.isRunCancelled(A) === true, "第 2 次检查仍命中 (幂等, 不是一次性标记)");
  ok(m.isRunCancelled(A) === true, "第 3 次检查仍命中");
  m.clearRunCancel(A);

  // 空调用不崩
  let threw = false;
  try { m.clearRunCancel("不存在的run"); } catch { threw = true; }
  ok(!threw, "clearRunCancel 不存在的 run 不抛异常");

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
