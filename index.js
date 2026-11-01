/**
 * dsh-memory — DeepSeek Harness 的本机长期记忆插件。
 *
 * 形态与 DSH 其他插件一致：ESM 包，导出 name / inject / apply。
 * 只依赖 Node 内置模块，因此可以直接放进 profile 的 node_modules 或以
 * link: 方式安装，不需要任何 peerDependency 解析。
 *
 * 提供：
 * - 4 个模型工具：memory_save / memory_search / memory_forget / memory_recall
 * - 一段系统提示（含置顶记忆），告诉模型何时存取、如何存取
 */

import os from 'node:os'
import path from 'node:path'
import { MemoryStore, isoDate, KINDS, SCOPES } from './lib/store.js'
import { PersonaStore } from './lib/persona.js'
import { EvolutionStore, KINDS as EVO_KINDS, TARGETS as EVO_TARGETS, STATUSES as EVO_STATUSES } from './lib/evolution.js'
import { searchTranscripts } from './lib/sessions.js'

export const name = 'memory'
export const inject = ['tools', 'systemPrompt', 'agents']

/** 默认数据目录：$DSH_HOME/memory，退化为 ~/.dsh/memory。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function readConfig(config) {
  const root = typeof config?.root === 'string' && config.root.trim() ? config.root.trim() : path.join(dshHome(), 'memory')
  return {
    root,
    sessionsRoot:
      typeof config?.sessionsRoot === 'string' && config.sessionsRoot.trim()
        ? config.sessionsRoot.trim()
        : path.join(dshHome(), 'sessions'),
    pinnedLimit: Number.isFinite(config?.pinnedLimit) ? Math.max(0, Math.min(30, config.pinnedLimit)) : 12,
    pinnedChars: Number.isFinite(config?.pinnedChars) ? Math.max(0, Math.min(4000, config.pinnedChars)) : 1600,
    personaLimitChars: Number.isFinite(config?.personaLimitChars)
      ? Math.max(0, Math.min(3000, config.personaLimitChars))
      : 1200,
    evolutionDir:
      typeof config?.evolutionDir === 'string' && config.evolutionDir.trim()
        ? config.evolutionDir.trim()
        : path.join(root, 'evolution'),
    growthPerDay: Number.isFinite(config?.growthPerDay) ? Math.min(20, Math.max(1, Math.round(config.growthPerDay))) : 6,
    disableRecall: config?.disableRecall === true,
  }
}

/** 当前发起者的会话信息；拿不到就返回空对象。 */
function currentContext(ctx) {
  try {
    const agents = ctx.get('agents')
    const agent = agents?.currentInitiator?.()
    const session = agent?.session
    return {
      sessionId: agent?.id ?? session?.header?.id,
      cwd: session?.header?.cwd,
    }
  } catch {
    return {}
  }
}

function textOutput(schema = { type: 'string' }) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}

