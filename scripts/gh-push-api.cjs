// 天衍 → GitHub 推送脚本 (走 REST API, 绕开 git smart-HTTP)
// 用途: 本机沙箱代理屏蔽 github.com 的 git 端点 (CONNECT 502 / 直连 Empty reply) 时,
//       用 GitHub REST API 直接建 blob → tree → commit → PATCH ref 完成推送。
// 用法 (令牌只从环境变量读, 不写进文件):
//   GH_TOKEN=github_pat_xxx node scripts/gh-push-api.cjs            # 默认 y1064709321/tianyan
//   GH_TOKEN=xxx GH_REPO=owner/repo GH_BRANCH=main node scripts/gh-push-api.cjs
// 上传内容 = 本地 HEAD 的完整文件树 (不含被 .gitignore 排除的文件)。
const { execFileSync } = require("node:child_process");

const REPO_ROOT = "C:/Users/l1064/Desktop/tianyan";
const OWNER = process.env.GH_OWNER || "y1064709321";
const REPO = process.env.GH_REPO || "tianyan";
const BRANCH = process.env.GH_BRANCH || "main";
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) throw new Error("缺少 GH_TOKEN 环境变量 (GitHub Personal Access Token, 需 repo 权限)");

async function gh(method, urlPath, body) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch("https://api.github.com" + urlPath, {
      method,
      headers: {
        Authorization: "Bearer " + TOKEN,
        Accept: "application/vnd.github+json",
        "User-Agent": "tianyan-push",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("retry-after") || 2) * 1000;
      console.log(`  ${method} ${urlPath} → ${res.status}, ${wait}ms 后重试 (${attempt}/5)`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${urlPath} 失败 ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
  throw new Error(`${method} ${urlPath} 重试耗尽`);
}

(async () => {
  const ref = await gh("GET", `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const parentSha = ref.object.sha;
  console.log(`远端 ${BRANCH} 当前 HEAD: ${parentSha.slice(0, 7)}`);

  const msg = execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const lines = execFileSync("git", ["ls-tree", "-r", "-z", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\0").filter(Boolean);

  const tree = [];
  let n = 0;
  for (const line of lines) {
    const tabAt = line.indexOf("\t");
    const [mode, type, sha] = line.slice(0, tabAt).split(/\s+/);
    const filepath = line.slice(tabAt + 1);
    if (type !== "blob") continue;
    const buf = execFileSync("git", ["cat-file", "blob", sha], { cwd: REPO_ROOT, encoding: "buffer" });
    const blob = await gh("POST", `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: buf.toString("base64"),
      encoding: "base64",
    });
    tree.push({ path: filepath, mode, type: "blob", sha: blob.sha });
    if (++n % 20 === 0) console.log(`  已上传 blob ${n}/${lines.length}`);
  }
  console.log(`blob 全部就绪: ${tree.length} 个`);

  const treeObj = await gh("POST", `/repos/${OWNER}/${REPO}/git/trees`, { tree });
  const commit = await gh("POST", `/repos/${OWNER}/${REPO}/git/commits`, {
    message: msg,
    tree: treeObj.sha,
    parents: [parentSha],
  });
  await gh("PATCH", `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha });

  console.log(`推送完成: 远端 ${BRANCH} → ${commit.sha.slice(0, 7)}`);
  console.log(`https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
})().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
