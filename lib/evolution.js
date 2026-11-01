/**
 * 演化记录（evolution）：给这两个本地插件留一份「想法 → 改动」的账本。
 *
 * - backlog：还没做的改进点（摩擦、bug、新功能），由对话里随手记下；
 * - journal：已经落地的改动（版本、摘要、文件、测试结果），配合 git 可回滚。
 *
 * 都是 append-only 的 JSONL，跟着记忆数据放在 ~/.dsh/memory/evolution/ 下，
 * 所以换会话、重启都还在。插件只负责存储与展示，改不改、怎么改由模型决定。
 */

import fs from 'node:fs'
import path from 'node:path'

export const TARGETS = ['memory', 'dafeiyu', 'both']
export const KINDS = ['idea', 'feature', 'bug', 'friction', 'refactor']
export const STATUSES = ['open', 'doing', 'done', 'dropped']

const MAX_TEXT = 1200
const MAX_EVIDENCE = 1000
const MAX_LIST = 200

function isoNow() {
  return new Date().toISOString()
}

function createId(prefix, existing) {
  for (;;) {
    const id = `${prefix}${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase()
    if (!existing.has(id)) return id
  }
}

function normalize(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length > max) throw new Error(`内容超过 ${max} 字符`)
  return value
}

function readJsonl(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 半行损坏（比如写入时崩溃）忽略，不影响其余记录。
    }
  }
  return out
}

/**
 * 文件是 append-only 的：`update()` 会为同一个 id 追加一行新状态。
 * 读回时按 id 收敛成一条——时间戳保留最早的（创建时间），其余字段取最后一次写入。
 * 否则重载后同一个改进点会出现「open + done」两条，列表和统计都会翻倍。
 */
function collapseById(rows) {
  const order = []
  const latest = new Map()
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id) continue
    const previous = latest.get(row.id)
    if (previous === undefined) {
      order.push(row.id)
      latest.set(row.id, row)
      continue
    }
    const merged = { ...previous, ...row, at: previous.at }
    delete merged.event
    latest.set(row.id, merged)
  }
  return order.map((id) => latest.get(id))
}

export class EvolutionStore {
  /** @param {string} dir 数据目录（通常是 <memory root>/evolution） */
  constructor(dir) {
    this.dir = dir
    this.backlogFile = path.join(dir, 'backlog.jsonl')
    this.journalFile = path.join(dir, 'journal.jsonl')
    this.backlog = []
    this.journal = []
    fs.mkdirSync(dir, { recursive: true })
    this.backlog = collapseById(readJsonl(this.backlogFile))
    this.journal = readJsonl(this.journalFile)
    this.byId = new Map(this.backlog.map((entry) => [entry.id, entry]))
  }

  #append(file, record) {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  }

  /** 记录一个改进点；同样的内容且还 open 时不重复记。 */
  add({ target, kind = 'idea', text, evidence, sessionId }) {
    const cleanText = normalize(text, MAX_TEXT)
    if (!cleanText) throw new Error('text 不能为空')
    const cleanEvidence = evidence ? normalize(evidence, MAX_EVIDENCE) : ''
    if (!TARGETS.includes(target)) throw new Error(`未知目标 ${JSON.stringify(target)}，可选：${TARGETS.join(' / ')}`)
    if (!KINDS.includes(kind)) throw new Error(`未知类型 ${JSON.stringify(kind)}，可选：${KINDS.join(' / ')}`)

    const duplicate = this.backlog.find(
      (entry) => entry.status !== 'done' && entry.status !== 'dropped' && entry.text === cleanText,
    )
    if (duplicate) return { entry: duplicate, created: false }

    const entry = {
      id: createId('E', new Set(this.backlog.map((item) => item.id))),
      at: isoNow(),
      target,
      kind,
      text: cleanText,
      ...(cleanEvidence ? { evidence: cleanEvidence } : {}),
      ...(sessionId ? { sessionId } : {}),
      status: 'open',
      updatedAt: isoNow(),
    }
    this.backlog.push(entry)
    this.byId.set(entry.id, entry)
    this.#append(this.backlogFile, entry)
    return { entry, created: true }
  }

  list({ status, target, limit = 20 } = {}) {
    if (status && !STATUSES.includes(status)) throw new Error(`未知状态 ${JSON.stringify(status)}`)
    const max = Math.max(1, Math.min(MAX_LIST, Number(limit) || 20))
    const filtered = this.backlog
      .filter((entry) => (status ? entry.status === status : true))
      .filter((entry) => (target ? entry.target === target || entry.target === 'both' : true))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    return filtered.slice(0, max)
  }

  update(id, patch = {}) {
    const entry = this.byId.get(String(id ?? '').trim().toUpperCase())
    if (!entry) throw new Error(`没有 ${id} 这条记录`)
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
      throw new Error(`未知状态 ${JSON.stringify(patch.status)}`)
    }
    const next = {
      ...entry,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.note ? { note: normalize(patch.note, MAX_TEXT) } : {}),
      ...(patch.version ? { version: normalize(patch.version, 40) } : {}),
      updatedAt: isoNow(),
    }
    this.#append(this.backlogFile, { ...next, at: next.updatedAt, event: 'update' })
    Object.assign(entry, next)
    return entry
  }

  /** 记录一次已落地的改动。 */
  log({ target, version, summary, files, tests, backlogId }) {
    if (!TARGETS.includes(target)) throw new Error(`未知目标 ${JSON.stringify(target)}`)
    const summaryText = normalize(summary, MAX_TEXT)
    if (!summaryText) throw new Error('summary 不能为空')
    const record = {
      id: createId('J', new Set(this.journal.map((item) => item.id))),
      at: isoNow(),
      target,
      version: normalize(version, 40),
      summary: summaryText,
      files: Array.isArray(files) ? files.map((f) => normalize(f, 200)).slice(0, 20) : [],
      tests: tests ? normalize(tests, 300) : '',
      ...(backlogId ? { backlogId: String(backlogId).toUpperCase() } : {}),
    }
    this.journal.push(record)
    this.#append(this.journalFile, record)
    if (backlogId) {
      try {
        this.update(backlogId, { status: 'done', version: record.version })
      } catch {}
    }
    return record
  }

  status() {
    const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]))
    for (const entry of this.backlog) counts[entry.status] = (counts[entry.status] ?? 0) + 1
    return {
      dir: this.dir,
      counts,
      total: this.backlog.length,
      journal: this.journal.length,
      lastChange: this.journal[this.journal.length - 1],
    }
  }

  recentJournal(limit = 5) {
    return this.journal.slice(-Math.max(1, Math.min(50, limit))).reverse()
  }
}
