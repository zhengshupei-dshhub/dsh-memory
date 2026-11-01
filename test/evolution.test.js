import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { EvolutionStore } from '../lib/evolution.js'

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-evolution-'))
  return { evo: new EvolutionStore(dir), dir }
}

test('记录改进点并去重', () => {
  const { evo } = tempStore()
  const first = evo.add({
    target: 'memory',
    kind: 'feature',
    text: '人设块按项目作用域过滤',
    evidence: '切换项目时看到别的项目的记忆',
  })
  assert.equal(first.created, true)
  assert.match(first.entry.id, /^E/)
  const again = evo.add({ target: 'memory', text: '人设块按项目作用域过滤' })
  assert.equal(again.created, false)
  assert.equal(again.entry.id, first.entry.id)
})

test('拒绝未知目标与类型', () => {
  const { evo } = tempStore()
  assert.throws(() => evo.add({ target: 'nope', text: 'x' }), /未知目标/)
  assert.throws(() => evo.add({ target: 'memory', kind: 'nope', text: 'x' }), /未知类型/)
  assert.throws(() => evo.add({ target: 'memory', text: '   ' }), /内容超过|不能为空|内容/)
})

test('列表筛选与排序', () => {
  const { evo } = tempStore()
  evo.add({ target: 'memory', text: 'A 项' })
  evo.add({ target: 'dafeiyu', text: 'B 项' })
  evo.add({ target: 'doubao', text: 'C 项' })
  assert.equal(evo.list().length, 3)
  assert.equal(evo.list({ target: 'doubao' }).length, 1)
  assert.equal(evo.list({ target: 'memory' }).length, 1)
  assert.equal(evo.list({ status: 'done' }).length, 0)
})

test('更新状态后可按状态查', () => {
  const { evo } = tempStore()
  const { entry } = evo.add({ target: 'both', text: 'C 项' })
  evo.update(entry.id, { status: 'doing' })
  assert.equal(evo.list({ status: 'doing' })[0].id, entry.id)
  assert.throws(() => evo.update('E00000', { status: 'done' }), /没有/)
  assert.throws(() => evo.update(entry.id, { status: 'bad' }), /未知状态/)
})

test('记录改动并自动关掉对应待办', () => {
  const { evo } = tempStore()
  const { entry } = evo.add({ target: 'memory', text: '加日记心情字段' })
  const record = evo.log({
    target: 'memory',
    version: '0.2.1',
    summary: '人设日记增加 mood 字段',
    files: ['lib/persona.js'],
    tests: '15 passed',
    backlogId: entry.id,
  })
  assert.match(record.id, /^J/)
  const closed = evo.list({ status: 'done' })[0]
  assert.equal(closed.id, entry.id)
  assert.equal(closed.version, '0.2.1')
  assert.equal(evo.status().counts.done, 1)
})

test('状态汇总与最近改动', () => {
  const { evo } = tempStore()
  evo.add({ target: 'memory', text: 'D 项' })
  evo.log({ target: 'dafeiyu', version: '0.1.23', summary: '气泡节流', tests: 'ok' })
  const status = evo.status()
  assert.equal(status.total, 1)
  assert.equal(status.counts.open, 1)
  assert.equal(status.journal, 1)
  assert.equal(status.lastChange.version, '0.1.23')
  assert.equal(evo.recentJournal(5).length, 1)
})

test('落盘后重载仍在，坏行被跳过', () => {
  const { evo, dir } = tempStore()
  evo.add({ target: 'memory', text: '持久化测试' })
  evo.log({ target: 'memory', version: '0.2.2', summary: '持久化', tests: 'ok' })

  fs.appendFileSync(path.join(dir, 'backlog.jsonl'), '{坏行\n')
  const reloaded = new EvolutionStore(dir)
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.status().journal, 1)
})

test('同一 id 的多次更新在重载后收敛成一条', () => {
  const { evo, dir } = tempStore()
  const { entry } = evo.add({ target: 'memory', text: '重载去重' })
  evo.update(entry.id, { status: 'doing' })
  evo.log({
    target: 'memory',
    version: '0.2.5',
    summary: '追加式更新要去重',
    tests: 'ok',
    backlogId: entry.id,
  })

  // 文件里此刻有三行：open / doing(update) / done(update)
  const lines = fs.readFileSync(path.join(dir, 'backlog.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 3)

  const reloaded = new EvolutionStore(dir)
  const rows = reloaded.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, entry.id)
  assert.equal(rows[0].status, 'done')
  assert.equal(rows[0].version, '0.2.5')
  // 创建时间保留最早的那次，不被 update 覆盖
  assert.equal(rows[0].at, entry.at)
  const counts = reloaded.status().counts
  assert.equal(counts.open, 0)
  assert.equal(counts.done, 1)
})
