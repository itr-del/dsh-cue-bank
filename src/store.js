/**
 * cue-bank: 触点库存储层
 *
 * 全局存储：$DSH_HOME/storages/cue-bank/（可被 storageRoot 配置覆盖）
 * 数据模型：
 *   cue-bank/
 *     users/
 *       <userId>.json        # 按用户分片的触点库
 *   （userId 从 session id 提取：feishu:ou_xxx → ou_xxx；web 会话 → session id）
 *
 * 单用户文件结构：
 * {
 *   "version": 1,
 *   "userId": "ou_xxx",
 *   "idiosyncrasies": [ { "word": "闭环", "score": 0.05, "firstSeen": "...", "lastSeen": "..." } ],
 *   "topics": [
 *     {
 *       "id": "t-<ts>-<n>",
 *       "level": "task" | "conversation",
 *       "keywords": [ { "word": "插件", "score": 0.12 } ],
 *       "summary": "一行摘要",
 *       "dimensions": { "trigger": "关键词/图片/闹钟", "perspective": "..." },
 *       "embedding": [0.1, 0.2, ...] | null,   // 向量模式缓存
 *       "refSessions": ["feishu:ou_xxx"],
 *       "createdAt": "...", "lastTouchedAt": "...", "hitCount": 0
 *     }
 *   ]
 * }
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const VERSION = 1

export function resolveStorageRoot(cfgRoot) {
  if (cfgRoot) return cfgRoot
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'storages', 'cue-bank')
}

export class CueBankStore {
  constructor(root) {
    this.root = resolveStorageRoot(root)
    this.usersDir = join(this.root, 'users')
    mkdirSync(this.usersDir, { recursive: true, mode: 0o700 })
    this._cache = new Map() // userId -> parsed object
  }

  /** 从 session id 提取稳定的 userId；通用插件对任意 agent 生效 */
  static userIdFromSession(sessionId) {
    if (!sessionId) return 'unknown'
    const s = String(sessionId)
    // feishu:<open_id> / lark:<id> → 取冒号后
    const m = s.match(/^[a-z]+:(.+)$/i)
    return m ? m[1] : s
  }

  _path(userId) {
    return join(this.usersDir, `${userId}.json`)
  }

  _load(userId) {
    if (this._cache.has(userId)) return this._cache.get(userId)
    const p = this._path(userId)
    let doc = null
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf8')
        doc = JSON.parse(raw)
      } catch {
        doc = null // 损坏文件 → 重建空库
      }
    }
    if (!doc || typeof doc !== 'object' || doc.version !== VERSION) {
      doc = { version: VERSION, userId, idiosyncrasies: [], topics: [] }
    }
    this._cache.set(userId, doc)
    return doc
  }

  _persist(userId) {
    const doc = this._load(userId)
    const p = this._path(userId)
    const tmp = `${p}.tmp-${randomUUID()}`
    writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
    renameSync(tmp, p) // 原子替换
  }

  /** 读取用户触点库（同步，内存权威） */
  getUser(userId) {
    return this._load(userId)
  }

  /**
   * 追加/更新一条话题触点
   * @param {object} opts { userId, level, keywords, summary, dimensions, refSessionId, embedding }
   * @returns {object} topic
   */
  upsertTopic(opts) {
    const userId = opts.userId || 'unknown'
    const doc = this._load(userId)
    const now = new Date().toISOString()

    // 找同 level 且关键词高度重合的旧触点 → 合并（避免穷举库膨胀）
    const existing = doc.topics.find(
      (t) =>
        t.level === opts.level &&
        overlapRatio(t.keywords, opts.keywords) >= 0.5
    )

    if (existing) {
      existing.keywords = mergeKeywordArrays(existing.keywords, opts.keywords)
      if (opts.summary && existing.summary !== opts.summary) {
        existing.summary = opts.summary.length > existing.summary.length ? opts.summary : existing.summary
      }
      existing.lastTouchedAt = now
      existing.hitCount = existing.hitCount || 0
      if (opts.embedding) existing.embedding = opts.embedding
      if (opts.refSessionId && !existing.refSessions.includes(opts.refSessionId)) {
        existing.refSessions.push(opts.refSessionId)
      }
      this._persist(userId)
      return existing
    }

    const topic = {
      id: `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      level: opts.level || 'conversation',
      keywords: opts.keywords || [],
      summary: opts.summary || '',
      dimensions: opts.dimensions || { trigger: 'keywords' },
      embedding: opts.embedding || null,
      refSessions: opts.refSessionId ? [opts.refSessionId] : [],
      createdAt: now,
      lastTouchedAt: now,
      hitCount: 0,
    }
    doc.topics.push(topic)
    // 控制单用户触点规模（默认上限 200，防止穷举无界膨胀）
    const cap = 200
    if (doc.topics.length > cap) {
      doc.topics.sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt))
      doc.topics.length = cap
    }
    this._persist(userId)
    return topic
  }

  /**
   * 更新用户惯用词（第二类触点：个人用词偏好）
   */
  upsertIdiosyncrasies(userId, words) {
    const doc = this._load(userId)
    const now = new Date().toISOString()
    const existingMap = new Map(doc.idiosyncrasies.map((w) => [w.word, w]))
    for (const w of words) {
      const prev = existingMap.get(w.word)
      if (prev) {
        prev.score = Math.max(prev.score, w.score)
        prev.lastSeen = now
      } else {
        existingMap.set(w.word, { word: w.word, score: w.score, firstSeen: now, lastSeen: now })
      }
    }
    // 只保留最近活跃的惯用词（top 50）
    doc.idiosyncrasies = [...existingMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
    this._persist(userId)
    return doc.idiosyncrasies
  }

  /** 记录一次命中 */
  recordHit(userId, topicId) {
    const doc = this._load(userId)
    const t = doc.topics.find((x) => x.id === topicId)
    if (t) {
      t.hitCount = (t.hitCount || 0) + 1
      t.lastTouchedAt = new Date().toISOString()
      this._persist(userId)
    }
  }

  /**
   * 匹配用户惯用词（第二类触点）：返回用户消息关键词中命中的惯用词列表
   * @param {string} userId
   * @param {Array<{word:string}>} queryKeywords 当前用户消息关键词
   * @param {number} max 返回上限
   * @returns {string[]}
   */
  matchIdioms(userId, queryKeywords, max = 5) {
    const doc = this._load(userId)
    if (!doc.idiosyncrasies?.length || !queryKeywords?.length) return []
    const idiomWords = new Set(doc.idiosyncrasies.map((i) => i.word))
    const hits = []
    for (const k of queryKeywords) {
      if (idiomWords.has(k.word) && !hits.includes(k.word)) hits.push(k.word)
      if (hits.length >= max) break
    }
    return hits
  }
}

function overlapRatio(a = [], b = []) {
  if (!a.length || !b.length) return 0
  const setB = new Set(b.map((k) => k.word))
  let hit = 0
  for (const k of a) if (setB.has(k.word)) hit++
  return hit / Math.max(a.length, b.length)
}

function mergeKeywordArrays(a = [], b = []) {
  const map = new Map()
  for (const k of [...a, ...b]) map.set(k.word, (map.get(k.word) || 0) + (k.score || 0))
  return [...map.entries()]
    .map(([word, score]) => ({ word, score }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 12)
}
