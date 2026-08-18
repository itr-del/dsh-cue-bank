# dsh-cue-bank — 跨会话「事件触点记忆」插件

> 让 Agent 的记忆能力向人类靠拢：人脑可以在不同任务间随时切换，靠的是对事件建立**多维触点**（关键词、视角、触发物…），触点被当前情境激活后，从长期记忆快速拉取事件细节。本插件把这一机制在 dsh（DeepSeek Harness）上落地。

## 设计原理

```
人脑记忆模型                          本插件实现
─────────────────                    ─────────────────────────────
事件经历                              触点库中的 topic（带摘要+关键词+时间）
事件触点（关键词/视角/触发物）         topic.keywords + dimensions
情境激活触点 → 唤醒事件               用户新消息关键词 → 扫描触点库
话题切换 → 快速拉取细节                重合度低于阈值 → 注入记忆唤醒上下文
记忆渐进完善                          每次触碰更新 lastTouchedAt / 合并关键词
```

## 两层架构

```
┌─ 写入侧（建库，每轮 turn 结束时）─────────────────────┐
│ agent/status=idle → 读本 turn 文本                    │
│   ├─ 对话级触点：本轮关键词（2~4 字中文 gram + 英文词）│
│   ├─ 任务级触点：session 聚合关键词（合并更新）        │
│   └─ 用户惯用词：近 N 轮窗口的高频个人用词（第二类）    │
│ → upsert 进全局触点库（原子写 JSON）                   │
└───────────────────────────────────────────────────────┘
┌─ 唤醒侧（话题切换时，每步组装前）─────────────────────┐
│ systemPrompt.context() provider（同步契约）           │
│   → 提取新消息关键词 → 与上轮关键词算重合度           │
│   → 重合度 < 阈值 = 话题切换                          │
│   → 扫描触点库（关键词 TF 加权 / 向量余弦）           │
│   → 命中 top-N → 注入 <system-reminder> 记忆唤醒块    │
│   → 命中用户惯用词 → 追加「用户惯用词」提示行          │
└───────────────────────────────────────────────────────┘
```

## 关键设计决策

### 1. 动态组装注入（不污染持久历史）
使用 `systemPrompt.context()` 注册动态上下文：每次 prompt 组装时求值 provider，生成**带来源的 runtime-context 快照**，随请求发送但不写入持久 session 历史。话题不切换时不注入，保持上下文干净。这正是与 `agent-instructions`（持久注入）的关键区别。

### 2. 触发时机可配置
| 配置 | 默认 | 说明 |
|---|---|---|
| `topic.switchDetection` | `true` | 开启话题切换检测 |
| `topic.switchThreshold` | `0.25` | 关键词重合度低于此值视为切换（0~1） |
| `topic.scanEveryTurn` | `false` | 每轮都扫描（灵敏但开销大）；`false` 时只在切换时扫描 |

### 3. 匹配算法：双模式可配置
| 模式 | 成本/次唤醒 | 效果 | 适用 |
|---|---|---|---|
| `keyword`（TF 加权穷举） | 0（纯本地） | 词面重合准确，语义弱 | 无外部 key |
| `vector`（向量余弦） | ≈ ¥0.000025（见下） | 语义匹配强 | 有 embedding key |
| `auto`（默认） | — | 有 key 用向量，否则降级关键词 | 推荐 |

