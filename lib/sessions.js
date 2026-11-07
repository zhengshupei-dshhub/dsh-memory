/**
 * 直接读本地会话日志，做「回忆历史对话」检索。
 *
 * 为什么不用 ctx.sessionQuery.searchSessions：
 * 本 profile 的 session-query 索引配置为 openAt: never（不建 FTS 索引），
 * searchSessions 会直接报错；而会话日志本身就在 $DSH_HOME/sessions 下，
 * 自己解压 + 扫描既零依赖，也不受索引开关影响。
 *
 * 日志是「拼接的 Zstd 帧」容器：每个事件批次是一个独立 frame，Node 的
 * zstdDecompressSync / 流式解压都只解第一帧，所以要先按帧头结构切分。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const MAX_CACHE = 64
const cache = new Map()

/**
 * 切分拼接的 Zstd 帧，返回完整帧的字节区间；末尾残缺帧忽略。
 * 帧结构：magic(4) + descriptor(1) + [window] + [dictId] + [contentSize] + blocks…
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 解压一个会话日志文件为文本；失败返回 undefined。 */
export function decodeSessionFile(file) {
  const buffer = fs.readFileSync(file)
  if (file.endsWith('.jsonl') && !file.endsWith('.zstd')) return buffer.toString('utf8')
  const { frames } = scanZstdFrames(buffer)
  const parts = []
  for (const { start, end } of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      // 单帧损坏不应让整次回忆失败。
    }
  }
  return parts.join('')
}

/** 读取并缓存一个会话文件的事件列表（按 mtime+size 失效）。 */
export function readSessionEvents(file) {
  const stat = fs.statSync(file)
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.events
  const text = decodeSessionFile(file)
  const events = []
  if (text) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {}
    }
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, events })
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
  return events
}

function textOfParts(parts) {
  if (!Array.isArray(parts)) return ''
  const out = []
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string') out.push(part.text)
    else if (part?.type === 'tool-call') out.push(`[tool ${part.name ?? ''} ${JSON.stringify(part.arguments ?? part.args ?? {})}]`)
  }
  return out.join('\n')
}

/** 从事件流里抽取可检索的对话文本（用户/助手正文，跳过 reasoning 与系统提示）。 */
export function extractTranscript(events) {
  const messages = []
  for (const event of events) {
    const data = event?.data ?? {}
    if (event.type === 'user/message') {
      const text = textOfParts(data.content)
      if (text.trim()) messages.push({ role: 'user', time: event.time, text })
    } else if (event.type === 'assistant/message') {
      const text = textOfParts(data.message?.content)
      if (text.trim()) messages.push({ role: 'assistant', time: event.time, text })
    }
  }
  return messages
}

/** 列出会话日志文件：$root/<cwd-slug>/<session-id>/session.v4.jsonl[.zstd] */
export function listSessionFiles(root) {
  const files = []
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const cwdDir = path.join(root, dir.name)
    let sessions
    try {
      sessions = fs.readdirSync(cwdDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = path.join(cwdDir, session.name)
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const file = path.join(sessionDir, name)
        try {
          if (fs.statSync(file).isFile()) {
            files.push({ file, sessionId: session.name })
            break
          }
        } catch {}
      }
    }
  }
  return files
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 解析时间边界为毫秒；空/非法返回 null（表示不过滤）。 */
function toMs(value) {
  if (value === undefined || value === null || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/** 从会话文件路径反推出 cwd-slug 目录名（root/<slug>/<sessionId>/session.v4...）。 */
function dirCwd(file) {
  return path.basename(path.dirname(path.dirname(file)))
}

/** 生成 ±radius 字符的上下文片段，并标出命中位置起点。 */
export function makeSnippet(text, index, length, radius = 140) {
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + length + radius)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return `${head}${collapse(text.slice(start, end))}${tail}`
}

/**
 * 在历史会话中检索。
 * @param {string} root $DSH_HOME/sessions
 * @param {string} query
 * @param {{limit?: number, snippetsPerSession?: number, since?: string|number, before?: string|number, cwd?: string}} [options]
 *   since/before：ISO 日期字符串或毫秒时间戳，按会话 createdAt 过滤；cwd：匹配会话工作目录（子串）。
 */
export function searchTranscripts(root, query, options = {}) {
  const limit = Math.max(1, Math.min(10, options.limit ?? 4))
  const perSession = Math.max(1, Math.min(5, options.snippetsPerSession ?? 3))
  const needle = collapse(query).toLowerCase()
  if (!needle) return []

  // 时间与项目过滤边界（毫秒），非法输入退化为不限。
  const sinceMs = toMs(options.since)
  const beforeMs = toMs(options.before)
  const cwdNeedle = typeof options.cwd === 'string' ? options.cwd.trim().toLowerCase() : ''

  const results = []
  for (const { file, sessionId } of listSessionFiles(root)) {
    // cwd 不依赖解析 header：目录名即 slug，先按目录名粗筛，避免无谓解压。
    if (cwdNeedle && !dirCwd(file).toLowerCase().includes(cwdNeedle)) continue

    let events
    try {
      events = readSessionEvents(file)
    } catch {
      continue
    }
    const header = events.find((e) => e.type === 'session') ?? {}

    // 时间窗按会话创建时间过滤。
    const createdAtMs = header.createdAt ? new Date(header.createdAt).getTime() : NaN
    if (Number.isFinite(createdAtMs)) {
      if (sinceMs !== null && createdAtMs < sinceMs) continue
      if (beforeMs !== null && createdAtMs > beforeMs) continue
    }

    const messages = extractTranscript(events)
    let hits = 0
    const snippets = []
    for (const message of messages) {
      const haystack = collapse(message.text).toLowerCase()
      let from = 0
      let found = 0
      for (;;) {
        const index = haystack.indexOf(needle, from)
        if (index === -1) break
        found += 1
        from = index + needle.length
      }
      if (!found) continue
      hits += found
      if (snippets.length < perSession) {
        const at = haystack.indexOf(needle)
        snippets.push({
          role: message.role,
          time: message.time,
          snippet: makeSnippet(collapse(message.text), at, needle.length),
        })
      }
    }
    if (!hits) continue
    results.push({
      sessionId: header.id ?? sessionId,
      cwd: header.cwd ?? path.basename(path.dirname(path.dirname(file))).replace(/^--|--$/g, '').replace(/-/g, '/'),
      createdAt: header.createdAt ?? fs.statSync(file).birthtimeMs,
      hits,
      snippets,
    })
  }
  results.sort((a, b) => b.hits - a.hits || b.createdAt - a.createdAt)
  return results.slice(0, limit)
}
