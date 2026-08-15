/**
 * dsh-cue-bank: 跨会话「事件触点记忆」插件
 *
 * 设计理念（对齐人脑记忆唤醒机制）：
 *   人脑记忆 = 事件 × 多维触点（关键词、视角、触发物…）
 *   触点被当前情境激活 → 从长期记忆拉取事件细节（渐进完善）
 *
 * 本插件把该机制落地为两层：
 *
 * ┌─ 写入侧（建库，turn 结束时）──────────────────────────┐
 * │  agent/status idle → 读取本 turn 的 user/assistant 文本 │
 * │  → 提取任务级关键词（聚合） + 对话级关键词（单轮）      │
 * │  → 提取该用户惯用词（第二类触点，按窗口聚合）           │
 * │  → upsert 进全局触点库（$DSH_HOME/storages/cue-bank）  │
 * └───────────────────────────────────────────────────────┘
 * ┌─ 唤醒侧（话题切换时，每步组装前）──────────────────────┐
 * │  systemPrompt.context() provider（同步契约，每次组装） │
 * │  → 取当前 user 文本 → 提取关键词                      │
 * │  → 与上一轮关键词算重合度 → 低于阈值 = 话题切换        │
 * │  → 扫描触点库（关键词 TF 加权，或读预取向量缓存余弦）  │
 * │  → 命中 top-N → 组装「记忆唤醒」上下文注入             │
 * │  （向量模式下 query 嵌入在 turn 开始时异步预取，        │
 * │     provider 同步读缓存；未就绪自动降级关键词）        │
 * └───────────────────────────────────────────────────────┘
 *
 * 配置见 package.json 的 dsh.plugin.defaultConfig / profile patch 覆盖。
 */

import { Service } from '@deepseek-ai/cordis'
import { extractKeywords, mergeKeywords, keywordOverlap, extractIdiosyncrasies } from './keywords.js'
import { EmbeddingClient } from './embedding.js'
import { CueBankStore } from './store.js'

const log = (ctx, ...args) => {
  const line = '[cue-bank] ' + args.join(' ')
  try { ctx?.logger?.info?.(line) } catch {}
}

export class CueBankService extends Service {
  // 依赖 agents 服务（agent 注册表）
  static inject = ['agents']

  constructor(ctx, config) {
    super(ctx, 'cue-bank')
    this.ctx = ctx
    this.cfg = config

    // 存储（全局 $DSH_HOME/storages/cue-bank）
    this.store = new CueBankStore(config.storageRoot)

    // 嵌入客户端（向量模式；DeepSeek 官方无 embedding，走 OpenAI 兼容）
    this.embedder = new EmbeddingClient(config.embedding || {})

    // 每个 agent 的运行时状态
    this.agentState = new Map() // agentId -> state

    // ─── 写入侧 + 预取：监听 agent 生命周期 ───
    ctx.on('agent/created', (event) => {
      const agent = event?.agent
      if (!agent) return
      this.attachAgent(agent)
    })

    log(this.ctx, `CueBankService initialized (matchMode=${this.resolveMode()}, storage=${this.store.root})`)
  }

  /** 当前生效的匹配模式：auto 时看 embedding 是否可用 */
  resolveMode() {
    const mode = this.cfg.matchMode || 'auto'
    if (mode === 'auto') return this.embedder.available ? 'vector' : 'keyword'
    return mode
  }