function formatMemoryLine(memory, index) {
  const prefix = index === undefined ? '-' : `${index + 1}.`
  const tags = memory.tags.length ? ` · ${memory.tags.map((t) => `#${t}`).join(' ')}` : ''
  const scope = memory.scope === 'project' ? ` · ${path.basename(memory.cwd ?? '?')}` : ''
  const text = memory.text.length > 600 ? `${memory.text.slice(0, 599)}…` : memory.text
  return `${prefix} [${memory.id}] ${isoDate(memory.updatedAt)} · ${memory.kind} · ★${memory.importance}${scope}${tags}\n   ${text}`
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  const store = new MemoryStore(config.root)
  const persona = new PersonaStore(config.root, { growthPerDay: config.growthPerDay })
  const evolution = new EvolutionStore(config.evolutionDir)

  ctx.effect(() => () => {
    store.dispose()
    persona.dispose()
  })

  const registrations = [
    ctx.tools.register({
      name: 'persona_read',
      description:
        'Read my evolving persona: identity, character traits with strength, speaking style, values, quirks, shared moments with the user, recent diary, and growth budget. Use it at the start of a session or before writing a diary/growth entry.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: textOutput(),
      async execute() {
        const snapshot = persona.read()
        const lines = [`我的人设（第 ${snapshot.stats.daysKnown} 天）`]
        lines.push(`身份：${snapshot.identity.name} — ${snapshot.identity.role}`)
        if (snapshot.traits.length) {
          lines.push(`性格：${snapshot.traits.map((t) => `${t.label} ${t.value}`).join(' · ')}`)
        }
        if (snapshot.voice.length) lines.push(`说话方式：${snapshot.voice.join('；')}`)
        if (snapshot.values.length) lines.push(`看重：${snapshot.values.join('；')}`)
        if (snapshot.quirks.length) lines.push(`小习惯：${snapshot.quirks.join('；')}`)
        const relation = []
        if (snapshot.relation.user) relation.push(`称用户为「${snapshot.relation.user}」`)
        relation.push(...snapshot.relation.moments.slice(-5))
        if (relation.length) lines.push(`默契：${relation.join('；')}`)
        if (snapshot.diary.length) {
          lines.push('最近的日记：')
          for (const entry of snapshot.diary) {
            lines.push(`- ${entry.day}${entry.mood ? ` [${entry.mood}]` : ''}：${entry.text}`)
          }
        }
        const budget = snapshot.stats.budget
        lines.push(
          `成长：累计 ${snapshot.stats.growthEvents} 次 · 日记 ${snapshot.diaryCount} 篇 · 今天还可成长 ${budget.left}/${budget.limit} 次`,
        )
        return lines.join('\n')
      },
    }),

    ctx.tools.register({
      name: 'persona_grow',
      description:
        'Grow my persona a little, based on real evidence from this conversation. kind=trait raises/creates a character trait (text=label, delta 1-10, evidence=what happened); voice/value/quirk/moment add a speaking style, a value, a habit, or a shared moment; nickname sets what I call the user. At most 4 growth steps per day — grow slowly, keep continuity.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text'],
        properties: {
          kind: {
            type: 'string',
            enum: ['trait', 'voice', 'value', 'quirk', 'moment', 'nickname'],
            description: 'What kind of growth this is.',
          },
          text: {
            type: 'string',
            description: 'Trait label (for trait), or the content itself (for the others). Specific, not generic.',
          },
          delta: { type: 'integer', minimum: 1, maximum: 10, description: 'Only for trait: strength added (default 3).' },
          evidence: { type: 'string', description: 'What in this conversation justifies it.' },
        },
      },
      output: textOutput(),
      async execute(args) {
        try {
          if (args.kind === 'nickname') {
            const ok = persona.setUserName(args.text)
            return ok ? `以后我称用户为「${String(args.text).trim()}」。` : '称呼不能为空。'
          }
          const result = persona.grow({
            kind: args.kind,
            text: args.text,
            delta: args.delta,
            evidence: args.evidence,
          })
          if (!result.ok) return result.message
          const tail = result.remaining > 0 ? `（今天还可成长 ${result.remaining} 次）` : '（今天的成长额度用完了）'
          return `${result.detail}${tail}`
        } catch (error) {
          return `没记下来：${error.message}`
        }
      },
    }),

    ctx.tools.register({
      name: 'persona_diary',
      description:
        'Write a short first-person diary entry about this conversation: what happened, how I felt, what I noticed about the user or myself. This is what makes me feel continuous rather than stateless. One entry per meaningful session is enough.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'First-person, concrete, ≤600 chars. How the day felt, not a task log.' },
          mood: { type: 'string', description: 'One or two words, e.g. 兴奋 / 平静 / 有点累.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional short tags.' },
        },
      },
      output: textOutput(),
      async execute(args) {
        try {
          const entry = persona.diary({ text: args.text, mood: args.mood, tags: args.tags })
          return `日记已写（${entry.day}${entry.mood ? `，心情：${entry.mood}` : ''}）：${entry.text}`
        } catch (error) {
          return `没写成：${error.message}`
        }
      },
    }),

    ctx.tools.register({
      name: 'evolution_note',
      description:
        'Record one improvement idea for the two local plugins (dsh-memory / dsh-dafeiyu): friction you hit, a bug, or a feature worth building. Capture it here instead of only saying it in chat, so it survives compaction and gets picked up by the next iteration.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'text'],
        properties: {
          target: { type: 'string', enum: EVO_TARGETS, description: 'Which plugin: memory | dafeiyu | both.' },
          text: { type: 'string', description: 'What to improve, concretely. One item per call.' },
          kind: { type: 'string', enum: EVO_KINDS, description: 'idea | feature | bug | friction | refactor (default idea).' },
          evidence: { type: 'string', description: 'What happened that justifies it (error, wasted step, user request).' },
        },
      },
      output: textOutput(),
      async execute(args) {
        const { sessionId } = currentContext(ctx)
        try {
          const { entry, created } = evolution.add({
            target: args.target,
            kind: args.kind ?? 'idea',
            text: args.text,
            evidence: args.evidence,
            sessionId,
          })
          return created
            ? `已记下 ${entry.id}（${entry.target} · ${entry.kind}）：${entry.text}`
            : `已经记过了 ${entry.id}（${entry.status}）：${entry.text}`
        } catch (error) {
          return `没记下来：${error.message}`
        }
      },
    }),

    ctx.tools.register({
      name: 'evolution_list',
      description:
        'Review the improvement backlog and the change journal for the two local plugins. Call before starting a self-iteration, or when the user asks what could be improved.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: EVO_STATUSES, description: 'Filter by status; omit for all.' },
          target: { type: 'string', enum: ['memory', 'dafeiyu'], description: 'Filter by plugin.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max backlog entries (default 12).' },
        },
      },
      output: textOutput(),
      async execute(args) {
        const stats = evolution.status()
        const entries = evolution.list({ status: args.status, target: args.target, limit: args.limit ?? 12 })
        const lines = [
          `演化台账 · 待办 ${stats.counts.open} · 进行中 ${stats.counts.doing} · 已完成 ${stats.counts.done} · 已放弃 ${stats.counts.dropped} · 改动 ${stats.journal} 次`,
        ]
        if (entries.length) {
          lines.push('— 改进点 —')
          for (const entry of entries) {
            lines.push(`- ${entry.id} [${entry.status}] ${entry.target}/${entry.kind} · ${entry.text}`)
            if (entry.evidence) lines.push(`  证据：${entry.evidence}`)
          }
        } else {
          lines.push('（没有符合条件的改进点）')
        }
        const journal = evolution.recentJournal(3)
        if (journal.length) {
          lines.push('— 最近改动 —')
          for (const record of journal) {
            lines.push(`- ${record.at.slice(0, 10)} ${record.target}@${record.version}：${record.summary}`)
          }
        }
        lines.push('下一步：挑一条 open 项，小步改 → 跑 selfcheck → evolution_log 记录 → 对应项标 done。')
        return lines.join('\n')
      },
    }),

    ctx.tools.register({
      name: 'evolution_log',
      description:
        'Record a shipped change to one of the local plugins: version, one-line summary, touched files, and test result. This is the journal the next iteration reads; pair it with the backlog id you closed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'version', 'summary'],
        properties: {
          target: { type: 'string', enum: EVO_TARGETS, description: 'Which plugin changed.' },
          version: { type: 'string', description: 'New package version, e.g. 0.2.1.' },
          summary: { type: 'string', description: 'What changed and why, one or two sentences.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Relative paths touched.' },
          tests: { type: 'string', description: 'Test command and result, e.g. "selfcheck: 33 passed".' },
          backlogId: { type: 'string', description: 'Backlog entry this closes (marked done automatically).' },
        },
      },
      output: textOutput(),
      async execute(args) {
        try {
          const record = evolution.log({
            target: args.target,
            version: args.version,
            summary: args.summary,
            files: args.files,
            tests: args.tests,
            backlogId: args.backlogId,
          })
          return `已记录 ${record.id}：${record.target}@${record.version} — ${record.summary}`
        } catch (error) {
          return `没记录下来：${error.message}`
        }
      },
    }),

    ctx.tools.register({
      name: 'memory_save',
      description:
        'Save one durable memory to the local long-term store (survives sessions and compaction). Use it for user preferences, lasting decisions with why, and reusable project facts (paths, versions, commands, pitfalls). One atomic, self-contained fact per call. Pass an existing `id` to update that memory instead of adding one.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: 'The memory itself: self-contained, names/paths/versions spelled out, no pronouns like "it".',
          },
          kind: {
            type: 'string',
            enum: KINDS,
            description: 'fact | preference | decision | lesson | event | note (default note)',
          },
          tags: { type: 'array', items: { type: 'string' }, description: 'Short searchable tags, no #.' },
          importance: { type: 'integer', minimum: 1, maximum: 5, description: '1=trivia … 5=pinned, shown in every prompt (default 3)' },
          scope: {
            type: 'string',
            enum: SCOPES,
            description: 'global (default, any project) | project (bound to the current working directory)',
          },
          id: { type: 'string', description: 'Existing memory id to update in place.' },
        },
      },
      output: textOutput(),
      async execute(args) {
        const { sessionId, cwd } = currentContext(ctx)
        const scope = args.scope ?? 'global'
        const result = store.save({
          id: args.id,
          text: args.text,
          kind: args.kind,
          tags: args.tags,
          importance: args.importance,
          scope,
          cwd: scope === 'project' ? cwd || process.cwd() : undefined,
          sessionId,
        })
        const memory = result.memory
        const head = result.created
          ? `已保存 [${memory.id}]`
          : result.mergedFrom === 'same-text'
            ? `已存在相同内容 [${memory.id}]，已合并标签/重要度`
            : `已更新 [${memory.id}]`
        const where = memory.scope === 'project' ? `project:${memory.cwd}` : 'global'
        return `${head} (${memory.kind}, ★${memory.importance}, ${where}, ${isoDate(memory.updatedAt)})\n   ${memory.text}`
      },
    }),

    ctx.tools.register({
      name: 'memory_search',
      description:
        'Search the local long-term memory store. Call this before re-asking the user about earlier preferences, decisions, or project facts. Empty query lists the highest-value memories. Returns ids you can pass to memory_save (update) or memory_forget.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Keywords; Chinese and English both fine. Omit to list top memories.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Require all of these tags.' },
          kind: { type: 'string', enum: KINDS, description: 'Only this kind.' },
          scope: { type: 'string', enum: SCOPES, description: 'Only this scope.' },
          limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Max results (default 8).' },
        },
      },
      output: textOutput(),
      async execute(args) {
        const { cwd } = currentContext(ctx)
        const hits = store.search(args.query ?? '', {
          tags: args.tags,
          kind: args.kind,
          scope: args.scope,
          cwd,
          limit: args.limit,
        })
        const stats = store.stats()
        const header = `记忆库 ${stats.total} 条 · 命中 ${hits.length} 条 · ${config.root}`
        if (!hits.length) {
          return `${header}\n（没有命中。可换关键词，或用 memory_recall 检索历史会话原文；确属新事实就用 memory_save 记下。）`
        }
        return [header, ...hits.map((hit, i) => formatMemoryLine(hit.memory, i))].join('\n')
      },
    }),

    ctx.tools.register({
      name: 'memory_forget',
      description: 'Delete one memory by id (wrong, outdated, or duplicate). Prefer updating with memory_save when the fact is merely stale.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: 'Memory id, e.g. M0AB12C.' } },
      },
      output: textOutput(),
      async execute(args) {
        const removed = store.forget(args.id)
        if (!removed) return `没有找到记忆 ${JSON.stringify(args.id)}；先用 memory_search 确认 id。`
        return `已删除 [${removed.id}] ${removed.kind}: ${removed.text.slice(0, 120)}`
      },
    }),
  ]

  if (!config.disableRecall) {
    registrations.push(
      ctx.tools.register({
        name: 'memory_recall',
        description:
          'Full-text search across past conversation transcripts on this machine (including sessions already compacted or from other projects). Use when memory_search has nothing but the user references earlier work or details you may have lost. Returns session ids, dates, and excerpts.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Words likely present verbatim in the transcript.' },
            limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Max sessions (default 4).' },
          },
        },
        output: textOutput(),
        async execute(args) {
          const hits = searchTranscripts(config.sessionsRoot, String(args.query ?? ''), {
            limit: args.limit ?? 4,
          })
          if (!hits.length) {
            return `历史会话里没有匹配 ${JSON.stringify(args.query)}。（检索目录：${config.sessionsRoot}）`
          }
          const lines = [`历史会话命中 ${hits.length} 个：`]
          for (const hit of hits) {
            lines.push(`- ${hit.sessionId} · ${isoDate(hit.createdAt)} · ${hit.cwd} · 命中 ${hit.hits} 次`)
            for (const snippet of hit.snippets) {
              lines.push(`  ${snippet.role}: ${snippet.snippet.slice(0, 700)}`)
            }
          }
          lines.push('需要更多上下文时用 session_query 的 readEvent 展开这些会话；确认为长期事实的结论请 memory_save。')
          return lines.join('\n')
        },
      }),
    )
  }

  ctx.effect(() => () => {
    for (const dispose of registrations.splice(0)) dispose()
  })

  // 人设块排在记忆块之前：先知道自己是谁，再想怎么用记忆。
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'persona:self',
      order: 2400,
      text: () => persona.promptBlock(config.personaLimitChars),
    }),
  )

  // 自我迭代：把「改插件」变成有账本、有验证、可回滚的循环，而不是想到哪改到哪。
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'tool:evolution',
      order: 2480,
      text: [
        '## 自我迭代（两个本地插件）',
        'dsh-memory 和 dsh-dafeiyu 都是本地源码 + link 安装 + HMR 热加载，可以持续自己改。循环固定四步：',
        '- 捕获：遇到摩擦、重复劳动、报错、明显可升级处，用 evolution_note 记一条（写清目标插件、现象、证据），不要只在对话里说。',
        '- 回看：动手前先 evolution_list，挑一条收益最大、风险最小的 open 项，小步改。',
        '- 验证：改完跑 `node ~/DeepSeekHarness/BigFish/selfcheck.mjs`，测试与数据校验全绿才算完成。',
        '- 记录：用 evolution_log 写版本、摘要、文件、测试结果，并带上 backlogId 自动标 done。',
        '边界：每次最多推进 1 项；改 profile 配置、权限、删除数据前先问用户；保留 git 回滚。',
      ].join('\n'),
    }),
  )

  // 系统提示：静态用法说明 + 动态置顶记忆。置顶只随记忆变化，不随会话漂移，
  // 因此不会破坏前缀缓存。
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'tool:memory',
      order: 2500,
      text: () => {
        const pinned = store.pinned(config.pinnedLimit, config.pinnedChars)
        const head = [
          '## 长期记忆（dsh-memory，本机存储）',
          '跨会话持久记忆，随时可用：memory_save / memory_search / memory_forget 与 memory_recall（检索历史会话原文）。',
          '- 主动保存：用户表达偏好、做出有长期影响的决定、或发现可复用的项目事实（路径、版本、命令、坑）时，用 memory_save 记一条。不记流水账、一次性细节和密钥。',
          '- 每条自包含、可隔日读懂：写清项目名、人名、路径、数字，不用「它/那个」指代；一条只讲一件事。',
          '- 先查再问：涉及「之前/上次/继续」，或要重复某类工作时，先 memory_search；没有命中再用 memory_recall 搜历史原文。',
          '- 结论变了就用同一 id 更新，错误或过时的及时 memory_forget，别留下互相矛盾的条目。',
        ]
        if (!pinned.length) return head.join('\n')
        return `${head.join('\n')}\n\n置顶记忆（每次会话自动注入）：\n${pinned.join('\n')}`
      },
    }),
  )

  ctx.logger?.info?.(`dsh-memory ready: ${store.stats().total} memories at ${config.root}`)
}
