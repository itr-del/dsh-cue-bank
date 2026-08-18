/**
 * cue-bank 向量嵌入模块单元测试（不发起真实网络请求）
 *
 * 覆盖：URL 规范化、available 判定、dimensions 推断、余弦相似度。
 * 运行：node test/embedding.test.js
 */

import { EmbeddingClient } from '../src/embedding.js'

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) {
    pass++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name}`)
  }
}

// ─── 构造 / URL 规范化 ───

const client = new EmbeddingClient({
  provider: 'openai-compatible',
  baseURL: 'https://api.siliconflow.cn/v1/',
  apiKeyEnv: 'SILICONFLOW_API_KEY',
  model: 'BAAI/bge-m3',
})
check('URL：去掉尾部斜杠', client.baseURL === 'https://api.siliconflow.cn/v1')
check('默认模型：BAAI/bge-m3', client.model === 'BAAI/bge-m3')
check('默认 env 名：SILICONFLOW_API_KEY', client.apiKeyEnv === 'SILICONFLOW_API_KEY')

// ─── available 判定 ───

const noKey = new EmbeddingClient({})
check('无 key：available=false', noKey.available === false)

const withEnv = new EmbeddingClient({})
process.env.SILICONFLOW_API_KEY = 'test-key-123'
check('有 env key：available=true', withEnv.available === true)
check('key() 返回 env 值', withEnv.key === 'test-key-123')
delete process.env.SILICONFLOW_API_KEY

const withCfgKey = new EmbeddingClient({ apiKey: 'cfg-key' })
check('有 config key：available=true', withCfgKey.available === true)

// ─── dimensions 推断 ───

check('dimensions：已知模型表推断', new EmbeddingClient({ model: 'BAAI/bge-large-zh-v1.5' }).dimensions === 1024)
check('dimensions：未知模型回退 1024', new EmbeddingClient({ model: 'unknown-model' }).dimensions === 1024)
check('dimensions：config 显式覆盖', new EmbeddingClient({ model: 'BAAI/bge-m3', dimensions: 512 }).dimensions === 512)

// ─── 余弦相似度 ───

check('cosine：相同向量 = 1', Math.abs(EmbeddingClient.cosine([1, 0], [1, 0]) - 1) < 1e-9)
check('cosine：正交向量 = 0', Math.abs(EmbeddingClient.cosine([1, 0], [0, 1])) < 1e-9)
check('cosine：相反向量 = -1', Math.abs(EmbeddingClient.cosine([1, 0], [-1, 0]) - -1) < 1e-9)
const sim = EmbeddingClient.cosine([1, 2, 3], [2, 4, 6])
check('cosine：平行向量 = 1（长度无关）', Math.abs(sim - 1) < 1e-9)
check('cosine：维度不等 → 0', EmbeddingClient.cosine([1, 2], [1, 2, 3]) === 0)
check('cosine：空向量 → 0', EmbeddingClient.cosine([], []) === 0)
const partial = EmbeddingClient.cosine([1, 0, 1], [1, 0, 0])
check('cosine：部分相似 ∈ (0,1)', partial > 0 && partial < 1)

// ─── embed 无 key 报错（不发起网络）───

let threw = false
try {
  await new EmbeddingClient({}).embed('anything')
} catch (e) {
  threw = /embedding unavailable/.test(e.message)
}
check('embed：无 key 抛错且不请求网络', threw)

// ─── 汇总 ───

console.log(`\n==== ${pass}/${pass + fail} 通过 ====`)
process.exit(fail === 0 ? 0 : 1)
