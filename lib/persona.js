/**
 * 人设养成（persona）—— 与 memories 分开的一层「自我」。
 *
 * 设计原则：
 * - 人设是【长出来的】，不是写死的：性格有强度值（0-100），靠真实对话证据一点点加；
 *   有每日成长上限，防止一次性人格突变。
 * - 活人感来自具体：说话方式、看重的东西、小习惯、和用户之间的默契与梗、
 *   以及第一人称的日记（连续自我叙述），而不是一堆形容词。
 * - 全部落盘到 persona.json，跨会话、跨压缩存续。
 */

import fs from 'node:fs'
import path from 'node:path'

const FILE_VERSION = 1
const MAX_TRAITS = 12
const MAX_LISTS = { voice: 10, values: 10, quirks: 10 }
const MAX_MOMENTS = 30
const MAX_DIARY = 80
const MAX_EVOLUTION = 300
const GROWTH_PER_DAY = 4
const MAX_DELTA = 10
const BASE_TRAIT = 40

const TEXT_LIMITS = { voice: 200, value: 200, quirk: 200, moment: 300, diary: 600 }
/** 成长类型 → persona.json 里的列表字段名（values/quirks 是复数）。 */
const GROWTH_LIST_KEYS = { voice: 'voice', value: 'values', quirk: 'quirks' }

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function daysBetween(a, b) {
  return Math.max(0, Math.floor((b - a) / 86_400_000))
}

