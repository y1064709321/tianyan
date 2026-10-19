// 共享文笔样本库 —— 跨项目共用的一份"好文笔"素材
//
// 与项目库的区别:
//   - long_term_memories 按 project_id 隔离, 是"这本书自己记得什么"
//   - 本模块不按项目隔离, 是"所有书共用的一套文笔范本"
//
// 为什么单独存一个库文件: 用户删项目时会 VACUUM 主库, 如果样本混在主库里,
// 删一本书可能把共用素材带走; 独立文件 + 独立连接, 生命周期与项目彻底解耦。
//
// 实时更新: 每次 readStyleSamples 都直接查库(不缓存), 写入立即对下一次读取可见。

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { logInfo } from "./logger.js";

/** 样本类型: 决定它在写作提示里出现在哪个位置 */
export type StyleSampleKind = "opening" | "dialogue" | "action" | "description" | "ending" | "other";

export interface StyleSample {
  id: string;
  /** 片段原文 */
  text: string;
  kind: StyleSampleKind;
  /** 题材标签 (如 "玄幻" "都市"), 空 = 通用 */
  genre: string;
  /** 来源说明: 哪本书/哪一章/哪部对标作品 */
  source: string;
  /** 人工评分 1-5, 越高越优先注入 */
  rating: number;
  /** 使用次数: 被注入过几次, 用于淘汰低效样本 */
  used_count: number;
  created_at: number;
  updated_at: number;
}

let db: Database.Database | null = null;

function dbPath(): string {
  // 允许用环境变量改位置, 方便测试与迁移
  return process.env.TIANYAN_STYLE_DB || join(homedir(), ".tianyan", "style-samples.db");
}

