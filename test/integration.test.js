/**
 * cue-bank 集成测试（不依赖 dsh 服务器，用真实 cordis Context）
 *
 * 验证全链路：
 *   1. 写入侧：turn 结束 → 触点入库（关键词 + 惯用词）
 *   2. 唤醒侧：话题切换 → 扫描命中 → 组装唤醒上下文
 *   3. 同话题继续 → 不注入
 *
 * 运行：node test/integration.test.js
 */

import { Context } from '@deepseek-ai/cordis'
import { CueBankService } from '../src/index.js'

// ─── 模拟 agent（在真实 cordis ctx 上挂 systemPrompt 桩）───
function makeMockAgent(ctx, id) {
  const events = []
  const handlers = new Map()
  const agentCtx = {
    on: (name, fn) => {
      const list = handlers.get(name) || []
      list.push(fn)
      handlers.set(name, list)
      return () => {}
    },
    systemPrompt: {
      context: (c) => {
        agent._context = c
        return () => {}
      },
    },
    logger: { info: () => {} },
  }
  const agent = {
    id,
    ctx: agentCtx,
    session: { events, append: () => {} },
    _emitter: { emit: (name, payload) => (handlers.get(name) || []).forEach((fn) => fn(payload)) },
  }
  return agent
}

// ─── 辅助：往 agent session 塞一条消息 ───
function pushMessage(agent, type, text) {
  agent.session.events.push({
    type,
    seq: agent.session.events.length + 1,
    data: { message: { content: [{ type: 'text', text }] } },
  })
}

const results = []
function check(name, cond) {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}

const ctx = new Context()
const service = new CueBankService(ctx, {
  storageRoot: '/tmp/cuebank-int-test',
  matchMode: 'keyword', // 强制关键词模式（无网络依赖）
  topic: { switchDetection: true, switchThreshold: 0.25, scanEveryTurn: false },
  inject: { enabled: true, maxCues: 3, maxDetailChars: 400 },
  extract: { enabled: true, maxKeywordsPerTurn: 12, keywordMinLen: 2, userIdiomWindowTurns: 10 },
  dbg: true,
})

// ─── 场景 1：第一轮对话 → 建库 ───
const agent1 = makeMockAgent(ctx, 'feishu:ou_cue_test')
ctx.emit('agent/created', { agent: agent1 })

pushMessage(agent1, 'user/message', '我想做一个飞书插件，用来管理跨会话记忆，支持关键词和向量嵌入')
pushMessage(agent1, 'assistant/message', '好的，我们设计一个触点记忆库插件，包含写入侧和唤醒侧')
agent1._emitter.emit('agent/status', { agent: agent1, status: 'idle' })

await new Promise((r) => setTimeout(r, 100))

const storeDoc = service.store.getUser('ou_cue_test')
check('写入侧：触点已入库 (topics >= 1)', storeDoc.topics.length >= 1)
check('写入侧：包含对话级触点', storeDoc.topics.some((t) => t.level === 'conversation'))
check('写入侧：包含任务级触点', storeDoc.topics.some((t) => t.level === 'task'))
const allKw = storeDoc.topics.flatMap((t) => t.keywords.map((k) => k.word))
// 中文提取产出 2~4 字 gram，检查子串覆盖（"飞书插件" 覆盖 "飞书"）
const kwText = allKw.join(' ')
check('写入侧：关键词覆盖"飞书"/"插件"', kwText.includes('飞书') && kwText.includes('插件'))

// ─── 场景 2：新会话，话题切换 → 唤醒注入 ───
const agent2 = makeMockAgent(ctx, 'feishu:ou_cue_test') // 同一用户，跨会话
ctx.emit('agent/created', { agent: agent2 })

pushMessage(agent2, 'user/message', '飞书插件的事，我们继续讨论怎么落地')
const wakeText = await agent2._context.text({ agent: agent2 })
check('唤醒侧：话题切换触发注入', wakeText.length > 0)
check('唤醒侧：注入包含记忆唤醒标记', wakeText.includes('记忆唤醒'))
check('唤醒侧：注入包含历史摘要', wakeText.includes('飞书插件') || wakeText.includes('记忆'))
console.log('--- 注入示例 ---')
console.log(wakeText.slice(0, 300))
console.log('-----------------')

// ─── 场景 3：同话题继续 → 不注入 ───
pushMessage(agent2, 'user/message', '对，就是飞书插件继续聊')
const wakeText2 = await agent2._context.text({ agent: agent2 })
check('抑制侧：同话题继续不重复注入', wakeText2 === '')

// ─── 场景 4：完全无关话题 → 不命中 ───
const agent3 = makeMockAgent(ctx, 'feishu:ou_cue_test')
ctx.emit('agent/created', { agent: agent3 })
pushMessage(agent3, 'user/message', '今天天气怎么样，晚上吃什么')
const wakeText3 = await agent3._context.text({ agent: agent3 })
check('抑制侧：无关话题不注入', wakeText3 === '')

// ─── 场景 5：惯用词（第二类触点）───
const agent4 = makeMockAgent(ctx, 'feishu:ou_cue_test')
ctx.emit('agent/created', { agent: agent4 })
for (let i = 0; i < 4; i++) {
  pushMessage(agent4, 'user/message', '这个方案要落地，形成闭环，闭环很重要')
  pushMessage(agent4, 'assistant/message', '明白，落地和闭环')
  agent4._emitter.emit('agent/status', { agent: agent4, status: 'idle' })
  await new Promise((r) => setTimeout(r, 50))
}
const doc2 = service.store.getUser('ou_cue_test')
check('惯用词：检测到用户高频词', doc2.idiosyncrasies.length > 0)
console.log('惯用词:', doc2.idiosyncrasies.slice(0, 5).map((i) => i.word).join(' '))

// ─── 场景 6：惯用词参与唤醒（第二类触点闭环）───
// 新会话、不同话题，但用户消息含惯用词"闭环" → 注入应含「用户惯用词」提示
const agent5 = makeMockAgent(ctx, 'feishu:ou_cue_test')
ctx.emit('agent/created', { agent: agent5 })
pushMessage(agent5, 'user/message', '换个话题：新项目的排期要形成闭环')
const wakeText5 = await agent5._context.text({ agent: agent5 })
check('惯用词唤醒：话题切换触发注入', wakeText5.length > 0)
check('惯用词唤醒：注入包含「用户惯用词」提示', wakeText5.includes('用户惯用词'))
check('惯用词唤醒：提示包含"闭环"', wakeText5.includes('闭环'))
console.log('--- 惯用词唤醒注入示例 ---')
console.log(wakeText5.slice(0, 400))
console.log('--------------------------')

// ─── 汇总 ───
const failed = results.filter((r) => !r.pass)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
process.exit(failed.length === 0 ? 0 : 1)
