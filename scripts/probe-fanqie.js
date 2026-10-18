// 探测番茄榜单页真实接口 —— 打开页面监听 XHR, 找出真正的榜单 API (金番茄榜等)
import { chromium } from "playwright";

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" });
const page = await ctx.newPage();
const hits = [];
page.on("response", async (r) => {
  const u = r.url();
  if (!/fanqienovel\.com/.test(u)) return;
  if (!/\/(api|ajax)/.test(u)) return;
  let body = "";
  try { const t = await r.text(); body = t.slice(0, 200); } catch { /* ignore */ }
  hits.push({ u: u.slice(0, 160), status: r.status(), head: body.replace(/\s+/g, " ").slice(0, 110) });
});

await page.goto("https://fanqienovel.com/rank", { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("goto err", e.message));
await page.waitForTimeout(5000);

console.log("=== 捕获到的 API 请求 ===");
for (const h of hits) console.log(`[${h.status}] ${h.u}\n      ${h.head}\n`);

// 页面上的榜单名 (点击 tab 后才会换数据, 这里先把可见的榜名抓出来)
const boards = await page.evaluate(`(function(){
  var out=[];
  var ns=Array.prototype.slice.call(document.querySelectorAll('a,li,div,span'));
  for(var i=0;i<ns.length;i++){
    var t=(ns[i].textContent||'').trim();
    if(t.length>=2 && t.length<=12 && /榜$/.test(t)) out.push(t);
  }
  return Array.from(new Set(out)).slice(0,40);
})()`).catch(() => []);
console.log("=== 页面里的榜名 ===");
console.log(boards.join(" | "));

await b.close();
process.exit(0);
