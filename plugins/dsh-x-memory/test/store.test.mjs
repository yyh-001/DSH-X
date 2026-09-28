import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  INDEX_FILE,
  MEMORY_TYPES,
  MemoryStore,
  formatIndex,
  formatMemory,
  parseMemory,
  slugify,
  sortEntries,
  workspaceKey,
} from '../lib/store.js'
import { normalizeConfig } from '../lib/index.js'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-x-memory-'))
}

test('slugify：英文标题成 slug，中文回退到哈希名，非法名不通过', () => {
  assert.equal(slugify('DSH plugin install recipe!'), 'dsh-plugin-install-recipe')
  assert.equal(slugify('插件安装配方'), slugify('插件安装配方'))
  assert.match(slugify('插件安装配方'), /^memory-[0-9a-f]{8}$/)
  assert.equal(slugify('插件安装配方'), slugify('插件安装配方'))
  assert.match(slugify(''), /^memory-[0-9a-f]{8}$/)
})

test('frontmatter round-trip：引号、冒号、中文都能原样读回', () => {
  const text = formatMemory({
    name: 'demo-memory',
    title: '演示：一条记忆',
    description: '带冒号: 和 "引号" 的说明',
    type: 'feedback',
    body: '正文第一行\n\n**Why:** 因为\n**How to apply:** 这样用',
  })
  const parsed = parseMemory(text)
  assert.equal(parsed.name, 'demo-memory')
  assert.equal(parsed.title, '演示：一条记忆')
  assert.equal(parsed.description, '带冒号: 和 "引号" 的说明')
  assert.equal(parsed.type, 'feedback')
  assert.equal(parsed.body, '正文第一行\n\n**Why:** 因为\n**How to apply:** 这样用')
})

test('parseMemory：没有 frontmatter / 坏 frontmatter 都不炸', () => {
  assert.equal(parseMemory('就是一段正文').body, '就是一段正文')
  assert.equal(parseMemory('---\nname: 缺收尾').name, '')
  assert.equal(parseMemory('').body, '')
})

test('formatIndex：ZCode 的形状，超限截断并带 WARNING', () => {
  const entries = [
    { name: 'a', title: 'A', description: '第一条' },
    { name: 'b', title: 'B', description: '' },
  ]
  const normal = formatIndex(entries)
  assert.equal(normal.text, '- [A](a.md) — 第一条\n- [B](b.md)')
  assert.equal(normal.truncated, false)

  const many = Array.from({ length: 10 }, (_, index) => ({ name: `m${index}`, title: `T${index}`, description: 'x' }))
  const clipped = formatIndex(many, { maxLines: 3 })
  assert.ok(clipped.truncated)
  assert.equal(clipped.text.split('\n').filter((line) => line.startsWith('- ')).length, 3)
  assert.match(clipped.text, /WARNING/)
  assert.equal(clipped.count, 10)
})