  /**
   * 给单个 agent 挂上：
   *   1. systemPrompt.context() — 唤醒注入（同步 provider，每步组装时求值）
   *   2. agent/status idle — 建库（turn 结束提取触点）
   *   3. agent/status running — 向量模式预取 query 嵌入（异步，写缓存）
   */
  attachAgent(agent) {
    const state = {
      lastKeywords: [],      // 上一轮关键词（话题切换检测）
      lastUserId: null,
      userTexts: [],         // 近 N 轮用户文本（惯用词窗口）
      lastScannedSeq: -1,    // 已处理的最后一条消息 seq
      taskKeywords: [],      // 任务级聚合关键词
      queryEmbedding: null,  // 向量模式：最新 user query 的嵌入缓存
      queryEmbeddingFor: '', // 缓存对应的文本指纹
    }
    this.agentState.set(agent.id, state)

    // ─── 唤醒侧：动态上下文注入（同步契约）───
    if (this.cfg.inject?.enabled !== false) {
      try {
        agent.ctx.systemPrompt.context({
          name: 'cue-bank:memory-wake',
          order: 400, // 工具引导（100-199）之后
          text: (assembleContext) => this.buildWakeContext(agent, assembleContext, state),
        })
      } catch (err) {
        log(this.ctx, `systemPrompt.context register failed for ${agent.id}: ${err.message}`)
      }
    }

    // ─── 写入侧：turn 结束建库 ───
    if (this.cfg.extract?.enabled !== false) {
      agent.ctx.on('agent/status', ({ agent: a, status }) => {
        if (status === 'idle') {
          this.extractFromTurn(a || agent).catch((err) => {
            log(this.ctx, `extractFromTurn failed: ${err.message}`)
          })
        } else if (status === 'running' && this.resolveMode() === 'vector' && this.embedder.available) {
          // 向量模式：异步预取最新 user query 的嵌入
          this.prefetchQueryEmbedding(a || agent, state).catch((err) => {
            log(this.ctx, `prefetchQueryEmbedding failed: ${err.message}`)
          })
        }
      })
    }

    // agent 销毁时清理
    agent.ctx.on('agent/disposed', () => {
      this.agentState.delete(agent.id)
    })
  }

  // ─────────────────────────────────────────────
  // 唤醒侧
  // ─────────────────────────────────────────────

  /**
   * 组装「记忆唤醒」上下文文本（同步！provider 契约）。
   * 返回空字符串 = 本次不注入。
   */
  buildWakeContext(agent, assembleContext, state) {
    try {
      if (!this.cfg.inject?.enabled) return ''

      // 拿当前要处理的 user 消息
      const userText = this.latestUserText(agent)
      if (!userText) return ''

      const kw = extractKeywords(userText, {
        maxKeywords: this.cfg.topic?.maxKeywords ?? 10,
        minLen: this.cfg.extract?.keywordMinLen ?? 2,
      })
      if (kw.length === 0) return ''

      // 话题切换检测：与上一轮关键词重合度低于阈值 = 切换
      const switchThreshold = this.cfg.topic?.switchThreshold ?? 0.25
      const scanEveryTurn = this.cfg.topic?.scanEveryTurn ?? false
      const overlap = keywordOverlap(state.lastKeywords, kw)
      const isSwitch = scanEveryTurn || overlap < switchThreshold

      if (!isSwitch) return ''
      state.lastKeywords = kw

      // 扫描触点库（同步）
      const userId = CueBankStore.userIdFromSession(agent.id)
      const cues = this.scanCues(userId, kw, state)
      if (cues.length === 0) return ''

      const maxCues = this.cfg.inject?.maxCues ?? 3
      const maxDetail = this.cfg.inject?.maxDetailChars ?? 400
      const parts = cues.slice(0, maxCues).map((c) => {
        this.store.recordHit(userId, c.topic.id)
        const hits = c.topic.keywords
          .filter((k) => kw.some((q) => q.word === k.word))
          .map((k) => k.word)
          .slice(0, 6)
        const detail = (c.topic.summary || '').slice(0, maxDetail)
        const seen = c.topic.lastTouchedAt?.slice(0, 10) || c.topic.createdAt?.slice(0, 10) || ''
        return (
          `- [${c.topic.level}] ${c.topic.summary || '(无摘要)'}` +
          (hits.length ? `\n  触点命中: ${hits.join('、')}` : '') +
          (seen ? `\n  最近提及: ${seen}` : '') +
          (detail ? `\n  细节: ${detail}` : '')
        )
      }).join('\n')

      if (!parts) return ''

      // 第二类触点：用户惯用词（命中用户消息关键词 → 提示 agent 顺应其用词偏好）
      const idiomHits = this.store.matchIdioms(userId, kw, this.cfg.extract?.maxIdiomHints ?? 5)
      const idiomLine = idiomHits.length
        ? `\n用户惯用词: ${idiomHits.join('、')}（用户习惯的表述，回复可顺应）`
        : ''

      // 组装格式参考 agent-instructions 的 system-reminder 框架
      return [
        '<system-reminder>',
        `📌 记忆唤醒（cue-bank）: 检测到话题切换，以下为与该话题相关的历史记忆，可作为参考：`,
        parts + idiomLine,
        '</system-reminder>',
      ].join('\n')
    } catch (err) {
      log(this.ctx, `buildWakeContext error: ${err.message}`)
      return ''
    }
  }

