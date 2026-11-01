/**
 * dsh-memory 的持久化与检索层。
 *
 * 设计取舍：
 * - 纯 Node 内置模块，零依赖；插件随 DSH 进程加载，任何第三方依赖都会带来
 *   版本/解析风险，因此这里只用 node:fs / node:path。
 * - 单文件 JSON 快照（memories.json），写时 tmp + rename 原子替换。个人记忆量
 *   在数千条以内，全量内存 + 全量落盘足够快，也方便用户直接 cat 查看/备份。
 * - 检索用轻量 BM25 变体 + 重要性/新鲜度/作用域加权；中文按 bigram 切分，
 *   英文按词切分，不引入分词库。
 */

import fs from 'node:fs'
import path from 'node:path'

export const KINDS = ['fact', 'preference', 'decision', 'lesson', 'event', 'note']
export const SCOPES = ['global', 'project']

const FILE_VERSION = 1
const MAX_TEXT = 4000
const MAX_TAGS = 12

/** 稳定的本地日期（YYYY-MM-DD），用于输出。 */
export function isoDate(ms) {
  if (!ms) return '????-??-??'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 中英混合分词：拉丁词按下划线/数字切分，中文按连续字串的 bigram 切分。
 * 单字中文保留为单 token，保证「鱼」这类查询也能命中。
 */
export function tokenize(input) {
  const text = String(input ?? '').toLowerCase()
  const tokens = []
  for (const word of text.match(/[a-z0-9_]+/g) ?? []) tokens.push(word)
  for (const run of text.replace(/[^\u3400-\u9fff]+/g, ' ').split(/\s+/)) {
    if (!run) continue
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

/** 规范化文本，用于查重。 */
export function normalizeText(input) {
  return String(input ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function createId(existing) {
  for (;;) {
    const id = `M${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase()
    if (!existing.has(id)) return id
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : tags ? [tags] : []
  const out = []
  for (const tag of list) {
    const value = String(tag ?? '').trim().replace(/^#/, '').slice(0, 32)
    if (value && !out.includes(value)) out.push(value)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/**
 * 一条记忆。字段刻意保持扁平、自解释，方便人直接读写 JSON。
 * @typedef {object} Memory
 * @property {string} id
 * @property {string} text
 * @property {string} kind
 * @property {string[]} tags
 * @property {number} importance 1..5
 * @property {'global'|'project'} scope
 * @property {string} [cwd] scope=project 时的项目目录
 * @property {string} [sessionId] 写入时所在会话
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} uses 被检索命中次数
 * @property {number} [lastUsedAt]
 */
export class MemoryStore {
  /** @param {string} root 数据目录 */
  constructor(root) {
    this.root = root
    this.file = path.join(root, 'memories.json')
    /** @type {Memory[]} */
    this.memories = []
    this.byId = new Map()
    this.dirty = false
    this.saveTimer = null
    this.loadError = undefined
    this.load()
  }

  load() {
    fs.mkdirSync(this.root, { recursive: true })
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadError = error
      return
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : parsed?.memories
      if (!Array.isArray(list)) throw new Error('memories.json 缺少 memories 数组')
      for (const item of list) {
        const memory = this.sanitize(item, true)
        if (memory) this.index(memory)
      }
    } catch (error) {
      this.loadError = error
      // 损坏的文件不覆盖：留一份 .corrupt 副本，随后从空库开始。
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {}
    }
  }

  /** 校验并补齐字段；loose=true 时用于载入（跳过内容必填检查失败的行）。 */
  sanitize(input, loose = false) {
    const text = String(input?.text ?? '').trim()
    if (!text || text.length > MAX_TEXT) {
      if (loose) return undefined
      throw new Error(`memory text 必须非空且不超过 ${MAX_TEXT} 字符`)
    }
    const kind = KINDS.includes(input?.kind) ? input.kind : 'note'
    const scope = SCOPES.includes(input?.scope) ? input.scope : 'global'
    const now = Date.now()
    return {
      id: typeof input?.id === 'string' && input.id.trim() ? input.id.trim().slice(0, 32) : '',
      text,
      kind,
      tags: cleanTags(input?.tags),
      importance: clampInt(input?.importance, 1, 5, 3),
      scope,
      ...(scope === 'project' && typeof input?.cwd === 'string' && input.cwd ? { cwd: input.cwd } : {}),
      ...(typeof input?.sessionId === 'string' && input.sessionId ? { sessionId: input.sessionId } : {}),
      createdAt: Number.isFinite(input?.createdAt) ? input.createdAt : now,
      updatedAt: Number.isFinite(input?.updatedAt) ? input.updatedAt : now,
      uses: Number.isFinite(input?.uses) ? Math.max(0, input.uses) : 0,
      ...(Number.isFinite(input?.lastUsedAt) ? { lastUsedAt: input.lastUsedAt } : {}),
    }
  }

  index(memory) {
    this.memories.push(memory)
    this.byId.set(memory.id, memory)
  }

  /**
   * 新增或按 id 更新一条记忆。
   * @param {object} input
   * @returns {{memory: Memory, created: boolean, mergedFrom?: string}}
   */
  save(input) {
    const now = Date.now()
    const incoming = this.sanitize({ ...input, createdAt: now, updatedAt: now })

    const existingById = incoming.id ? this.byId.get(incoming.id) : undefined
    const existingByText = this.memories.find((m) => normalizeText(m.text) === normalizeText(incoming.text))

    if (existingById) {
      Object.assign(existingById, {
        text: incoming.text,
        kind: incoming.kind,
        tags: incoming.tags.length ? incoming.tags : existingById.tags,
        importance: input.importance == null ? existingById.importance : incoming.importance,
        scope: input.scope == null ? existingById.scope : incoming.scope,
        ...(input.cwd === undefined ? {} : { cwd: incoming.cwd }),
        updatedAt: now,
      })
      if (existingById.scope === 'global') delete existingById.cwd
      this.markDirty()
      return { memory: existingById, created: false }
    }

    if (existingByText) {
      // 内容完全相同：只提升重要度和标签，避免重复条目。
      existingByText.importance = Math.max(existingByText.importance, incoming.importance)
      existingByText.tags = cleanTags([...existingByText.tags, ...incoming.tags])
      existingByText.updatedAt = now
      this.markDirty()
      return { memory: existingByText, created: false, mergedFrom: 'same-text' }
    }

    const memory = { ...incoming, id: createId(this.byId) }
    this.index(memory)
    this.markDirty()
    return { memory, created: true }
  }

  forget(id) {
    const memory = this.byId.get(String(id ?? '').trim())
    if (!memory) return undefined
    this.memories = this.memories.filter((m) => m !== memory)
    this.byId.delete(memory.id)
    this.markDirty()
    return memory
  }

  get(id) {
    return this.byId.get(String(id ?? '').trim())
  }

  /**
   * BM25 变体检索。
   * @param {string} query
   * @param {{kind?: string, scope?: string, tags?: string[], cwd?: string, limit?: number}} [options]
   */
  search(query, options = {}) {
    const limit = clampInt(options.limit, 1, 30, 8)
    const terms = [...new Set(tokenize(query))]
    const filterTags = cleanTags(options.tags)

    const candidates = this.memories.filter((m) => {
      if (options.kind && m.kind !== options.kind) return false
      if (options.scope && m.scope !== options.scope) return false
      if (filterTags.length && !filterTags.every((t) => m.tags.includes(t))) return false
      return true
    })

    const docs = candidates.map((m) => ({
      memory: m,
      haystack: tokenize(`${m.text} ${m.tags.join(' ')} ${m.kind}`),
      lowerText: m.text.toLowerCase(),
      lowerTags: m.tags.map((t) => t.toLowerCase()),
    }))

    const df = new Map()
    for (const term of terms) {
      let count = 0
      for (const doc of docs) if (doc.haystack.includes(term)) count += 1
      df.set(term, count)
    }

    const total = docs.length || 1
    const now = Date.now()
    const queryLower = String(query ?? '').trim().toLowerCase()
    const scored = []

    for (const doc of docs) {
      const m = doc.memory
      let score = 0
      for (const term of terms) {
        const hits = doc.haystack.reduce((n, t) => (t === term ? n + 1 : n), 0)
        if (!hits) continue
        const idf = Math.log(1 + (total - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
        score += idf * (1 + 0.35 * Math.min(hits - 1, 3))
        if (doc.lowerTags.includes(term)) score += 1.5
      }
      if (queryLower.length >= 2 && doc.lowerText.includes(queryLower)) score += 3
      if (!terms.length) score += 1
      score += m.importance * 0.5
      const ageDays = (now - (m.updatedAt ?? now)) / 86_400_000
      score += Math.exp(-ageDays / 120) * 0.6
      if (m.scope === 'project') {
        if (options.cwd && m.cwd === options.cwd) score += 1.2
        else if (options.cwd && m.cwd && m.cwd !== options.cwd) score -= 1.0
      }
      if (score > 0 || !terms.length) scored.push({ memory: m, score })
    }

    scored.sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)

    const picked = scored.slice(0, limit)
    if (picked.length && terms.length) {
      const now2 = Date.now()
      for (const { memory } of picked) {
        memory.uses += 1
        memory.lastUsedAt = now2
      }
      this.markDirty()
    }
    return picked
  }

  /** 置顶记忆：给系统提示用，只取全局作用域的高价值条目。 */
  pinned(limit = 12, maxChars = 1600) {
    const list = this.memories
      .filter((m) => m.scope === 'global' && (m.importance >= 4 || m.kind === 'preference'))
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
    const lines = []
    let used = 0
    for (const m of list) {
      const text = m.text.length > 220 ? `${m.text.slice(0, 219)}…` : m.text
      const line = `- [${m.id}] ${text} (${m.kind}, 重要度${m.importance})`
      if (used + line.length > maxChars) break
      lines.push(line)
      used += line.length
      if (lines.length >= limit) break
    }
    return lines
  }

  stats() {
    const byKind = {}
    for (const m of this.memories) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1
    return { total: this.memories.length, byKind, root: this.root, file: this.file }
  }

  markDirty() {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 300)
    this.saveTimer.unref?.()
  }

  flush() {
    if (!this.dirty) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const payload = { version: FILE_VERSION, updatedAt: Date.now(), memories: this.memories }
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.file)
    this.dirty = false
  }

  dispose() {
    try {
      this.flush()
    } catch {}
  }
}