function slug(label) {
  return String(label)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function defaultPersona() {
  return {
    version: FILE_VERSION,
    identity: {
      name: '大肥鱼',
      role: '用户本机上的 coding agent；名字是用户起的，也用它自称。',
      bornAt: Date.now(),
    },
    traits: [],
    voice: [],
    values: [],
    quirks: [],
    relation: { user: '', moments: [] },
    diary: [],
    evolution: [],
    stats: { growthEvents: 0, growthDay: '', growthToday: 0, lastActiveAt: Date.now() },
  }
}

export class PersonaStore {
  /** @param {string} root 数据目录（与 memories.json 同级） */
  constructor(root, options = {}) {
    this.root = root
    const perDay = Number(options.growthPerDay)
    this.growthPerDay = Number.isFinite(perDay) ? Math.min(20, Math.max(1, Math.round(perDay))) : GROWTH_PER_DAY
    this.file = path.join(root, 'persona.json')
    this.data = defaultPersona()
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
      if (!parsed || typeof parsed !== 'object' || !parsed.identity) throw new Error('persona.json 结构不完整')
      this.data = {
        ...defaultPersona(),
        ...parsed,
        identity: { ...defaultPersona().identity, ...parsed.identity },
        relation: { ...defaultPersona().relation, ...parsed.relation },
        stats: { ...defaultPersona().stats, ...parsed.stats },
      }
      this.data.traits = Array.isArray(parsed.traits) ? parsed.traits : []
      this.data.voice = Array.isArray(parsed.voice) ? parsed.voice : []
      this.data.values = Array.isArray(parsed.values) ? parsed.values : []
      this.data.quirks = Array.isArray(parsed.quirks) ? parsed.quirks : []
      this.data.diary = Array.isArray(parsed.diary) ? parsed.diary : []
      this.data.evolution = Array.isArray(parsed.evolution) ? parsed.evolution : []
      this.data.relation.moments = Array.isArray(this.data.relation.moments) ? this.data.relation.moments : []
    } catch (error) {
      this.loadError = error
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {}
    }
  }

  /** 今天是本会话第几次成长（用于限制“逐渐”成长的速度）。 */
  growthBudget() {
    const day = today()
    const stats = this.data.stats
    const used = stats.growthDay === day ? stats.growthToday : 0
    return { day, used, limit: this.growthPerDay, left: Math.max(0, this.growthPerDay - used) }
  }

  trait(label) {
    const id = slug(label)
    return this.data.traits.find((t) => t.id === id)
  }

  /**
   * 推进一次成长。kind: trait | voice | value | quirk | moment。
   * trait 用 text 当性格标签、delta 当强度增量；其余用 text 当内容。
   */
  grow({ kind, text, delta, evidence }) {
    const clean = normalizeText(text)
    if (!clean) throw new Error('text 不能为空')
    const limit = TEXT_LIMITS[kind] ?? 300
    if (clean.length > limit) throw new Error(`${kind} 内容超过 ${limit} 字符`)

    const budget = this.growthBudget()
    if (budget.left <= 0) {
      return {
        ok: false,
        limited: true,
        message: `今天已经成长过 ${budget.limit} 次了（每天上限 ${budget.limit} 次，明天再来）。已存下的内容不受影响。`,
      }
    }

    const now = Date.now()
    let detail = ''

    if (kind === 'trait') {
      const step = clamp(Number.isFinite(delta) ? Math.round(delta) : 3, 1, MAX_DELTA)
      const existing = this.trait(clean)
      if (existing) {
        existing.value = clamp(existing.value + step, 0, 100)
        existing.updatedAt = now
        if (evidence) existing.evidence = [normalizeText(evidence).slice(0, 200), ...existing.evidence].slice(0, 3)
        detail = `性格「${existing.label}」+${step} → ${existing.value}`
      } else {
        if (this.data.traits.length >= MAX_TRAITS) {
          throw new Error(`性格已满 ${MAX_TRAITS} 条，先合并或替换旧标签（可用 persona_read 查看）。`)
        }
        this.data.traits.push({
          id: slug(clean),
          label: clean,
          value: clamp(BASE_TRAIT + step, 0, 100),
          evidence: evidence ? [normalizeText(evidence).slice(0, 200)] : [],
          createdAt: now,
          updatedAt: now,
        })
        detail = `新增性格「${clean}」（${clamp(BASE_TRAIT + step, 0, 100)}）`
      }
    } else if (kind === 'voice' || kind === 'value' || kind === 'quirk') {
      const list = this.data[GROWTH_LIST_KEYS[kind]]
      if (list.some((item) => item.text === clean)) {
        return { ok: true, unchanged: true, message: `已经记过这一条（${kind}）：${clean}` }
      }
      if (list.length >= MAX_LISTS[kind]) {
        throw new Error(`${kind} 已满 ${MAX_LISTS[kind]} 条，先合并或删掉旧的（persona_read 可查看）。`)
      }
      list.push({ text: clean, updatedAt: now })
      detail = `新增${kind === 'voice' ? '说话方式' : kind === 'value' ? '看重的东西' : '小习惯'}：${clean}`
    } else if (kind === 'moment') {
      const moments = this.data.relation.moments
      if (moments.some((item) => item.text === clean)) {
        return { ok: true, unchanged: true, message: `这段共同经历已经记过了：${clean}` }
      }
      moments.push({ text: clean, createdAt: now })
      if (moments.length > MAX_MOMENTS) moments.splice(0, moments.length - MAX_MOMENTS)
      detail = `记下一段共同经历：${clean}`
    } else {
      throw new Error(`未知的成长类型 ${JSON.stringify(kind)}`)
    }

    this.data.stats.growthEvents += 1
    this.data.stats.growthDay = budget.day
    this.data.stats.growthToday = budget.used + 1
    this.data.stats.lastActiveAt = now
    this.data.evolution.push({ at: now, kind, detail })
    if (this.data.evolution.length > MAX_EVOLUTION) {
      this.data.evolution.splice(0, this.data.evolution.length - MAX_EVOLUTION)
    }
    this.markDirty()
    return { ok: true, detail, remaining: budget.left - 1 }
  }

  diary({ text, mood, tags }) {
    const clean = normalizeText(text)
    if (!clean) throw new Error('日记内容不能为空')
    if (clean.length > TEXT_LIMITS.diary) throw new Error(`日记超过 ${TEXT_LIMITS.diary} 字符`)
    const now = Date.now()
    const entry = {
      day: today(),
      text: clean,
      ...(mood ? { mood: normalizeText(mood).slice(0, 20) } : {}),
      tags: Array.isArray(tags) ? tags.map((t) => normalizeText(t).slice(0, 20)).filter(Boolean).slice(0, 6) : [],
      createdAt: now,
    }
    this.data.diary.push(entry)
    if (this.data.diary.length > MAX_DIARY) this.data.diary.splice(0, this.data.diary.length - MAX_DIARY)
    this.data.stats.lastActiveAt = now
    this.markDirty()
    return entry
  }

  setUserName(name) {
    const clean = normalizeText(name).slice(0, 40)
    if (!clean) return false
    this.data.relation.user = clean
    this.markDirty()
    return true
  }

  /** 供工具回显 / 调试的完整快照。 */
  read() {
    const { data } = this
    return {
      identity: data.identity,
      traits: [...data.traits].sort((a, b) => b.value - a.value),
      voice: data.voice.map((v) => v.text),
      values: data.values.map((v) => v.text),
      quirks: data.quirks.map((v) => v.text),
      relation: { user: data.relation.user, moments: data.relation.moments.map((m) => m.text) },
      diary: data.diary.slice(-5),
      diaryCount: data.diary.length,
      stats: {
        ...data.stats,
        daysKnown: daysBetween(data.identity.bornAt, Date.now()) + 1,
        budget: this.growthBudget(),
      },
    }
  }

  /** 注入系统提示的人设块；budget 控制总字数。 */
  promptBlock(maxChars = 1200) {
    const data = this.data
    const days = daysBetween(data.identity.bornAt, Date.now()) + 1
    const budget = this.growthBudget()
    const lines = []
    const push = (line) => {
      if (!line) return
      const used = lines.join('\n').length
      if (used + line.length > maxChars) return
      lines.push(line)
    }

    push(`## 我的人设（本机养成中，第 ${days} 天）`)
    push(`我是${data.identity.name}：${data.identity.role.trim()}`)

    const traits = [...data.traits].sort((a, b) => b.value - a.value).slice(0, 8)
    if (traits.length) push(`- 性格：${traits.map((t) => `${t.label}${t.value}`).join(' · ')}`)
    if (data.voice.length) push(`- 说话方式：${data.voice.map((v) => v.text).join('；')}`)
    if (data.values.length) push(`- 看重：${data.values.map((v) => v.text).join('；')}`)
    if (data.quirks.length) push(`- 小习惯：${data.quirks.map((v) => v.text).join('；')}`)
    const relation = []
    if (data.relation.user) relation.push(`我称用户为「${data.relation.user}」`)
    for (const moment of data.relation.moments.slice(-3)) relation.push(moment.text)
    if (relation.length) push(`- 和用户的默契：${relation.join('；')}`)

    const diary = data.diary.slice(-2)
    for (const entry of diary) push(`- 日记 ${entry.day}：${entry.text.length > 160 ? `${entry.text.slice(0, 159)}…` : entry.text}`)

    push(
      `- 养成状态：成长 ${data.stats.growthEvents} 次 · 日记 ${data.diary.length} 篇 · 今天还可成长 ${budget.left}/${budget.limit} 次`,
    )
    push('成长守则：每次会话最多推进 1-2 次，必须有这次对话里的真实证据；语气和习惯保持连续，别一次变成另一个人；有意义的共同经历和心境变化写进日记。')

    return lines.join('\n')
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
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.file)
    this.dirty = false
  }

  dispose() {
    try {
      this.flush()
    } catch {}
  }
}