  /**
   * 同步扫描触点库，返回命中的触点（按匹配分降序）。
   * - keyword 模式：关键词 TF 加权穷举
   * - vector 模式：用 state.queryEmbedding 缓存做余弦（未就绪降级关键词）
   */
  scanCues(userId, queryKeywords, state) {
    const doc = this.store.getUser(userId)
    const topics = doc.topics || []
    if (topics.length === 0) return []

    const mode = this.resolveMode()
    const scored = []
    const queryText = queryKeywords.map((k) => k.word).join(' ')

    // 向量模式：query 嵌入缓存可用且指纹匹配 → 余弦
    if (mode === 'vector' && this.embedder.available) {
      const cached = state?.queryEmbedding
      if (Array.isArray(cached) && state.queryEmbeddingFor === queryText) {
        for (const t of topics) {
          if (!t.embedding || t.embedding.length === 0) continue
          const sim = EmbeddingClient.cosine(cached, t.embedding)
          if (sim > 0.3) scored.push({ topic: t, score: sim })
        }
        if (scored.length > 0) {
          return scored.sort((a, b) => b.score - a.score).slice(0, this.cfg.inject?.maxCues ?? 3)
        }
      }
      // 缓存未就绪 → 降级关键词
    }

    // 关键词 TF 加权穷举
    for (const t of topics) {
      let score = 0
      for (const q of queryKeywords) {
        const hit = t.keywords.find((k) => k.word === q.word)
        if (hit) score += q.score * (hit.score || 0.1) * 2
      }
      if (score > 0) scored.push({ topic: t, score })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, this.cfg.inject?.maxCues ?? 3)
  }

  /** 向量模式：turn 开始时异步编码最新 user query 并缓存（供同步 provider 读取） */
  async prefetchQueryEmbedding(agent, state) {
    const userText = this.latestUserText(agent)
    if (!userText) return
    const kw = extractKeywords(userText, {
      maxKeywords: this.cfg.topic?.maxKeywords ?? 10,
      minLen: this.cfg.extract?.keywordMinLen ?? 2,
    })
    if (kw.length === 0) return
    const queryText = kw.map((k) => k.word).join(' ')
    // 幂等：同一文本只编码一次
    if (state.queryEmbeddingFor === queryText && Array.isArray(state.queryEmbedding)) return
    const vec = await this.embedder.embed(queryText)
    state.queryEmbedding = vec
    state.queryEmbeddingFor = queryText
  }

  // ─────────────────────────────────────────────
  // 写入侧
  // ─────────────────────────────────────────────

