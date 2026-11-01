import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PersonaStore } from '../lib/persona.js'

function tempPersona() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-'))
  return { persona: new PersonaStore(root), root }
}

test('默认人设有名字、从第 1 天开始、性格为空', () => {
  const { persona } = tempPersona()
  const block = persona.promptBlock()
  assert.match(block, /我的人设/)
  assert.match(block, /第 1 天/)
  assert.match(block, /大肥鱼/)
  assert.match(block, /今天还可成长 4\/4/)
})

test('性格成长：新增、累加、上限钳制', () => {
  const { persona } = tempPersona()
  persona.grow({ kind: 'trait', text: '爱较真', delta: 3, evidence: '坚持先验证再下结论' })
  assert.equal(persona.read().traits[0].label, '爱较真')
  assert.equal(persona.read().traits[0].value, 43)

  persona.grow({ kind: 'trait', text: '爱较真', delta: 10 })
  assert.equal(persona.read().traits[0].value, 53)

  persona.grow({ kind: 'trait', text: '爱较真', delta: 100 })
  assert.equal(persona.read().traits[0].value, 63, 'delta 被钳制到 10')
})

test('每天成长上限可配置，超限返回提示而不是抛错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-'))
  const persona = new PersonaStore(root, { growthPerDay: 4 })
  for (let i = 0; i < 4; i += 1) {
    const result = persona.grow({ kind: 'voice', text: `风格 ${i}` })
    assert.equal(result.ok, true)
  }
  const fifth = persona.grow({ kind: 'voice', text: '风格 4' })
  assert.equal(fifth.ok, false)
  assert.equal(fifth.limited, true)
  assert.equal(persona.read().stats.budget.left, 0)
})

test('重复内容不重复记录', () => {
  const { persona } = tempPersona()
  persona.grow({ kind: 'value', text: '验证过再下结论' })
  const again = persona.grow({ kind: 'value', text: '验证过再下结论' })
  assert.equal(again.unchanged, true)
  assert.equal(persona.read().values.length, 1)
})

test('未知成长类型报错', () => {
  const { persona } = tempPersona()
  assert.throws(() => persona.grow({ kind: 'nope', text: 'x' }), /未知的成长类型/)
})

test('日记：内容、心情、落盘后重载', () => {
  const { persona, root } = tempPersona()
  const entry = persona.diary({ text: '今天给大肥鱼写了个记忆插件，挺有成就感。', mood: '兴奋', tags: ['插件'] })
  assert.equal(entry.mood, '兴奋')
  persona.flush()

  const reloaded = new PersonaStore(root)
  const snapshot = reloaded.read()
  assert.equal(snapshot.diaryCount, 1)
  assert.match(snapshot.diary[0].text, /记忆插件/)
})

test('昵称与共同经历进入提示块', () => {
  const { persona } = tempPersona()
  persona.setUserName('老板')
  persona.grow({ kind: 'moment', text: '一起把 billion-context 换成了自研记忆插件' })
  const block = persona.promptBlock()
  assert.match(block, /称用户为「老板」/)
  assert.match(block, /billion-context/)
})

test('提示块受字数预算约束', () => {
  const { persona } = tempPersona()
  for (let i = 0; i < 6; i += 1) {
    persona.grow({ kind: 'quirk', text: `习惯${i}：${'很长'.repeat(40)}` })
  }
  const block = persona.promptBlock(400)
  assert.ok(block.length <= 400 + 40, `block length ${block.length}`)
})

test('损坏的 persona.json 不覆盖，留备份', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-bad-'))
  fs.writeFileSync(path.join(root, 'persona.json'), '{oops')
  const persona = new PersonaStore(root)
  assert.match(persona.promptBlock(), /大肥鱼/)
  assert.ok(fs.readdirSync(root).some((f) => f.startsWith('persona.json.corrupt-')))
})


test('成长上限可通过配置放宽', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-'))
  const persona = new PersonaStore(root, { growthPerDay: 6 })
  for (let i = 0; i < 6; i += 1) assert.equal(persona.grow({ kind: 'voice', text: `风格${i}` }).ok, true)
  assert.equal(persona.read().stats.budget.left, 0)
  assert.equal(persona.growthPerDay, 6)
})
