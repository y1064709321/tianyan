class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;
  async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    if (this.queue.length > 0) { this.queue.shift()!(); }
    else { this.locked = false; }
  }
}
const _mutex = new Mutex();

// SQLite 持久化层 — better-sqlite3 (同步, 高性能)
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getSettings } from "./config.js";
import type { Project, Chapter, Element, Chunk, Message, Run, CharacterProfile } from "./types.js";

let _db: Database.Database | null = null;

function uuid(): string {
  return randomBytes(6).toString("hex");
}

function now(): number {
  return Date.now() / 1000;
}

export function getDb(): Database.Database {
  if (_db) return _db;
  const s = getSettings();
  mkdirSync(dirname(s.dbPath), { recursive: true });
  _db = new Database(s.dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  return _db;
}

export function initDb(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, genre TEXT, premise TEXT,
      style TEXT, audience TEXT DEFAULT '', meta TEXT DEFAULT '{}', current_phase INTEGER DEFAULT 1, created_at REAL
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, idx INTEGER NOT NULL,
      outline TEXT, content TEXT DEFAULT '', status TEXT DEFAULT 'draft', created_at REAL, updated_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      name TEXT NOT NULL, detail TEXT NOT NULL, created_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source TEXT NOT NULL, idx INTEGER NOT NULL,
      text TEXT NOT NULL, embedding TEXT, created_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      tool_name TEXT, tool_call_id TEXT, created_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS foreshadowings (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
      planted_chapter INTEGER, expected_recovery INTEGER, actual_recovery INTEGER,
      status TEXT DEFAULT 'planted', created_at REAL, updated_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS timeline_events (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, event TEXT NOT NULL,
      chapter_idx INTEGER, time_in_story TEXT, cause TEXT, effect TEXT, created_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS character_states (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, character_name TEXT NOT NULL,
      current_state TEXT NOT NULL, latest_chapter INTEGER, created_at REAL, updated_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_input TEXT NOT NULL,
      entry_agent TEXT NOT NULL, status TEXT DEFAULT 'running', total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0, total_steps INTEGER DEFAULT 0, total_cache_hit_tokens INTEGER DEFAULT 0,
      total_cache_miss_tokens INTEGER DEFAULT 0, error TEXT,
      started_at REAL NOT NULL, ended_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS run_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, type TEXT NOT NULL, agent TEXT,
      tool TEXT, input TEXT, output TEXT, duration_ms INTEGER, error TEXT,
      seq INTEGER, ts REAL, tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0,
      cache_hit_tokens INTEGER DEFAULT 0, cache_miss_tokens INTEGER DEFAULT 0,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS character_profiles (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT, personality TEXT, speech_style TEXT, behavior_logic TEXT,
      motivation TEXT, arc TEXT, growth_state TEXT, created_at REAL, updated_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS world_entries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, attributes TEXT DEFAULT '{}', related_chars TEXT DEFAULT '[]',
      created_at REAL, updated_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter_idx INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending',
      reached_chapter INTEGER, created_at REAL, updated_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS style_cache (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter_idx INTEGER NOT NULL,
      features TEXT DEFAULT '{}', keywords TEXT DEFAULT '{}', created_at REAL,
      UNIQUE(project_id, chapter_idx),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    -- 全书弧线快照 (autonomous 模式: 每章完成后记录爽点密度/打回状态, 供主 Agent 动态调整)
    CREATE TABLE IF NOT EXISTS arc_snapshots (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter_idx INTEGER NOT NULL,
      density REAL NOT NULL, rejected INTEGER NOT NULL DEFAULT 0, ts REAL NOT NULL,
      UNIQUE(project_id, chapter_idx),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    -- 全书弧线目标 (项目创建时由 LLM 生成一次, 存 meta 之外的独立列便于查询)
    CREATE TABLE IF NOT EXISTS arc_targets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
      target_chapters INTEGER NOT NULL, target_density REAL NOT NULL,
      peak_chapter INTEGER NOT NULL, arc_plan TEXT NOT NULL,
      created_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    -- 短期记忆 (session-scoped, TTL 过期)
    CREATE TABLE IF NOT EXISTS session_memories (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
      category TEXT NOT NULL, topic TEXT NOT NULL, content TEXT NOT NULL,
      source TEXT DEFAULT 'auto', relevance REAL DEFAULT 1.0,
      created_at REAL, expires_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sm_project ON session_memories(project_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_sm_topic ON session_memories(project_id, topic);
    -- 上下文滚动摘要 (128k 窗口自动压缩用): 每个项目+会话一条, upto_id 记录已压缩到哪条消息
    CREATE TABLE IF NOT EXISTS context_summaries (
      project_id TEXT NOT NULL, session_id TEXT NOT NULL,
      upto_id TEXT NOT NULL, summary TEXT NOT NULL, updated_at REAL,
      PRIMARY KEY (project_id, session_id)
    );
    -- 长期记忆 (persistent, 可被 supersede)
    CREATE TABLE IF NOT EXISTS long_term_memories (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, category TEXT NOT NULL,
      topic TEXT NOT NULL, content TEXT NOT NULL, source TEXT DEFAULT 'agent',
      priority INTEGER DEFAULT 5, superseded_by TEXT, created_at REAL, updated_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ltm_project ON long_term_memories(project_id, category);
    CREATE INDEX IF NOT EXISTS idx_ltm_topic ON long_term_memories(project_id, topic);
    -- 记忆冲突日志
    CREATE TABLE IF NOT EXISTS memory_conflicts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, old_memory_id TEXT NOT NULL,
      new_memory_id TEXT NOT NULL, resolution TEXT NOT NULL, reason TEXT, created_at REAL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    -- 章节摘要 (上下文注入: 远历史摘要 + 近历史全文的滚动机制)
    CREATE TABLE IF NOT EXISTS chapter_summaries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter_id TEXT NOT NULL, chapter_idx INTEGER NOT NULL,
      summary TEXT NOT NULL, key_events TEXT DEFAULT '', new_foreshadowings TEXT DEFAULT '',
      created_at REAL, updated_at REAL,
      UNIQUE(project_id, chapter_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
  // 迁移: 确保 projects 表有 current_phase 列 (老数据库兼容)
  try {
    db.prepare("SELECT current_phase FROM projects LIMIT 1").get();
  } catch {
    try { db.exec("ALTER TABLE projects ADD COLUMN current_phase INTEGER DEFAULT 1"); } catch {}
  }
  // 迁移: 老数据库补 chapter_summaries 表 (已建好则忽略)
  try { db.exec("SELECT summary FROM chapter_summaries LIMIT 1"); } catch {
    try { db.exec(`CREATE TABLE IF NOT EXISTS chapter_summaries (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter_id TEXT NOT NULL, chapter_idx INTEGER NOT NULL,
      summary TEXT NOT NULL, key_events TEXT DEFAULT '', new_foreshadowings TEXT DEFAULT '',
      created_at REAL, updated_at REAL,
      UNIQUE(project_id, chapter_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`); } catch {}
  }

  // 中断恢复: 孤儿 run 标记为 interrupted
  db.prepare("UPDATE runs SET status='interrupted' WHERE status='running'").run();
  db.prepare("UPDATE chapters SET status='failed' WHERE status='generating'").run();
}

// ----- Projects -----
function withLock<T>(fn: () => T): T {
  // better-sqlite3 is synchronous and Node.js is single-threaded,
  // so the spinlock is unnecessary. Use a try/catch for safety.
  return fn();
}

export function createProject(name: string, genre = "", premise = "", style = "", audience = ""): string {
  return withLock(() => {
  const id = uuid();
  getDb().prepare(
    "INSERT INTO projects (id, name, genre, premise, style, audience, meta, current_phase, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, name, genre, premise, style, audience, "{}", 1, now());
  return id;
  });
}

export function getProject(pid: string): Project | undefined {
  return getDb().prepare("SELECT * FROM projects WHERE id=?").get(pid) as Project | undefined;
}

/**
 * 局部更新项目字段 —— 只更新传进来的那几个, undefined 的列原样不动。
 *
 * 之前只有 createProject, 项目建完就再也改不了题材/文风/核心设定 (「项目设置」那行
 * 只是展示)。题材库扩到 100+ 个标签之后, 老项目还用着旧词, 没有更新接口就没法修正。
 */
export function updateProject(
  pid: string,
  patch: { name?: string; genre?: string; style?: string; premise?: string; audience?: string },
): void {
  const cols: Array<[string, string | undefined]> = [
    ["name", patch.name],
    ["genre", patch.genre],
    ["style", patch.style],
    ["premise", patch.premise],
    ["audience", patch.audience],
  ];
  const sets: string[] = [];
  const vals: string[] = [];
  for (const [col, v] of cols) {
    if (typeof v === "string") { sets.push(`${col}=?`); vals.push(v); }
  }
  if (!sets.length) return;
  vals.push(pid);
  getDb().prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id=?`).run(...vals);
}

export function getProjectState(pid: string): {
  currentPhase: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  hasCharacters: boolean;
  hasWorld: boolean;
  hasOutline: boolean;
  hasContent: boolean;
  hasChapters: boolean;
} {
  const proj = getProject(pid);
  // DB 列名是 current_phase (snake_case), TypeScript 接口可能映射不一致
  const currentPhase = ((proj as any)?.current_phase ?? (proj as any)?.currentPhase ?? 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  const characters = listCharacterProfiles(pid);
  const worldEntries = listWorldEntries(pid);
  const chapters = listChapters(pid);
  const hasOutline = chapters.some(c => c.outline?.length > 0);
  const hasContent = chapters.some(c => c.content?.length > 0);
  return {
    currentPhase,
    hasCharacters: characters.length > 0,
    hasWorld: worldEntries.length > 0,
    hasOutline,
    hasContent,
    hasChapters: chapters.length > 0,
  };
}

export function updateProjectPhase(pid: string, phase: number): void {
  getDb().prepare("UPDATE projects SET current_phase=? WHERE id=?").run(phase, pid);
}

export function listProjects(): Project[] {
  return getDb().prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as Project[];
}

/**
 * 项目列表摘要 —— 侧边栏项目区专用。
 *
 * 为什么不用 listProjects(): projects 表是 snake_case, `SELECT *` 直接 cast 成
 * Project 后 createdAt 其实是 undefined, 前端拿不到任何时间信息。而且列表要展示
 * "几章/多少字/多久前动过", 这些都在别的表里, 一次 join 出来比前端 N+1 请求划算。
 *
 * updatedAt 取 "建项时间 / 最后一条消息 / 最后改过的章节" 三者最大值 ——
 * 光看 created_at 的话, 天天写的项目会一直排在最后, 排序完全失真。
 */
export interface ProjectSummary {
  id: string;
  name: string;
  genre: string;
  audience: string;
  createdAt: number;
  updatedAt: number;
  chapterCount: number;
  wordCount: number;
}

export function listProjectSummaries(): ProjectSummary[] {
  const rows = getDb().prepare(`
    SELECT p.id AS id,
           p.name AS name,
           COALESCE(p.genre, '') AS genre,
           COALESCE(p.audience, '') AS audience,
           COALESCE(p.created_at, 0) AS created_at,
           MAX(
             COALESCE(p.created_at, 0),
             COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.project_id = p.id), 0),
             COALESCE((SELECT MAX(c.updated_at) FROM chapters c WHERE c.project_id = p.id), 0)
           ) AS updated_at,
           (SELECT COUNT(*) FROM chapters c WHERE c.project_id = p.id) AS chapter_count,
           COALESCE((SELECT SUM(LENGTH(c.content)) FROM chapters c WHERE c.project_id = p.id), 0) AS word_count
    FROM projects p
    ORDER BY updated_at DESC
  `).all() as Array<{
    id: string; name: string; genre: string; audience: string;
    created_at: number; updated_at: number; chapter_count: number; word_count: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    genre: r.genre,
    audience: r.audience,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    chapterCount: r.chapter_count,
    wordCount: r.word_count,
  }));
}

export function deleteProject(pid: string): void {
  const db = getDb();
  // 显式清理全部关联表 (不依赖外键级联, 双保险; 有 project_id 直接删, run_events 经 runs 间接删)
  const del = db.transaction(() => {
    db.prepare("DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE project_id=?)").run(pid);
    db.prepare("DELETE FROM runs WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM style_cache WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM milestones WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM world_entries WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM character_profiles WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM timeline_events WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM foreshadowings WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM character_states WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM session_memories WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM long_term_memories WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM memory_conflicts WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM messages WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM chunks WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM elements WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM chapters WHERE project_id=?").run(pid);
    db.prepare("DELETE FROM projects WHERE id=?").run(pid);
  });
  del();
  // 物理收缩: WAL checkpoint 后 VACUUM 释放磁盘空间, 否则删除的行仍占文件
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  } catch { /* VACUUM 失败不阻塞删除 */ }
}

// ----- Chapters -----
export function addChapter(pid: string, title: string, idx: number, outline = "", content = ""): string {
  const id = uuid();
  const t = now();
  getDb().prepare(
    "INSERT INTO chapters (id,project_id,title,idx,outline,content,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, pid, title, idx, outline, content, "draft", t, t);
  return id;
}

export function getChapter(cid: string): Chapter | undefined {
  return getDb().prepare("SELECT * FROM chapters WHERE id=?").get(cid) as Chapter | undefined;
}

export function listChapters(pid: string): Chapter[] {
  return getDb().prepare("SELECT * FROM chapters WHERE project_id=? ORDER BY idx").all(pid) as Chapter[];
}

export function updateChapter(cid: string, fields: Partial<Pick<Chapter, "title" | "outline" | "content" | "status">>): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && ["title", "outline", "content", "status"].includes(k)) {
      sets.push(`${k}=?`);
      vals.push(v);
    }
  }
  if (!sets.length) return;
  sets.push("updated_at=?");
  vals.push(now(), cid);
  getDb().prepare(`UPDATE chapters SET ${sets.join(",")} WHERE id=?`).run(...vals);
}

export function deleteChapter(cid: string): void {
  getDb().prepare("DELETE FROM chapters WHERE id=?").run(cid);
}

// ----- Elements -----
export function addElement(pid: string, kind: string, name: string, detail: string): string {
  const id = uuid();
  getDb().prepare(
    "INSERT INTO elements (id,project_id,kind,name,detail,created_at) VALUES (?,?,?,?,?,?)"
  ).run(id, pid, kind, name, detail, now());
  return id;
}

export function listElements(pid: string): Element[] {
  return getDb().prepare("SELECT * FROM elements WHERE project_id=? ORDER BY created_at").all(pid) as Element[];
}

// ----- Messages -----
export function addMessage(pid: string, role: string, content: string, opts?: { toolName?: string; toolCallId?: string }): string {
  const id = uuid();
  getDb().prepare(
    "INSERT INTO messages (id,project_id,role,content,tool_name,tool_call_id,created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(id, pid, role, content, opts?.toolName ?? null, opts?.toolCallId ?? null, now());
  return id;
}

export function listMessages(pid: string, limit = 1000): Message[] {
  // P0 修复 (旧会话重进丢失):
  // ① 默认 limit 50→1000: 超过 200 条的旧会话以前被截断, 前端拉不全 → "旧的消息丢失"
  // ② 排序加 rowid 兜底: created_at 精度不足时同秒多条顺序不定, rowid 按真实写入序还原
  return getDb().prepare(
    "SELECT * FROM messages WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?"
  ).all(pid, limit).reverse() as Message[];
}

// 清理历史乱码消息: sub_answer/sub_agent_done 正文含原始 JSON 标记 ({"platform"/\u003cscript) 的记录
// 这些是修复前写入的脏数据, 刷新页面时会被前端重新渲染成乱码, 启动时清掉
export function cleanGarbledMessages(): number {
  const patterns = ['{"platform"', '\u003cscript', '"items":', '\\"items\\"'];
  let deleted = 0;
  for (const pat of patterns) {
    const r = getDb().prepare(
      "DELETE FROM messages WHERE tool_name IN ('sub_answer','sub_agent_done') AND content LIKE ?"
    ).run('%' + pat + '%');
    deleted += r.changes;
  }
  if (deleted > 0) console.log(`[store] 清理历史乱码消息: ${deleted} 条 (sub_answer/sub_agent_done 含原始 JSON)`);
  return deleted;
}

// ----- Runs -----
export function createRun(pid: string, userInput: string, agentName: string): string {
  const id = uuid();
  getDb().prepare(
    "INSERT INTO runs (id,project_id,user_input,entry_agent,status,started_at) VALUES (?,?,?,?,?,?)"
  ).run(id, pid, userInput, agentName, "running", now());
  return id;
}

export function finishRun(runId: string, status = "done"): void {
  getDb().prepare("UPDATE runs SET status=?, ended_at=? WHERE id=?").run(status, now(), runId);
}

// 累计本次 run 的 token 用量 (由 runner 在 finishRun 前调用, 累加到 runs.total_tokens)
export function addRunTokens(runId: string, tokens: number): void {
  if (!tokens || tokens <= 0) return;
  getDb().prepare("UPDATE runs SET total_tokens=total_tokens+? WHERE id=?").run(tokens, runId);
}

export function addRunEvent(runId: string, eventType: string, opts?: Record<string, unknown>): string {
  const id = uuid();
  // seq 自增 (同 run 内 MAX(seq)+1): 旧实现默认 0 导致 getRunEvents(seq>0) 永远查不到, resume 回放空
  // sse 类型事件 (思考/正文/质检结论) 放宽截断, 避免回放时正文被砍
  const outputLimit = eventType === "sse" ? 50000 : 2000;
  getDb().prepare(
    "INSERT INTO run_events (id,run_id,seq,ts,type,agent,tool,input,output,duration_ms,error) VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM run_events WHERE run_id=?),?,?,?,?,?,?,?,?)"
  ).run(
    id, runId, runId, (opts?.ts as number) ?? Date.now() / 1000, eventType,
    opts?.agent ?? null, opts?.tool ?? null,
    opts?.input_ ? JSON.stringify(opts.input_) : null,
    opts?.output ? String(opts.output).slice(0, outputLimit) : null,
    opts?.duration_ms ?? null,
    opts?.error ?? null,
  );
  return id;
}

// ----- Stats -----
export function stats(pid: string): Record<string, number> {
  const chapters = listChapters(pid);
  const elements = listElements(pid);
  return {
    chapters: chapters.length,
    totalChapters: chapters.length,
    completedChapters: chapters.filter((c) => c.status === "done" || c.status === "reviewed" || c.status === "revision_needed").length,
    totalElements: elements.length,
    totalMessages: (getDb().prepare("SELECT COUNT(*) as c FROM messages WHERE project_id=?").get(pid) as { c: number }).c,
  };
}

// ----- Character Profiles -----
export function upsertCharacterProfile(
  pid: string, name: string,
  fields: Partial<Pick<CharacterProfile, "role" | "personality" | "speechStyle" | "behaviorLogic" | "motivation" | "arc" | "growthState">>,
): string {
  const t = now();
  const existing = getDb().prepare(
    "SELECT id FROM character_profiles WHERE project_id=? AND name=?"
  ).get(pid, name) as { id: string } | undefined;
  if (existing) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const colMap: Record<string, string> = {
      role: "role", personality: "personality", speechStyle: "speech_style",
      behaviorLogic: "behavior_logic", motivation: "motivation", arc: "arc", growthState: "growth_state",
    };
    for (const [k, col] of Object.entries(colMap)) {
      if (fields[k as keyof typeof fields] !== undefined) {
        sets.push(`${col}=?`);
        vals.push(fields[k as keyof typeof fields]);
      }
    }
    if (sets.length) {
      sets.push("updated_at=?");
      vals.push(t, existing.id);
      getDb().prepare(`UPDATE character_profiles SET ${sets.join(",")} WHERE id=?`).run(...vals);
    }
    return existing.id;
  }
  const id = uuid();
  getDb().prepare(
    "INSERT INTO character_profiles (id,project_id,name,role,personality,speech_style,behavior_logic,motivation,arc,growth_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(id, pid, name, fields.role ?? null, fields.personality ?? null,
    fields.speechStyle ?? null, fields.behaviorLogic ?? null, fields.motivation ?? null,
    fields.arc ?? null, fields.growthState ?? null, t, t);
  return id;
}

export function listCharacterProfiles(pid: string): CharacterProfile[] {
  // 表列名是 snake_case (speech_style / behavior_logic / growth_state),
  // 直接 `SELECT *` 出来的对象没有 CharacterProfile 声明的 camelCase 字段,
  // 导致下游 `p.speechStyle` 永远是 undefined (角色说话风格从未真正注入上下文)。
  // 这里做一次列名映射, 让返回值与 CharacterProfile 类型一致。
  const rows = getDb().prepare("SELECT * FROM character_profiles WHERE project_id=? ORDER BY created_at").all(pid) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id ?? ""),
    projectId: String(r.project_id ?? pid),
    name: String(r.name ?? ""),
    role: (r.role as string) ?? undefined,
    personality: (r.personality as string) ?? undefined,
    speechStyle: (r.speech_style as string) ?? undefined,
    behaviorLogic: (r.behavior_logic as string) ?? undefined,
    motivation: (r.motivation as string) ?? undefined,
    arc: (r.arc as string) ?? undefined,
    growthState: (r.growth_state as string) ?? undefined,
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
  }));
}

export function getCharacterProfile(pid: string, name: string): CharacterProfile | undefined {
  return getDb().prepare("SELECT * FROM character_profiles WHERE project_id=? AND name=?").get(pid, name) as CharacterProfile | undefined;
}

// ----- 上下文滚动摘要 (自动压缩) -----
export function getContextSummary(pid: string, sid: string): { uptoId: string; summary: string } | undefined {
  const row = getDb().prepare(
    "SELECT upto_id, summary FROM context_summaries WHERE project_id=? AND session_id=?"
  ).get(pid, sid) as { upto_id: string; summary: string } | undefined;
  return row ? { uptoId: row.upto_id, summary: row.summary } : undefined;
}

export function saveContextSummary(pid: string, sid: string, uptoId: string, summary: string): void {
  getDb().prepare(
    `INSERT INTO context_summaries (project_id, session_id, upto_id, summary, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(project_id, session_id) DO UPDATE SET upto_id=excluded.upto_id, summary=excluded.summary, updated_at=excluded.updated_at`
  ).run(pid, sid, uptoId, summary, now());
}

// ----- Chunks (检索用) -----
export function listChunks(pid: string): Chunk[] {
  return getDb().prepare("SELECT * FROM chunks WHERE project_id=? ORDER BY idx").all(pid) as Chunk[];
}

export function addChunk(pid: string, source: string, idx: number, text: string): string {
  const id = uuid();
  getDb().prepare(
    "INSERT INTO chunks (id,project_id,source,idx,text,created_at) VALUES (?,?,?,?,?,?)"
  ).run(id, pid, source, idx, text, now());
  return id;
}

/**
 * 素材库索引: 按文件名聚合 chunks。
 * 前端左侧「素材库」和模型上下文共用这一份口径 —— 以前前端读 p.sources, 而
 * /api/projects/:pid 根本不返回 sources, 于是"上传成功但素材库永远 0"。
 */
export function listSources(pid: string): Array<{ source: string; chunks: number; chars: number }> {
  return getDb().prepare(
    "SELECT source, COUNT(*) AS chunks, SUM(LENGTH(text)) AS chars FROM chunks WHERE project_id=? GROUP BY source ORDER BY MIN(created_at)"
  ).all(pid) as Array<{ source: string; chunks: number; chars: number }>;
}

/** 取某个素材的全文 (chunks 按 idx 拼回原文) */
export function getSourceText(pid: string, source: string): string {
  const rows = getDb().prepare(
    "SELECT text FROM chunks WHERE project_id=? AND source=? ORDER BY idx"
  ).all(pid, source) as Array<{ text: string }>;
  return rows.map((r) => r.text).join("");
}

/** 删掉某个素材 (同名重传前先清旧块, 避免叠加) */
export function deleteSource(pid: string, source: string): number {
  return getDb().prepare("DELETE FROM chunks WHERE project_id=? AND source=?").run(pid, source).changes;
}

// ----- Foreshadowings -----
export function listForeshadowings(pid: string): Array<Record<string, unknown>> {
  return getDb().prepare("SELECT * FROM foreshadowings WHERE project_id=?").all(pid) as Array<Record<string, unknown>>;
}

// ----- Timeline -----
export function listTimelineEvents(pid: string): Array<Record<string, unknown>> {
  return getDb().prepare("SELECT * FROM timeline_events WHERE project_id=?").all(pid) as Array<Record<string, unknown>>;
}

// ----- Character States -----
export function listCharacterStates(pid: string): Array<Record<string, unknown>> {
  return getDb().prepare("SELECT * FROM character_states WHERE project_id=?").all(pid) as Array<Record<string, unknown>>;
}

export function upsertCharacterState(pid: string, characterName: string, currentState: string, latestChapter: number): string {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM character_states WHERE project_id=? AND character_name=?")
    .get(pid, characterName) as { id: string } | undefined;
  const t = now();
  if (existing) {
    db.prepare(
      "UPDATE character_states SET current_state=?, latest_chapter=?, updated_at=? WHERE id=?",
    ).run(currentState, latestChapter, t, existing.id);
    return existing.id;
  }
  const id = uuid();
  db.prepare(
    "INSERT INTO character_states (id,project_id,character_name,current_state,latest_chapter,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run(id, pid, characterName, currentState, latestChapter, t, t);
  return id;
}

// ----- Chapter Summaries (上下文注入用) -----
export interface ChapterSummary {
  id: string;
  project_id: string;
  chapter_id: string;
  chapter_idx: number;
  summary: string;
  key_events: string;
  new_foreshadowings: string;
}

export function upsertChapterSummary(
  pid: string,
  chapterId: string,
  chapterIdx: number,
  summary: string,
  keyEvents = "",
  newForeshadowings = "",
): string {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM chapter_summaries WHERE project_id=? AND chapter_id=?")
    .get(pid, chapterId) as { id: string } | undefined;
  const t = now();
  if (existing) {
    db.prepare(
      "UPDATE chapter_summaries SET chapter_idx=?, summary=?, key_events=?, new_foreshadowings=?, updated_at=? WHERE id=?",
    ).run(chapterIdx, summary, keyEvents, newForeshadowings, t, existing.id);
    return existing.id;
  }
  const id = uuid();
  db.prepare(
    "INSERT INTO chapter_summaries (id,project_id,chapter_id,chapter_idx,summary,key_events,new_foreshadowings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(id, pid, chapterId, chapterIdx, summary, keyEvents, newForeshadowings, t, t);
  return id;
}

export function listChapterSummaries(pid: string, beforeIdx?: number): ChapterSummary[] {
  const db = getDb();
  if (beforeIdx === undefined) {
    return db.prepare(
      "SELECT * FROM chapter_summaries WHERE project_id=? ORDER BY chapter_idx",
    ).all(pid) as ChapterSummary[];
  }
  return db.prepare(
    "SELECT * FROM chapter_summaries WHERE project_id=? AND chapter_idx<? ORDER BY chapter_idx",
  ).all(pid, beforeIdx) as ChapterSummary[];
}

export function getChapterSummary(pid: string, chapterId: string): ChapterSummary | undefined {
  return getDb()
    .prepare("SELECT * FROM chapter_summaries WHERE project_id=? AND chapter_id=?")
    .get(pid, chapterId) as ChapterSummary | undefined;
}


// ----- Style Cache -----
export function upsertStyleCache(pid: string, chapterIdx: number, features: string, keywords: string): string {
  const existing = getDb().prepare(
    "SELECT id FROM style_cache WHERE project_id=? AND chapter_idx=?"
  ).get(pid, chapterIdx) as { id: string } | undefined;
  if (existing) {
    getDb().prepare("UPDATE style_cache SET features=?, keywords=?, created_at=? WHERE id=?")
      .run(features, keywords, now(), existing.id);
    return existing.id;
  }
  const id = uuid();
  getDb().prepare(
    "INSERT INTO style_cache (id,project_id,chapter_idx,features,keywords,created_at) VALUES (?,?,?,?,?,?)"
  ).run(id, pid, chapterIdx, features, keywords, now());
  return id;
}

// ----- Arc (全书弧线) -----
// 弧线目标: 项目创建时由 LLM 生成一次(目标章数/爽点密度/高潮章节/弧线计划)
export function setArcTarget(
  pid: string,
  targetChapters: number,
  targetDensity: number,
  peakChapter: number,
  arcPlan: string,
): string {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM arc_targets WHERE project_id=?").get(pid) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE arc_targets SET target_chapters=?, target_density=?, peak_chapter=?, arc_plan=?, created_at=? WHERE project_id=?"
    ).run(targetChapters, targetDensity, peakChapter, arcPlan, now(), pid);
    return existing.id;
  }
  const id = uuid();
  db.prepare(
    "INSERT INTO arc_targets (id,project_id,target_chapters,target_density,peak_chapter,arc_plan,created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(id, pid, targetChapters, targetDensity, peakChapter, arcPlan, now());
  return id;
}

export function getArcTarget(pid: string): {
  targetChapters: number; targetDensity: number; peakChapter: number; arcPlan: string;
} | null {
  const row = getDb().prepare("SELECT * FROM arc_targets WHERE project_id=?").get(pid) as
    | { target_chapters: number; target_density: number; peak_chapter: number; arc_plan: string }
    | undefined;
  if (!row) return null;
  return {
    targetChapters: row.target_chapters,
    targetDensity: row.target_density,
    peakChapter: row.peak_chapter,
    arcPlan: row.arc_plan,
  };
}

// 弧线快照: 每章完成后记录(密度 + 是否被打回)
export function recordArcSnapshot(pid: string, chapterIdx: number, density: number, rejected: boolean): void {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM arc_snapshots WHERE project_id=? AND chapter_idx=?").get(pid, chapterIdx) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE arc_snapshots SET density=?, rejected=?, ts=? WHERE id=?").run(density, rejected ? 1 : 0, now(), existing.id);
  } else {
    const id = uuid();
    db.prepare("INSERT INTO arc_snapshots (id,project_id,chapter_idx,density,rejected,ts) VALUES (?,?,?,?,?,?)")
      .run(id, pid, chapterIdx, density, rejected ? 1 : 0, now());
  }
}

export function listArcSnapshots(pid: string): Array<{ chapterIdx: number; density: number; rejected: boolean; ts: number }> {
  const rows = getDb().prepare(
    "SELECT chapter_idx, density, rejected, ts FROM arc_snapshots WHERE project_id=? ORDER BY chapter_idx"
  ).all(pid) as Array<{ chapter_idx: number; density: number; rejected: number; ts: number }>;
  return rows.map((r) => ({ chapterIdx: r.chapter_idx, density: r.density, rejected: !!r.rejected, ts: r.ts }));
}

// ----- World Entries -----
export function addWorldEntry(pid: string, category: string, name: string, description: string, attributes = "{}", relatedChars = "[]"): string {
  const id = uuid();
  getDb().prepare(
    "INSERT INTO world_entries (id,project_id,category,name,description,attributes,related_chars,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, pid, category, name, description, attributes, relatedChars, now(), now());
  return id;
}

export function listWorldEntries(pid: string, category?: string): Array<Record<string, unknown>> {
  if (category) {
    return getDb().prepare("SELECT * FROM world_entries WHERE project_id=? AND category=? ORDER BY created_at").all(pid, category) as Array<Record<string, unknown>>;
  }
  return getDb().prepare("SELECT * FROM world_entries WHERE project_id=? ORDER BY category, created_at").all(pid) as Array<Record<string, unknown>>;
}

export function updateWorldEntry(id: string, fields: { description?: string; attributes?: string; related_chars?: string }): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.description !== undefined) { sets.push("description=?"); vals.push(fields.description); }
  if (fields.attributes !== undefined) { sets.push("attributes=?"); vals.push(fields.attributes); }
  if (fields.related_chars !== undefined) { sets.push("related_chars=?"); vals.push(fields.related_chars); }
  if (!sets.length) return;
  sets.push("updated_at=?"); vals.push(now());
  vals.push(id);
  getDb().prepare(`UPDATE world_entries SET ${sets.join(",")} WHERE id=?`).run(...vals);
}

export function deleteWorldEntry(id: string): void {
  getDb().prepare("DELETE FROM world_entries WHERE id=?").run(id);
}

// ----- Milestones -----
export function addMilestone(pid: string, chapterIdx: number, title: string, description = ""): string {
  const id = uuid();
  getDb().prepare(
    "INSERT INTO milestones (id,project_id,chapter_idx,title,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, pid, chapterIdx, title, description, "pending", now(), now());
  return id;
}

export function listMilestones(pid: string): Array<Record<string, unknown>> {
  return getDb().prepare("SELECT * FROM milestones WHERE project_id=? ORDER BY chapter_idx").all(pid) as Array<Record<string, unknown>>;
}

export function updateMilestone(id: string, fields: { status?: string; reached_chapter?: number; description?: string }): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.status !== undefined) { sets.push("status=?"); vals.push(fields.status); }
  if (fields.reached_chapter !== undefined) { sets.push("reached_chapter=?"); vals.push(fields.reached_chapter); }
  if (fields.description !== undefined) { sets.push("description=?"); vals.push(fields.description); }
  if (!sets.length) return;
  sets.push("updated_at=?"); vals.push(now());
  vals.push(id);
  getDb().prepare(`UPDATE milestones SET ${sets.join(",")} WHERE id=?`).run(...vals);
}

export function deleteMilestone(id: string): void {
  getDb().prepare("DELETE FROM milestones WHERE id=?").run(id);
}

// ----- Foreshadowings -----
export function addForeshadowing(pid: string, name: string, content: string, plantedChapter: number, expectedRecovery?: number): string {
  const id = uuid();
  getDb().prepare(
    "INSERT INTO foreshadowings (id,project_id,name,content,planted_chapter,expected_recovery,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, pid, name, content, plantedChapter, expectedRecovery ?? null, "planted", now(), now());
  return id;
}

export function listForeshadowings2(pid: string): Array<Record<string, unknown>> {
  return getDb().prepare("SELECT * FROM foreshadowings WHERE project_id=? ORDER BY planted_chapter").all(pid) as Array<Record<string, unknown>>;
}

export function updateForeshadowing(id: string, fields: { status?: string; actual_recovery?: number }): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.status !== undefined) { sets.push("status=?"); vals.push(fields.status); }
  if (fields.actual_recovery !== undefined) { sets.push("actual_recovery=?"); vals.push(fields.actual_recovery); }
  if (!sets.length) return;
  sets.push("updated_at=?"); vals.push(now());
  vals.push(id);
  getDb().prepare(`UPDATE foreshadowings SET ${sets.join(",")} WHERE id=?`).run(...vals);
}

export function deleteForeshadowing(id: string): void {
  getDb().prepare("DELETE FROM foreshadowings WHERE id=?").run(id);
}

// ----- Outline (chapter outline management) -----
export function updateChapterOutline(cid: string, outline: string): void {
  getDb().prepare("UPDATE chapters SET outline=?, updated_at=? WHERE id=?").run(outline, now(), cid);
}

// ===== 补充的 store 函数 (供前端 API 使用) =====

export function listRuns(pid: string, limit = 50): Run[] {
  return getDb().prepare(
    "SELECT * FROM runs WHERE project_id=? ORDER BY started_at DESC LIMIT ?"
  ).all(pid, limit) as Run[];
}

export function getRun(runId: string): Run | undefined {
  return getDb().prepare("SELECT * FROM runs WHERE id=?").get(runId) as Run | undefined;
}

export function getRunEvents(runId: string, afterSeq = 0): Array<{ id: string; run_id: string; seq: number; ts: number; type: string; agent: string | null; tool: string | null; input: string | null; output: string | null; duration_ms: number | null; error: string | null }> {
  return getDb().prepare(
    "SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq ASC"
  ).all(runId, afterSeq) as any[];
}

export function deleteRun(runId: string): void {
  getDb().prepare("DELETE FROM runs WHERE id=?").run(runId);
}

export function deleteMessages(pid: string): number {
  return getDb().prepare("DELETE FROM messages WHERE project_id=?").run(pid).changes;
}

export function deleteElement(eid: string): void {
  getDb().prepare("DELETE FROM elements WHERE id=?").run(eid);
}

export function searchMessages(pid: string, query: string, limit = 50): Message[] {
  const q = `%${query}%`;
  return getDb().prepare(
    "SELECT * FROM messages WHERE project_id=? AND (content LIKE ? OR tool_name LIKE ?) ORDER BY created_at DESC LIMIT ?"
  ).all(pid, q, q, limit) as Message[];
}

export function getMetrics(pid: string) {
  const db = getDb();
  const proj = db.prepare("SELECT * FROM projects WHERE id=?").get(pid) as Project | undefined;
  const chapters = db.prepare("SELECT COUNT(*) as cnt, SUM(LENGTH(content)) as total_chars FROM chapters WHERE project_id=?").get(pid) as { cnt: number; total_chars: number };
  const runs = db.prepare("SELECT COUNT(*) as cnt, SUM(total_tokens) as tokens, SUM(total_cost) as cost FROM runs WHERE project_id=?").get(pid) as { cnt: number; tokens: number; cost: number };
  const elements = db.prepare("SELECT COUNT(*) as cnt FROM elements WHERE project_id=?").get(pid) as { cnt: number };
  const profiles = db.prepare("SELECT COUNT(*) as cnt FROM character_profiles WHERE project_id=?").get(pid) as { cnt: number };
  const foreshadows = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='recovered' THEN 1 ELSE 0 END) as recovered FROM foreshadowings WHERE project_id=?").get(pid) as { total: number; recovered: number };
  return {
    project: proj,
    chapters: { count: chapters.cnt, totalChars: chapters.total_chars || 0 },
    runs: { count: runs.cnt, totalTokens: runs.tokens || 0, totalCost: runs.cost || 0 },
    elements: elements.cnt,
    characterProfiles: profiles.cnt,
    foreshadowings: { total: foreshadows.total, recovered: foreshadows.recovered || 0 },
  };
}

export function getExportData(pid: string, fmt = "txt") {
  const proj = getProject(pid);
  const chapters = listChapters(pid).sort((a, b) => a.idx - b.idx);
  if (fmt === "json") {
    return { project: proj, chapters: chapters.map((c) => ({ title: c.title, idx: c.idx, outline: c.outline, content: c.content, status: c.status })) };
  }
  // txt format
  let text = `《${proj?.name || "未命名"}》\n${"=".repeat(40)}\n\n`;
  for (const ch of chapters) {
    text += `# 第${ch.idx + 1}章 ${ch.title}\n\n`;
    text += (ch.content || ch.outline || "（无内容）") + "\n\n";
  }
  return { text, project: proj };
}

// ----- Phase Gate (主 agent 询问门禁): 用 projects.meta JSON 存"待确认的下一门" -----
/** 设置待确认门: 完成某阶段后, 标记"需要用户确认才能进入 targetPhase"。 */
export function setPendingGate(pid: string, targetPhase: number, question: string): void {
  const proj = getProject(pid);
  if (!proj) return;
  const meta = parseMetaSafe(proj.meta);
  meta.pendingGate = { targetPhase, question, setAt: now() };
  getDb().prepare("UPDATE projects SET meta=? WHERE id=?").run(JSON.stringify(meta), pid);
}

/** 读取并清除待确认门。返回 null = 无门。 */
export function takePendingGate(pid: string): { targetPhase: number; question: string } | null {
  const proj = getProject(pid);
  if (!proj) return null;
  const meta = parseMetaSafe(proj.meta);
  if (!meta.pendingGate) return null;
  const gate = meta.pendingGate as { targetPhase: number; question: string };
  delete meta.pendingGate;
  getDb().prepare("UPDATE projects SET meta=? WHERE id=?").run(JSON.stringify(meta), pid);
  return gate;
}

/** 只读: 当前是否有待确认门 (不清除)。 */
export function peekPendingGate(pid: string): { targetPhase: number; question: string } | null {
  const proj = getProject(pid);
  if (!proj) return null;
  const meta = parseMetaSafe(proj.meta);
  return meta.pendingGate as { targetPhase: number; question: string } || null;
}

function parseMetaSafe(meta: string): Record<string, unknown> {
  try { return JSON.parse(meta || "{}"); } catch { return {}; }
}
