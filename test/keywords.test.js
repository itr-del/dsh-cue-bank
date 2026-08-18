/**
 * cue-bank 关键词模块单元测试（无网络、无 dsh 依赖）
 *
 * 运行：node test/keywords.test.js
 */

import { extractKeywords, mergeKeywords, keywordOverlap, extractIdiosyncrasies } from '../src/keywords.js'

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

// ─── extractKeywords ───

// 1. 中文 2~4 字 n-gram 提取，排除停用字边界噪声
const zh = extractKeywords('我想构建一个飞书插件来管理跨会话记忆', { maxKeywords: 12, minLen: 2 })
const zhWords = zh.map((k) => k.word)
check('中文：提取出 "飞书"', zhWords.includes('飞书'))
check('中文：提取出 "插件"', zhWords.includes('插件'))
check('中文：提取出 "记忆" 或 "会话"', zhWords.some((w) => w.includes('记忆') || w.includes('会话')))
check('中文：不含纯停用字噪声 "我想" 的首字边界', !zhWords.includes('我想'))
check('中文：结果按 score 降序', zh.every((k, i) => i === 0 || zh[i - 1].score >= k.score))
check('中文：不超过 maxKeywords', zh.length <= 12)

// 2. 英文 / 数字 / 混合
const en = extractKeywords('Let us build a feishu plugin with keyword matching', { maxKeywords: 12, minLen: 2 })
const enWords = en.map((k) => k.word)
check('英文：提取出 feishu', enWords.includes('feishu'))
check('英文：提取出 plugin', enWords.includes('plugin'))
check('英文：过滤停用词 a/the/with', !enWords.includes('a') && !enWords.includes('the') && !enWords.includes('with'))

// 3. 空输入 / 非字符串
check('空输入返回 []', extractKeywords('').length === 0)
check('null 返回 []', extractKeywords(null).length === 0)
check('undefined 返回 []', extractKeywords(undefined).length === 0)

// 4. emoji 与纯符号过滤
const emoji = extractKeywords('这个方案太棒了 👍🎉 我们要闭环 📝', { maxKeywords: 12, minLen: 2 })
check('emoji 过滤：结果不含纯 emoji token', emoji.every((k) => /[\p{L}\p{N}]/u.test(k.word)))

// ─── mergeKeywords ───

const merged = mergeKeywords(
  [{ word: '飞书', score: 0.3 }, { word: '插件', score: 0.2 }],
  [{ word: '飞书', score: 0.1 }, { word: '记忆', score: 0.4 }],
  { maxKeywords: 12 }
)
const mergedMap = new Map(merged.map((k) => [k.word, k.score]))
check('合并：同名关键词分数相加', Math.abs(mergedMap.get('飞书') - 0.4) < 1e-9)
check('合并：包含两边的独有词', mergedMap.has('插件') && mergedMap.has('记忆'))
check('合并：按总分降序', merged.every((k, i) => i === 0 || merged[i - 1].score >= k.score))

// ─── keywordOverlap ───

check('重叠：相同集合 = 1', keywordOverlap([{ word: 'a', score: 1 }], [{ word: 'a', score: 1 }]) === 1)
check('重叠：无交集 = 0', keywordOverlap([{ word: 'a', score: 1 }], [{ word: 'b', score: 1 }]) === 0)
check('重叠：空集合 = 0', keywordOverlap([], [{ word: 'b', score: 1 }]) === 0)
const partial = keywordOverlap(
  [{ word: '飞书', score: 0.5 }, { word: '插件', score: 0.5 }],
  [{ word: '飞书', score: 0.5 }, { word: '记忆', score: 0.5 }]
)
check('重叠：部分重合 ∈ (0,1)', partial > 0 && partial < 1)

// ─── extractIdiosyncrasies ───

const texts = Array(5).fill('这个方案要落地，形成闭环，闭环很重要，闭环必须')
const idioms = extractIdiosyncrasies(texts, { maxKeywords: 15, minLen: 2 })
const idiomWords = idioms.map((i) => i.word)
check('惯用词：提取出高频 "闭环"', idiomWords.includes('闭环'))
check('惯用词：结果非空', idioms.length > 0)

// ─── 汇总 ───

console.log(`\n==== ${pass}/${pass + fail} 通过 ====`)
process.exit(fail === 0 ? 0 : 1)