function getDb(): Database.Database {
  if (db) return db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS style_samples (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      genre TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      rating INTEGER NOT NULL DEFAULT 3,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ss_kind ON style_samples(kind);
    CREATE INDEX IF NOT EXISTS idx_ss_genre ON style_samples(genre);
    CREATE INDEX IF NOT EXISTS idx_ss_rating ON style_samples(rating DESC, used_count ASC);
  `);
  return db;
}

const now = (): number => Date.now();

/** 归一化: 去首尾空白、压连续空行, 避免同一样本因空白差异重复入库 */
function normalize(text: string): string {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 新增样本。同一条文本已存在时更新评分/来源, 不重复插入。
 * 返回样本 id。
 */
export function addStyleSample(input: {
  text: string;
  kind?: StyleSampleKind;
  genre?: string;
  source?: string;
  rating?: number;
}): string | null {
  const text = normalize(input.text);
  // 太短的片段没有参考价值, 太长的会挤爆预算
  if (text.length < 20 || text.length > 4000) return null;

  const d = getDb();
  const existing = d.prepare("SELECT id FROM style_samples WHERE text = ?").get(text) as { id: string } | undefined;
  if (existing) {
    d.prepare("UPDATE style_samples SET rating=?, genre=?, source=?, updated_at=? WHERE id=?").run(
      Math.max(1, Math.min(5, Math.round(input.rating ?? 3))),
      String(input.genre || ""),
      String(input.source || ""),
      now(),
      existing.id,
    );
    return existing.id;
  }

  const id = randomUUID();
  d.prepare(
    "INSERT INTO style_samples (id,text,kind,genre,source,rating,used_count,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)",
  ).run(
    id,
    text,
    String(input.kind || "other"),
    String(input.genre || ""),
    String(input.source || ""),
    Math.max(1, Math.min(5, Math.round(input.rating ?? 3))),
    now(),
    now(),
  );
  return id;
}

/**
 * 召回样本 (写作时注入)。
 * 排序: 题材匹配优先 → 高分优先 → 少用的优先 (避免老样本反复出现)。
 * 不缓存: 写入后下一次调用立即生效。
 */
export function readStyleSamples(opts: {
  genre?: string;
  kinds?: StyleSampleKind[];
  limit?: number;
  /** 每条最多取多少字, 防止超长样本挤爆预算 */
  perSampleChars?: number;
  /** 总字数预算 */
  totalChars?: number;
} = {}): Array<{ text: string; kind: string; genre: string; source: string; rating: number }> {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
  const perSample = Math.max(200, opts.perSampleChars ?? 600);
  const budget = Math.max(500, opts.totalChars ?? 3000);
  const d = getDb();

  const rows = d
    .prepare(
      `SELECT text, kind, genre, source, rating, used_count,
              (CASE WHEN ? <> '' AND genre = ? THEN 2 ELSE 0 END
             + CASE WHEN ? <> '' AND genre = '' THEN 1 ELSE 0 END) AS genre_rank
       FROM style_samples
       ORDER BY genre_rank DESC, rating DESC, used_count ASC, updated_at DESC
       LIMIT ?`,
    )
    .all(String(opts.genre || ""), String(opts.genre || ""), String(opts.genre || ""), limit * 4) as Array<{
      text: string; kind: string; genre: string; source: string; rating: number; used_count: number;
    }>;

  const out: Array<{ text: string; kind: string; genre: string; source: string; rating: number }> = [];
  let used = 0;
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : null;
  for (const r of rows) {
    if (kinds && !kinds.has(r.kind as StyleSampleKind)) continue;
    const slice = r.text.slice(0, perSample);
    if (used + slice.length > budget) continue;
    out.push({ text: slice, kind: r.kind, genre: r.genre, source: r.source, rating: r.rating });
    used += slice.length;
    if (out.length >= limit) break;
  }

  // 记录使用次数 (实时: 下次排序会自动把这些靠后, 让样本轮换)
  if (out.length) {
    try {
      const upd = d.prepare("UPDATE style_samples SET used_count = used_count + 1, updated_at = ? WHERE text = ?");
      const tx = d.transaction(() => {
        for (const o of out) upd.run(now(), o.text);
      });
      tx();
    } catch { /* 计数失败不影响召回 */ }
  }
  return out;
}

/**
 * 自动从一章正文里抽取可复用片段入库。
 * 抽取策略刻意保守: 只取"有代表性"的段(对话密集/动作密集/开篇收尾), 不做语义判断。
 */
export function harvestFromChapter(opts: {
  content: string;
  genre?: string;
  source: string;
  /** 每章最多抽几条, 防止样本库被单章灌满 */
  maxPerChapter?: number;
}): number {
  const content = normalize(opts.content);
  if (content.length < 300) return 0;
  const max = Math.max(1, Math.min(5, opts.maxPerChapter ?? 2));

  const paras = content.split(/\n+/).map((p) => p.trim()).filter((p) => p.length >= 40 && p.length <= 1200);
  if (!paras.length) return 0;

  const scored = paras.map((p) => {
    const quotes = (p.match(/[“"」』]/g) || []).length;
    const verbs = (p.match(/[走跑冲抓推拉打踢砍刺握举甩砸踏扑闪滚]/g) || []).length;
    const dialogue = quotes >= 2;
    const action = verbs >= 4;
    let kind: StyleSampleKind = "other";
    if (dialogue) kind = "dialogue";
    else if (action) kind = "action";
    return { p, kind, score: quotes * 2 + verbs, dialogue, action };
  });

  // 只保留有特征的段落, 按分数降序取前 max 条
  const picked = scored
    .filter((s) => s.dialogue || s.action)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);

  let added = 0;
  for (const s of picked) {
    try {
      const id = addStyleSample({ text: s.p, kind: s.kind, genre: opts.genre || "", source: opts.source, rating: 3 });
      if (id) added++;
    } catch (e) {
      logInfo(`[style] 样本入库失败: ${(e as Error).message}`);
    }
  }
  return added;
}

/** 统计: 前端展示"样本库有多少、都什么类型" */
export function styleStats(): { total: number; byKind: Record<string, number>; byGenre: Record<string, number>; avgRating: number } {
  const d = getDb();
  const total = (d.prepare("SELECT COUNT(*) AS c FROM style_samples").get() as { c: number }).c;
  const rows = d.prepare("SELECT kind, genre, rating FROM style_samples").all() as Array<{ kind: string; genre: string; rating: number }>;
  const byKind: Record<string, number> = {};
  const byGenre: Record<string, number> = {};
  let sum = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    byGenre[r.genre || "(通用)"] = (byGenre[r.genre || "(通用)"] || 0) + 1;
    sum += r.rating;
  }
  return { total, byKind, byGenre, avgRating: total ? sum / total : 0 };
}

/** 删除单条样本 */
export function deleteStyleSample(id: string): boolean {
  return getDb().prepare("DELETE FROM style_samples WHERE id=?").run(id).changes > 0;
}

/** 列出样本 (前端管理界面用) */
export function listStyleSamples(limit = 50): StyleSample[] {
  return getDb()
    .prepare("SELECT * FROM style_samples ORDER BY rating DESC, updated_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(500, limit))) as StyleSample[];
}