> ⚠️ **DeepSeek 官方 API 不提供 embedding 端点**（见 [issue #806](https://github.com/deepseek-ai/DeepSeek-V3/issues/806)），向量模式走 OpenAI 兼容接口（默认 SiliconFlow `BAAI/bge-m3`）。库向量在**写入时**预计算并缓存，唤醒时只编码 1 条 query，不重复计费。

**成本估算**（bge-m3 / SiliconFlow，2026-08 行情）：
- 单次唤醒：编码 query ~50 tokens ≈ **¥0.000025**（每 1 万次话题切换约 ¥0.25）
- 写入时：每轮 1 次嵌入（可忽略）
- 关键词模式：零外部成本

### 4. 通用插件（所有 agent 生效）
监听全局 `agent/created`，对每个 agent 挂载唤醒/写入钩子，不限于飞书。`userId` 从 session id 提取（`feishu:ou_xxx` → `ou_xxx`；其他 session 用完整 id），按用户分片存储。

### 5. 全局存储
触点库存于 **`$DSH_HOME/storages/cue-bank/users/<userId>.json`**（默认），跨 profile、跨会话共享；可用 `storageRoot` 覆盖。单用户触点上限 200 条（LRU 淘汰），惯用词上限 50 条。

## 安装

### 1. 一键安装（推荐）

```sh
dsh plugin --profile web add github:itr-del/dsh-cue-bank
```

安装器通过 package.json 的 `dsh.bundle` manifest 解析插件（`cordis.patch.yml`），挂载到指定 profile 后重启 dsh 即生效。

### 2. 手动挂载到 profile（可选）

在 profile 的 `package.json` 加依赖：
```json
"dependencies": {
  "@local/dsh-cue-bank": "file:/path/to/dsh-cue-bank"
}
```
在 profile 的 `cordis.patch.yml` 插入：
```yaml
- insert:
    - id: cue-bank
      name: '@local/dsh-cue-bank'
      config:
        storageRoot: ''
        matchMode: 'auto'
        embedding:
          provider: 'openai-compatible'
          baseURL: 'https://api.siliconflow.cn/v1'
          apiKeyEnv: 'SILICONFLOW_API_KEY'
          model: 'BAAI/bge-m3'
          dimensions: 1024
        topic:
          switchDetection: true
          switchThreshold: 0.25
          scanEveryTurn: false
        inject:
          enabled: true
          maxCues: 3
          maxDetailChars: 400
        dbg: false
```

### 3. 安装并重启
```sh
cd ~/.dsh/profiles/web && pnpm install
# 重启 dsh web 后生效（插件在启动时加载）
```

> 🔒 **隐私提示**：向量模式（`matchMode: auto` 且设置了 `SILICONFLOW_API_KEY`）会把对话文本编码后发送到 **https://api.siliconflow.cn/v1**（默认第三方 OpenAI 兼容端点）生成嵌入向量，用于库内语义匹配。写入时的库向量也会经该端点预计算。若需完全本地运行，请勿设置该 API key（自动降级为纯关键词本地匹配），或把 `embedding.baseURL` 改为自托管端点。

## 完整配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `storageRoot` | `''` | 空 = `$DSH_HOME/storages/cue-bank` |
| `matchMode` | `auto` | `auto` \| `keyword` \| `vector` |
| `embedding.baseURL` | `https://api.siliconflow.cn/v1` | OpenAI 兼容端点 |
| `embedding.apiKeyEnv` | `SILICONFLOW_API_KEY` | API key 环境变量名 |
| `embedding.model` | `BAAI/bge-m3` | 嵌入模型 |
| `embedding.dimensions` | `1024` | 向量维度 |
| `embedding.timeoutMs` | `5000` | 嵌入超时 |
| `topic.switchDetection` | `true` | 话题切换检测开关 |
| `topic.switchThreshold` | `0.25` | 切换阈值（关键词重合度） |
| `topic.scanEveryTurn` | `false` | 每轮扫描 |
| `topic.maxKeywords` | `10` | 每轮提取关键词数 |
| `inject.enabled` | `true` | 唤醒注入开关 |
| `inject.maxCues` | `3` | 最多注入几条记忆 |
| `inject.maxDetailChars` | `400` | 单条细节截断长度 |
| `extract.enabled` | `true` | 建库开关 |
| `extract.maxKeywordsPerTurn` | `12` | 每轮入库关键词数 |
| `extract.keywordMinLen` | `2` | 关键词最小长度 |
| `extract.userIdiomWindowTurns` | `10` | 惯用词统计窗口（轮） |
| `extract.maxIdiomHints` | `5` | 唤醒时最多提示几个惯用词 |
| `dbg` | `false` | 调试日志 |

## 数据模型

```jsonc
{
  "version": 1,
  "userId": "ou_xxx",
  "idiosyncrasies": [                      // 第二类触点：用户用词偏好
    { "word": "闭环", "score": 0.2, "firstSeen": "...", "lastSeen": "..." }
  ],
  "topics": [                              // 第一类触点：事件
    {
      "id": "t-...",
      "level": "task" | "conversation",
      "keywords": [ { "word": "飞书插件", "score": 0.035 } ],
      "summary": "对话: 讨论飞书插件…",
      "dimensions": { "trigger": "keywords", "perspective": "task" },
      "embedding": [0.1, 0.2, ...] | null, // 向量模式缓存
      "refSessions": ["feishu:ou_xxx"],
      "createdAt": "...", "lastTouchedAt": "...", "hitCount": 3
    }
  ]
}
```

## 唤醒注入示例（模型视角）

```
<system-reminder>
📌 记忆唤醒（cue-bank）: 检测到话题切换，以下为与该话题相关的历史记忆，可作为参考：
- [conversation] 对话: 我想做一个飞书插件，用来管理跨会话记忆…
  触点命中: 飞书插件、插件
  最近提及: 2026-08-15
  细节: 对话: 我想做一个飞书插件…
- [task] 任务: 我想做一个飞书插件…
用户惯用词: 形成闭环、闭环（用户习惯的表述，回复可顺应）
</system-reminder>
```

## 与 dsh 官方插件的对比（重复度调研）

> 调研日期：2026-08，基于 dsh-base 实际装配的插件清单逐一核验源码/README。

**结论：核心能力几乎不重复（估计重复度 10-15%），方向相反——官方是「被动查询」，cue-bank 是「自动记忆 + 主动唤醒」。**

| 官方插件（dsh-base 已装配） | 做什么 | 与 cue-bank 重复度 |
|---|---|---|
| `dsh-session-query` + `sqlite` | 会话历史 FTS5 全文检索、关系追踪（**被动查询 API**，需有人调用） | ⚠️ 低——管"查"，不管"自动记+自动唤醒" |
| `dsh-session-reference` | 显式 `@` 引用跨会话快照注入（**需用户主动提及**，dsh-base 默认未启用） | ⚠️ 低——被动触发 vs 话题切换主动触发 |
| `dsh-compaction(-basic)` | **同会话内** token 压力摘要压缩（管理当前窗口） | ✅ 无——不跨会话 |
| `dsh-agent-instructions` | AGENTS.md/CLAUDE.md **静态指令**文件加载 | ✅ 无——静态文件 |
| `dsh-spill` | 超大工具输出暂存+取回定位 | ✅ 无——存储优化 |

**cue-bank 独有能力（官方全部缺失）：**

1. **自动建库**：turn 结束自动提取任务级/对话级关键词 + 用户惯用词（官方只存原始日志，零自动提取）
2. **话题切换检测**：关键词重合度阈值触发唤醒（官方无此机制）
3. **自动注入**：`systemPrompt.context()` 动态组装，无需用户提及（官方 `session-reference` 必须显式 `@`）
4. **用户用词画像**：第二类触点（惯用词）官方完全没有
5. **结构化全局存储**：`$DSH_HOME/storages/cue-bank/`（官方是 SQLite/JSONL 原始日志）

**协同方向（可选，不影响当前设计）**：未来可用 `session-query` 的 FTS 作为 cue-bank 的补充召回通道——关键词穷举漏掉的记忆用全文搜索兜底，互补而非竞争。

## 测试

```sh
cd dsh-cue-bank && node test/integration.test.js   # 13/13 通过
```

覆盖：写入建库、话题切换唤醒、同话题抑制、无关话题抑制、惯用词提取、惯用词参与唤醒（第二类触点闭环）。

真实环境验证（headless profile，真实 dsh 进程）：插件加载无报错、turn 结束自动写入全局触点库（conversation+task 两级）、emoji 过滤生效。

### 向量模式离线验证（未配置真实 key）

用本地 mock OpenAI 兼容 embedding 服务器验证代码路径，**未调用任何真实 API**：

- ✅ API 调用契约（POST `/embeddings`、Bearer auth、OpenAI 兼容格式）
- ✅ 余弦相似度算法：相关文本 0.68 vs 无关文本 0.12，阈值 0.3 命中/不误报判定正确
- ✅ 无 key 时 `available=false` → `matchMode: auto` 自动降级 keyword
- ✅ 超时中止（AbortController）错误处理

启用向量模式只需设置 `SILICONFLOW_API_KEY` 环境变量（或配置 `embedding.apiKey`），无需改代码或配置。

## 后续演进方向

- [ ] 图片/文件触点（dimensions.trigger 已预留，需接入 attachment 解析）
- [ ] 闹钟/定时触点（dsh-schedule 联动）
- [ ] 向量模式本地化（bge-small 本地推理，零 API 成本）
- [ ] 触点衰减（久未触碰的触点降权）
- [ ] 记忆来源可追溯（点击注入块跳转原文）
