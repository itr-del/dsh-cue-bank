/**
 * cue-bank: 关键词提取模块
 *
 * 第一类事件触点：明确客观的词语，来源于对话文本。
 * - 任务级（task）：整个 session 的聚合高频词
 * - 对话级（conversation）：单轮对话的核心词
 * - 用户画像级（idiosyncrasy）：该用户惯用的词（相对停用词表的高频词）
 *
 * 分词策略（无外部依赖，穷举式 n-gram）：
 * - 中文：2~4 字滑窗 n-gram，过滤停用字
 * - 英文/数字/混合：按空白与标点切词
 * - 权重：TF（词频/总词数），保留 top-N
 */

const CJK_RE = /[\u4e00-\u9fff]/g

// 中文停用字（单字/常见虚词，避免无意义 n-gram 污染触点库）
const CJK_STOP = new Set(
  '的了是在我有和就不人都一个上也很到说要去你会着没有看好这那吧啊呢吗什么怎么我们你们他们自己这个那个时候现在可以还是因为所以但是如果就是只是觉得知道想需要应该已经正在开始继续完成进行使用通过作为对于关于按照根据采用提供支持帮助解决处理问题情况方式方法结果过程时间地方东西事情工作学习生活朋友家人孩子老师同学公司产品项目团队部门技术数据信息内容需求用户系统功能服务客户市场业务管理运营模式结构状态变化增加减少提高降低实现开发设计分析研究测试上线发布更新维护修改调整优化改进升级'
    .split('')
)

// 英文停用词
const EN_STOP = new Set(
  ('a an the and or but if then else of to in on for with without at by from as is are was were be been being do does did have has had will would can could should may might must not no yes you your yours we our ours they their them i me my mine he him his she her it its this that these those there here what which who whom when where why how all any both each few more most other some such only own same so than too very just about into over under again further once also because before after between during through above below up down out off until while of s t').split(/\s+/)
)

const PUNCT_RE = /[，。！？；：、,.!?;:'"()\[\]{}<>《》【】“”‘’\s\-–—…·/\\|&@#$%^*+=~`]+/g

/**
 * 从文本提取关键词（带权重）
 * @param {string} text 原始文本
 * @param {object} opts { maxKeywords, minLen }
 * @returns {Array<{word: string, score: number}>} 按权重降序
 */
export function extractKeywords(text, opts = {}) {
  const maxKeywords = opts.maxKeywords ?? 12
  const minLen = opts.minLen ?? 2
  if (!text || typeof text !== 'string') return []

  const freq = new Map() // word -> count
  let total = 0

  // 1) 中文 n-gram（长词优先：4字=1.0，3字=0.75，2字=0.5）
  const cjkMatches = text.match(/[\u4e00-\u9fff]{2,}/g) || []
  for (const run of cjkMatches) {
    const chars = run.split('')
    for (let len = 4; len >= 2; len--) {
      for (let i = 0; i + len <= chars.length; i++) {
        const gram = chars.slice(i, i + len).join('')
        // 过滤：全停用字 或 含 2+ 个停用字（如"我想构建"）
        const stopCount = [...gram].filter((c) => CJK_STOP.has(c)).length
        if (stopCount === len || stopCount >= 2) continue
        // 过滤首字/尾字是停用字（"的记忆"、"可以了"这类边界噪声）
        if (CJK_STOP.has(gram[0]) || CJK_STOP.has(gram[gram.length - 1])) continue
        const weight = len === 4 ? 1.0 : len === 3 ? 0.75 : 0.5
        freq.set(gram, (freq.get(gram) || 0) + weight)
        total += weight
      }
    }
  }

  // 2) 英文/数字/混合词
  const cleaned = text.replace(CJK_RE, ' ').replace(PUNCT_RE, ' ').toLowerCase()
  for (const word of cleaned.split(/\s+/)) {
    const w = word.trim()
    if (w.length < minLen) continue
    if (/^\d+$/.test(w) && w.length < 3) continue // 短数字无意义
    if (EN_STOP.has(w)) continue
    // 过滤 emoji / 纯符号 token（如 😊 📝，无信息量）
    if (!/[\p{L}\p{N}]/u.test(w)) continue
    freq.set(w, (freq.get(w) || 0) + 1)
    total++
  }

  if (total === 0) return []

  return [...freq.entries()]
    .map(([word, count]) => ({ word, score: count / total }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxKeywords)
}

/**
 * 合并两批关键词（用于任务级聚合：旧关键词 + 新关键词）
 * @returns {Array<{word: string, score: number}>}
 */
export function mergeKeywords(a = [], b = [], opts = {}) {
  const maxKeywords = opts.maxKeywords ?? 12
  const map = new Map()
  for (const k of [...a, ...b]) {
    if (!k || !k.word) continue
    map.set(k.word, (map.get(k.word) || 0) + k.score)
  }
  return [...map.entries()]
    .map(([word, score]) => ({ word, score }))
    .sort((x, y) => y.score - x.score)
    .slice(0, maxKeywords)
}

/**
 * 计算两个关键词集合的词面重合度（加权 Jaccard），用于话题切换检测
 * @param {Array<{word: string, score: number}>} a
 * @param {Array<{word: string, score: number}>} b
 * @returns {number} 0~1，越高越相似
 */
export function keywordOverlap(a = [], b = []) {
  if (!a.length || !b.length) return 0
  const setB = new Map(b.map((k) => [k.word, k.score]))
  let inter = 0
  let union = 0
  const seen = new Set()
  for (const k of a) {
    const sb = setB.get(k.word)
    inter += sb !== undefined ? Math.min(k.score, sb) : 0
    union += k.score
    seen.add(k.word)
  }
  for (const k of b) {
    if (!seen.has(k.word)) union += k.score
  }
  return union === 0 ? 0 : inter / union
}

/**
 * 用户惯用词提取：在较长的用户语料上统计高频词，
 * 保留"相对通用"的高频词（即用户个人化的用词偏好，第二类触点）
 * @param {string[]} userTexts 该用户近 N 轮的文本
 * @returns {Array<{word: string, score: number}>}
 */
export function extractIdiosyncrasies(userTexts, opts = {}) {
  const maxKeywords = opts.maxKeywords ?? 15
  const minLen = opts.minLen ?? 2
  const joined = (userTexts || []).filter(Boolean).join('\n')
  if (!joined) return []

  const all = extractKeywords(joined, { maxKeywords: 80, minLen })
  if (all.length === 0) return []

  // 词频归一化：出现在多段文本的词更可能是稳定用词习惯
  const docFreq = new Map()
  for (const t of userTexts) {
    const ks = extractKeywords(t, { maxKeywords: 40, minLen })
    for (const k of ks) docFreq.set(k.word, (docFreq.get(k.word) || 0) + 1)
  }
  return all
    .filter((k) => (docFreq.get(k.word) || 0) >= Math.max(1, Math.floor(userTexts.length * 0.4)))
    .slice(0, maxKeywords)
}
