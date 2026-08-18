/**
 * cue-bank 存储层单元测试（使用临时目录，无 dsh 依赖）
 *
 * 运行：node test/store.test.js
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CueBankStore } from '../src/store.js'

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

const root = mkdtempSync(join(tmpdir(), 'cue-bank-store-test-'))
const store = new CueBankStore(root)

// ─── userIdFromSession ───

check('userId：feishu:ou_xxx → ou_xxx', CueBankStore.userIdFromSession('feishu:ou_abc123') === 'ou_abc123')
check('userId：lark:u_yyy → u_yyy', CueBankStore.userIdFromSession('lark:u_yyy') === 'u_yyy')
check('userId：无前缀 → 原样', CueBankStore.userIdFromSession('plain-session') === 'plain-session')
check('userId：空 → unknown', CueBankStore.userIdFromSession('') === 'unknown')

// ─── upsertTopic / 持久化 ───

const t1 = store.upsertTopic({
  userId: 'ou_test',
  level: 'conversation',
  keywords: [{ word: '飞书', score: 0.5 }, { word: '插件', score: 0.5 }],
  summary: '讨论飞书插件方案',
  refSessionId: 'feishu:ou_test',
})
check('新增：返回 topic 带 id', !!t1.id && t1.id.startsWith('t-'))
check('新增：写入磁盘文件', existsSync(join(root, 'users', 'ou_test.json')))

// 持久化真实性：直接读文件验证
const onDisk = JSON.parse(readFileSync(join(root, 'users', 'ou_test.json'), 'utf8'))
check('持久化：version=1', onDisk.version === 1)
check('持久化：topics 含 1 条', onDisk.topics.length === 1)

// 合并：同 level 高重合 → 更新而非新增
const t2 = store.upsertTopic({
  userId: 'ou_test',
  level: 'conversation',
  keywords: [{ word: '飞书', score: 0.4 }, { word: '插件', score: 0.4 }, { word: '记忆', score: 0.3 }],
  summary: '继续讨论飞书插件，加入记忆功能',
  refSessionId: 'feishu:ou_test',
})
check('合并：同 topic 更新（id 不变）', t2.id === t1.id)
check('合并：关键词合并后含 "记忆"', t2.keywords.some((k) => k.word === '记忆'))

// 不同 level → 新 topic
const t3 = store.upsertTopic({
  userId: 'ou_test',
  level: 'task',
  keywords: [{ word: '飞书', score: 0.6 }],
  summary: '任务级：做飞书插件',
  refSessionId: 'feishu:ou_test',
})
check('分层：task 级新建 topic', t3.id !== t1.id && store.getUser('ou_test').topics.length === 2)

// ─── recordHit ───

store.recordHit('ou_test', t1.id)
const afterHit = store.getUser('ou_test').topics.find((t) => t.id === t1.id)
check('命中：hitCount 递增', afterHit.hitCount === 1)

// ─── upsertIdiosyncrasies / matchIdioms ───

store.upsertIdiosyncrasies('ou_test', [{ word: '闭环', score: 0.4 }, { word: '落地', score: 0.3 }])
const idioms = store.getUser('ou_test').idiosyncrasies
check('惯用词：入库 2 条', idioms.length === 2)

const hits = store.matchIdioms('ou_test', [{ word: '闭环' }, { word: '无关' }], 5)
check('惯用词匹配：命中 "闭环"', hits.includes('闭环'))
check('惯用词匹配：不命中无关词', !hits.includes('无关'))

// ─── 损坏文件容错 ───

const store2 = new CueBankStore(root)
// 手动破坏文件
const fs = await import('node:fs')
fs.writeFileSync(join(root, 'users', 'ou_corrupt.json'), '{not valid json')
const corrupt = store2.getUser('ou_corrupt')
check('容错：损坏 JSON 重建空库', corrupt.topics.length === 0 && corrupt.version === 1)

// ─── 清理 ───

rmSync(root, { recursive: true, force: true })
console.log(`\n==== ${pass}/${pass + fail} 通过 ====`)
process.exit(fail === 0 ? 0 : 1)
