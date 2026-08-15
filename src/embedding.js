/**
 * cue-bank: 向量嵌入模块（可选）
 *
 * DeepSeek 官方 API 无 embedding 端点，因此向量模式走 OpenAI 兼容接口
 * （默认 SiliconFlow BAAI/bge-m3；可配置任意 OpenAI 兼容 provider）。
 * 无 API key 时自动降级为关键词穷举模式（matchMode: auto）。
 *
 * 成本量级（以 bge-m3 / SiliconFlow 为例，2026-08 行情）：
 *   - 每次唤醒：编码 1 条 query（~50 tokens）+ 全库向量余弦（本地 CPU）
 *   - bge-m3 约 ¥0.0005/千 tokens，单次唤醒嵌入成本 ≈ ¥0.000025（可忽略）
 *   - 库向量在写入时预计算并缓存，不重复计费
 */

const DIM_BY_MODEL = {
  'BAAI/bge-m3': 1024,
  'BAAI/bge-large-zh-v1.5': 1024,
  'BAAI/bge-small-zh-v1.5': 512,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
}

export class EmbeddingClient {
  /**
   * @param {object} config { provider, baseURL, apiKeyEnv, model, dimensions, timeoutMs }
   */
  constructor(config = {}) {
    this.config = config
    this.baseURL = (config.baseURL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
    this.model = config.model || 'BAAI/bge-m3'
    this.apiKeyEnv = config.apiKeyEnv || 'SILICONFLOW_API_KEY'
    this.timeoutMs = config.timeoutMs || 5000
  }

  /** 是否可用：环境变量里存在 API key */
  get available() {
    const key = this.config.apiKey || process.env[this.apiKeyEnv]
    return typeof key === 'string' && key.length > 0
  }

  get key() {
    return this.config.apiKey || process.env[this.apiKeyEnv] || ''
  }

  get dimensions() {
    return this.config.dimensions || DIM_BY_MODEL[this.model] || 1024
  }

  /**
   * 编码单个文本 → 向量数组
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    if (!this.available) throw new Error(`embedding unavailable: no ${this.apiKeyEnv} set`)
    const body = { model: this.model, input: text }
    if (this.config.dimensions) body.dimensions = this.config.dimensions

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseURL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`embedding api ${res.status}: ${errText.slice(0, 200)}`)
      }
      const data = await res.json()
      const vec = data?.data?.[0]?.embedding
      if (!Array.isArray(vec)) throw new Error('embedding api returned no vector')
      return vec
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 余弦相似度（归一化比较）
   * @param {number[]} a
   * @param {number[]} b
   */
  static cosine(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }
}
