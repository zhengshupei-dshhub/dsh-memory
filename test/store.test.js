import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MemoryStore, normalizeText, tokenize } from '../lib/store.js'

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-'))
  return { store: new MemoryStore(root), root }
}

test('tokenize 中英混合', () => {
  const tokens = tokenize('用户要求 DeepSeek Harness 用中文回答')
  assert.ok(tokens.includes('deepseek'))
  assert.ok(tokens.includes('harness'))
  assert.ok(tokens.includes('中文'))
  assert.ok(tokens.includes('文回'))
})

test('保存、落盘、重新加载', () => {
  const { store, root } = tempStore()
  const { memory, created } = store.save({
    text: '用户要求所有回答使用中文，称呼助手为「大肥鱼」。',
    kind: 'preference',
    tags: ['语言', '称呼'],
    importance: 5,
  })
  assert.equal(created, true)
  assert.match(memory.id, /^M/)
  store.flush()

  const reloaded = new MemoryStore(root)
  assert.equal(reloaded.stats().total, 1)
  assert.equal(reloaded.get(memory.id).importance, 5)
})

test('相同内容不重复创建', () => {
  const { store } = tempStore()
  const first = store.save({ text: '项目用 pnpm，不用 npm。', kind: 'fact' })
  const second = store.save({ text: '项目用   pnpm，不用 npm。', kind: 'fact', importance: 4 })
  assert.equal(second.created, false)
  assert.equal(second.memory.id, first.memory.id)
  assert.equal(second.memory.importance, 4)
  assert.equal(store.stats().total, 1)
})

test('按 id 更新', () => {
  const { store } = tempStore()
  const { memory } = store.save({ text: '构建命令是 pnpm build', kind: 'fact', importance: 2 })
  const updated = store.save({ id: memory.id, text: '构建命令是 pnpm run build（根目录）', importance: 4 })
  assert.equal(updated.created, false)
  assert.equal(updated.memory.id, memory.id)
  assert.equal(updated.memory.importance, 4)
  assert.match(updated.memory.text, /pnpm run build/)
})

test('检索排序与中文命中', () => {
  const { store } = tempStore()
  store.save({ text: '用户偏好：解释先给结论，再给细节。', kind: 'preference', importance: 5 })
  store.save({ text: 'billion-context 的数据存在 ~/.dsh/profiles/desktop/node_modules/billion-context。', kind: 'fact', importance: 2 })
  store.save({ text: '这个仓库的测试命令是 node --test。', kind: 'fact', importance: 3 })

  const hits = store.search('用户 偏好')
  assert.equal(hits[0].memory.kind, 'preference')

  const english = store.search('billion-context 数据')
  assert.match(english[0].memory.text, /billion-context/)

  const empty = store.search('')
  assert.equal(empty.length, 3)
})

test('作用域过滤与删除', () => {
  const { store } = tempStore()
  const project = store.save({ text: '本项目用 ESM，不用 CommonJS。', scope: 'project', cwd: '/tmp/proj-a' })
  store.save({ text: '全局：机器是 macOS。', scope: 'global' })

  assert.equal(store.search('ESM', { scope: 'project' }).length, 1)
  const removed = store.forget(project.memory.id)
  assert.ok(removed)
  assert.equal(store.forget(project.memory.id), undefined)
  assert.equal(store.stats().total, 1)
})

test('置顶记忆只取全局高价值条目', () => {
  const { store } = tempStore()
  store.save({ text: '低价值笔记', kind: 'note', importance: 1 })
  store.save({ text: '高价值决定', kind: 'decision', importance: 5 })
  store.save({ text: '偏低但属于偏好', kind: 'preference', importance: 2 })
  const pinned = store.pinned(10, 1600)
  assert.equal(pinned.length, 2)
  assert.ok(pinned.some((line) => line.includes('高价值决定')))
})

test('损坏文件不覆盖，留 .corrupt 备份', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-bad-'))
  fs.writeFileSync(path.join(root, 'memories.json'), '{not json')
  const store = new MemoryStore(root)
  assert.equal(store.stats().total, 0)
  const files = fs.readdirSync(root)
  assert.ok(files.some((f) => f.startsWith('memories.json.corrupt-')))
})

test('normalizeText 归一空白', () => {
  assert.equal(normalizeText('  a   b\n c '), 'a b c')
})