  /** 从一轮已结束的 turn 提取触点并写入库 */
  async extractFromTurn(agent) {
    const state = this.agentState.get(agent.id)
    if (!state) return

    const userId = CueBankStore.userIdFromSession(agent.id)
    state.lastUserId = userId

    const events = agent.session?.events || []
    const fresh = events.filter((ev) => ev.seq > state.lastScannedSeq)
    if (fresh.length === 0) return
    state.lastScannedSeq = events[events.length - 1]?.seq ?? state.lastScannedSeq

    // 取本 turn 的用户文本与助手文本
    const userTexts = []
    const assistantTexts = []
    for (const ev of fresh) {
      if (ev.type === 'user/message') {
        const text = extractTextFromBlocks(ev.data?.message?.content)
        if (text) userTexts.push(text)
      } else if (ev.type === 'assistant/message') {
        const text = extractTextFromBlocks(ev.data?.message?.content)
        if (text) assistantTexts.push(text)
      }
    }

    const userJoined = userTexts.join(' ')
    const assistantJoined = assistantTexts.join(' ')
    if (!userJoined && !assistantJoined) return

    // 对话级关键词（本轮）
    const convKw = extractKeywords(`${userJoined} ${assistantJoined}`, {
      maxKeywords: this.cfg.extract?.maxKeywordsPerTurn ?? 12,
      minLen: this.cfg.extract?.keywordMinLen ?? 2,
    })

    // 任务级关键词（全 session 聚合）
    const taskKw = mergeKeywords(state.taskKeywords || [], convKw, {
      maxKeywords: this.cfg.extract?.maxKeywordsPerTurn ?? 12,
    })
    state.taskKeywords = taskKw

    // 用户惯用词（第二类触点）：维护近 N 轮窗口
    state.userTexts = [...state.userTexts, ...userTexts].slice(-(this.cfg.extract?.userIdiomWindowTurns ?? 10))
    const idioms = extractIdiosyncrasies(state.userTexts, {
      maxKeywords: 15,
      minLen: this.cfg.extract?.keywordMinLen ?? 2,
    })
    if (idioms.length > 0) {
      this.store.upsertIdiosyncrasies(userId, idioms)
    }

    // 摘要
    const summary = (userJoined || assistantJoined).slice(0, 80).replace(/\s+/g, ' ').trim()

    // 向量模式：为新触点预计算 embedding（写入时缓存，唤醒不重复计费）
    let embedding = null
    if (this.resolveMode() === 'vector' && this.embedder.available && convKw.length > 0) {
      try {
        embedding = await this.embedder.embed(convKw.map((k) => k.word).join(' '))
      } catch (err) {
        log(this.ctx, `embed on write failed: ${err.message}`)
      }
    }

    // 写入对话级触点
    if (convKw.length > 0) {
      this.store.upsertTopic({
        userId,
        level: 'conversation',
        keywords: convKw,
        summary: summary ? `对话: ${summary}` : '',
        dimensions: { trigger: 'keywords', perspective: 'conversation' },
        refSessionId: agent.id,
        embedding,
      })
    }

    // 写入任务级触点
    if (taskKw.length > 0) {
      this.store.upsertTopic({
        userId,
        level: 'task',
        keywords: taskKw,
        summary: `任务: ${summary}`,
        dimensions: { trigger: 'keywords', perspective: 'task' },
        refSessionId: agent.id,
        embedding: embedding || null,
      })
    }

    if (this.cfg.dbg) {
      log(this.ctx, `extracted for ${userId}: conv=${convKw.map((k) => k.word).join(',')} idioms=${idioms.map((i) => i.word).join(',')}`)
    }
  }

  // ─────────────────────────────────────────────
  // 辅助
  // ─────────────────────────────────────────────

  /** 取 agent 最新一条 user 消息文本（用于唤醒扫描） */
  latestUserText(agent) {
    const events = agent.session?.events || []
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.type === 'user/message') {
        const text = extractTextFromBlocks(ev.data?.message?.content)
        if (text) return text
      }
    }
    return ''
  }
}

function extractTextFromBlocks(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === 'text')
      .map((b) => b.text || '')
      .join(' ')
  }
  return ''
}

export default CueBankService
