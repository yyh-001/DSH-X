/**
 * 工具 + 工作区解析的端到端用例：不需要 dsh 运行时。
 * 用假的 defineTool 收集工具定义，再用假的 exec（带 agent.session.header.cwd）调 execute，
 * 验证「记忆真的落到了这个工作区的目录里」——这条路径就是 dsh 里跑的那条。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { GUIDANCE, normalizeConfig, rootFor, storeForAgent, workspaceOf } from '../lib/index.js'
import { workspaceKey } from '../lib/store.js'
import { createTools } from '../lib/tools.js'

function fakeExec(cwd, id = 'sess-1') {
  return { agent: { session: { id, header: { cwd } } } }
}

function buildTools(home, config = normalizeConfig()) {
  const definitions = []
  const defineTool = (definition) => {
    definitions.push(definition)
    return definition
  }
  const tools = createTools({ defineTool, storeFor: (exec) => storeForAgent(exec?.agent, config, home) })
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  return { tools, byName }
}

test('六个工具都在，名字与 output 契约完整', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-x-memory-home-'))
  try {
    const { tools } = buildTools(home)
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['memory_save', 'memory_search', 'memory_list', 'memory_read', 'memory_update', 'memory_delete'],
    )
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 20)
      assert.equal(typeof tool.execute, 'function')
      assert.ok(tool.output?.schema, `${tool.name} 缺 output.schema`)
      assert.equal(typeof tool.output.render, 'function')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('save → search → read → update → delete：记忆落在调用者工作区的目录里', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-x-memory-home-'))
  const cwdA = 'C:\\work\\alpha'
  const cwdB = 'C:\\work\\beta'
  try {
    const config = normalizeConfig()
    const { byName } = buildTools(home, config)
    const execA = fakeExec(cwdA)

    const saved = await byName.memory_save.execute(
      { title: 'Deploy ports', type: 'project', description: 'Prod runs on 8443', content: '生产走 8443，[[tls]] 里有证书。' },
      execA,
    )
    assert.deepEqual({ ok: saved.ok, action: saved.action, name: saved.name }, { ok: true, action: 'created', name: 'deploy-ports' })

    const expectedRoot = rootFor(config, cwdA, home)
    assert.equal(expectedRoot, join(home, 'memories', workspaceKey(cwdA)))
    assert.ok(existsSync(join(expectedRoot, 'deploy-ports.md')))
    assert.match(readFileSync(join(expectedRoot, 'MEMORY.md'), 'utf8'), /deploy-ports\.md/)

    // 另一个工作区看不到 A 的记忆
    const listedB = await byName.memory_list.execute({}, fakeExec(cwdB))
    assert.equal(listedB.count, 0)

    const found = await byName.memory_search.execute({ query: '8443' }, execA)
    assert.equal(found.count, 1)
    assert.equal(found.results[0].name, 'deploy-ports')

    const read = await byName.memory_read.execute({ name: 'deploy-ports' }, execA)
    assert.equal(read.ok, true)
    assert.match(read.content, /8443/)

    const updated = await byName.memory_update.execute({ name: 'deploy-ports', content: '生产走 9443。' }, execA)
    assert.equal(updated.ok, true)
    assert.match((await byName.memory_read.execute({ name: 'deploy-ports' }, execA)).content, /9443/)

    const duplicated = await byName.memory_save.execute({ name: 'deploy-ports', title: 'Again', type: 'project', description: 'x', content: 'y' }, execA)
    assert.equal(duplicated.ok, false)
    assert.equal(duplicated.action, 'exists')

    const deleted = await byName.memory_delete.execute({ name: 'deploy-ports' }, execA)
    assert.equal(deleted.ok, true)
    assert.equal((await byName.memory_list.execute({}, execA)).count, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('坏参数由工具兜成结构化失败，不抛给运行时', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-x-memory-home-'))
  try {
    const { byName } = buildTools(home)
    const exec = fakeExec('C:\\work\\gamma')
    const badName = await byName.memory_read.execute({ name: '../etc/passwd' }, exec)
    assert.equal(badName.ok, false)
    assert.match(badName.error, /记忆名不合法/)

    const badType = await byName.memory_save.execute({ title: 'x', type: 'nope', description: 'd', content: 'c' }, exec)
    assert.equal(badType.ok, false)
    assert.match(badType.error, /类型不合法/)

    const missing = await byName.memory_delete.execute({ name: 'nope' }, exec)
    assert.equal(missing.ok, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('workspaceOf：会话头没 cwd 时退回进程 cwd', () => {
  assert.equal(workspaceOf({ session: { header: { cwd: '/tmp/x' } } }), '/tmp/x')
  assert.equal(workspaceOf(undefined), process.cwd())
})

test('GUIDANCE：写记忆的纪律在，工具名齐', () => {
  for (const tool of ['memory_save', 'memory_search', 'memory_list', 'memory_read', 'memory_update', 'memory_delete']) {
    assert.match(GUIDANCE, new RegExp(tool))
  }
  assert.match(GUIDANCE, /Why:/)
  assert.match(GUIDANCE, /MEMORY\.md/)
})
