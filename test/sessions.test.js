import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import {
  extractTranscript,
  listSessionFiles,
  readSessionEvents,
  scanZstdFrames,
  searchTranscripts,
} from '../lib/sessions.js'

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
}

/** 造一个与 DSH 相同布局的会话目录：sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd */
function makeSession(root, cwdSlug, id, events) {
  const dir = path.join(root, cwdSlug, id)
  fs.mkdirSync(dir, { recursive: true })
  const payload = Buffer.concat(events.map((e) => frame(`${JSON.stringify(e)}\n`)))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, payload)
  return file
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-sessions-'))
  const events = [
    { type: 'session', version: 4, id: 'session-aaa', createdAt: 1793000000000, cwd: '/tmp/proj-a' },
    {
      type: 'user/message',
      seq: 0,
      time: 1793000001000,
      data: { role: 'user', content: [{ type: 'text', text: '帮我查一下构建命令，上次说过用 pnpm' }] },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1793000002000,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '构建命令是 pnpm run build，测试用 node --test。' }] } },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1793000003000,
      data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '这段 reasoning 不应被索引' }] } },
    },
  ]
  const file = makeSession(root, '--tmp-proj-a--', 'session-aaa', events)
  const other = makeSession(root, '--tmp-proj-b--', 'session-bbb', [
    { type: 'session', version: 4, id: 'session-bbb', createdAt: 1793000004000, cwd: '/tmp/proj-b' },
  ])
  return { root, file, other }
}

test('scanZstdFrames 切分拼接帧', () => {
  const buffer = Buffer.concat([frame('a\n'), frame('bb\n'), frame('ccc\n')])
  const { frames, tornStart } = scanZstdFrames(buffer)
  assert.equal(frames.length, 3)
  assert.equal(tornStart, undefined)
  const texts = frames.map(({ start, end }) => zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
  assert.deepEqual(texts, ['a\n', 'bb\n', 'ccc\n'])
})

test('截断的末帧被忽略', () => {
  const whole = frame('hello\n')
  const truncated = whole.subarray(0, whole.length - 3)
  const { frames } = scanZstdFrames(Buffer.concat([frame('ok\n'), truncated]))
  assert.equal(frames.length, 1)
})

test('列出会话文件并解析事件', () => {
  const { root, file } = fixture()
  const files = listSessionFiles(root)
  assert.equal(files.length, 2)
  const found = files.find((f) => f.sessionId === 'session-aaa')
  assert.ok(found)
  assert.equal(found.file, file)
  const events = readSessionEvents(file)
  assert.equal(events.length, 4)
  assert.equal(events[0].cwd, '/tmp/proj-a')
})

test('抽取对话正文时跳过 reasoning', () => {
  const { file } = fixture()
  const messages = extractTranscript(readSessionEvents(file))
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'user')
  assert.ok(!messages.some((m) => m.text.includes('reasoning')))
})

test('历史会话检索命中并带上下文', () => {
  const { root } = fixture()
  const hits = searchTranscripts(root, 'pnpm')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].sessionId, 'session-aaa')
  assert.equal(hits[0].cwd, '/tmp/proj-a')
  assert.ok(hits[0].hits >= 2)
  assert.match(hits[0].snippets[0].snippet, /pnpm/)
})

test('空查询与无命中的行为', () => {
  const { root } = fixture()
  assert.deepEqual(searchTranscripts(root, '   '), [])
  assert.deepEqual(searchTranscripts(root, '不存在的关键词'), [])
  assert.deepEqual(searchTranscripts(path.join(root, 'missing'), 'x'), [])
})