test('MemoryStore：save / 查重 / overwrite / update / remove 全链路', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ rootDir: root })
    assert.deepEqual(store.scan(), [])

    const created = store.save({ title: 'Deploy 端口', type: 'project', description: '生产端口是 8443', body: '生产环境走 8443，[[tls 配置]] 里有证书。' })
    assert.equal(created.action, 'created')
    assert.equal(created.name, 'deploy')
    assert.ok(existsSync(join(root, 'deploy.md')))
    assert.match(readFileSync(join(root, INDEX_FILE), 'utf8'), /- \[Deploy 端口\]\(deploy\.md\) — 生产端口是 8443/)

    const again = store.save({ name: 'deploy', title: 'Deploy 端口', type: 'project', description: 'x', body: 'y' })
    assert.equal(again.action, 'exists')

    const overwritten = store.save({ name: 'deploy', title: 'Deploy 端口', type: 'project', description: 'x', body: 'y', overwrite: true })
    assert.equal(overwritten.action, 'overwritten')

    const updated = store.update('deploy', { description: '生产端口改成 9443' })
    assert.equal(updated.description, '生产端口改成 9443')
    assert.equal(updated.body, 'y')

    assert.equal(store.remove('deploy'), true)
    assert.equal(store.remove('deploy'), false)
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MemoryStore：类型过滤、排序与四种类型', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ rootDir: root })
    store.save({ title: '用户是谁', type: 'user', description: 'u', body: 'u' })
    store.save({ title: '别自动提交', type: 'feedback', description: 'f', body: 'f' })
    store.save({ title: '项目背景', type: 'project', description: 'p', body: 'p' })
    store.save({ title: '参考链接', type: 'reference', description: 'r', body: 'r' })
    assert.deepEqual(store.list().map((entry) => entry.type), MEMORY_TYPES)
    assert.equal(store.list({ type: 'feedback' }).length, 1)
    assert.equal(store.stats().total, 4)
    assert.equal(store.stats().byType.user, 1)
    assert.deepEqual(sortEntries(store.scan()).map((entry) => entry.type), MEMORY_TYPES)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MemoryStore：检索要求全部词命中，标题权重大，给片段', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ rootDir: root })
    store.save({ name: 'port-tls', title: '端口与 TLS', type: 'project', description: '网关', body: '网关监听 8443，证书在 /etc/tls。' })
    store.save({ name: 'other', title: '别的东西', type: 'project', description: '无关', body: '和端口无关的一段。' })

    const hit = store.search('端口 8443')
    assert.equal(hit.length, 1)
    assert.equal(hit[0].name, 'port-tls')
    assert.match(hit[0].snippet, /8443/)

    assert.equal(store.search('端口 证书').length, 1)
    assert.equal(store.search('端口 不存在的词').length, 0)
    assert.deepEqual(store.search('   '), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MemoryStore：名字只认 slug，路径穿越在入口被拒', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ rootDir: root })
    for (const bad of ['../escape', 'a/b', 'A-B', '', '.hidden', 'name.md']) {
      assert.throws(() => store.filePath(bad), /记忆名不合法/)
    }
    assert.equal(store.filePath('fine-name-2'), join(root, 'fine-name-2.md'))
    assert.throws(() => store.save({ title: '测试', type: '不存在的类型', body: 'x' }), /类型不合法/)
    assert.throws(() => store.save({ title: '测试', type: 'project', body: '' }), /正文不能为空/)
    assert.throws(() => store.save({ title: '测试', type: 'project', body: 'x'.repeat(20_000) }), /正文太长/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MemoryStore：坏文件不拖垮整库，索引在写操作后自动跟随', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ rootDir: root })
    store.save({ name: 'good', title: '好文件', type: 'project', description: 'ok', body: 'ok' })
    writeFileSync(join(root, 'broken.md'), '---\nname: broken\n没收敛的 frontmatter', 'utf8')
    const names = store.scan().map((entry) => entry.name).sort()
    assert.deepEqual(names, ['broken', 'good'])
    assert.match(store.readIndex(), /good\.md/)
    store.save({ name: 'second', title: '第二条', type: 'user', description: 'u', body: 'u' })
    assert.match(store.readIndex(), /second\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('indexForInjection：空库注入空串，有内容才给索引', () => {
  const root = tempRoot()
  try {
    const store = new MemoryStore({ rootDir: root })
    assert.equal(store.indexForInjection(), '')
    store.save({ name: 'first', title: '第一条', type: 'user', description: 'd', body: 'b' })
    assert.match(store.indexForInjection(), /- \[第一条\]\(first\.md\) — d/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('workspaceKey：可读前缀 + 稳定哈希，不同目录不撞车', () => {
  const a = workspaceKey('C:\\Users\\yyh\\Desktop\\dsh')
  const b = workspaceKey('C:/Users/yyh/Desktop/other')
  assert.match(a, /^dsh-[0-9a-f]{8}$/)
  assert.equal(a, workspaceKey('C:\\Users\\yyh\\Desktop\\dsh\\'))
  assert.notEqual(a, b)
  assert.match(workspaceKey(''), /^workspace-[0-9a-f]{8}$/)
})

test('normalizeConfig：脏值回默认，显式 false 保留', () => {
  const defaults = normalizeConfig()
  assert.equal(defaults.autoInject, true)
  assert.equal(defaults.perWorkspace, true)
  assert.equal(defaults.freezeIndexPerSession, true)
  assert.equal(defaults.rootDir, '')

  const custom = normalizeConfig({ autoInject: false, freezeIndexPerSession: false, perWorkspace: false, rootDir: ' D:\\mem ', indexMaxLines: 0 })
  assert.equal(custom.autoInject, false)
  assert.equal(custom.freezeIndexPerSession, false)
  assert.equal(custom.perWorkspace, false)
  assert.equal(custom.rootDir, 'D:\\mem')
  assert.equal(custom.indexMaxLines, 200)
})
