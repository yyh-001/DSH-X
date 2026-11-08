/**
 * 启动剖析的账本：没有 URL 的原生/GC 帧要沿调用栈归到最近的 JS 包，
 * 否则「原生与 GC 36s」永远回答不了「哪个插件最费时」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { summarize } from '../src/perf/plugin-profile.mjs'

function frame(id, functionName, url, children) {
  return { id, callFrame: { functionName, url }, ...(children ? { children } : {}) }
}

test('原生/GC 归到最近的 JS 调用方，找不到调用方的单独计数', () => {
  const cpuProfile = {
    nodes: [
      frame(1, '(root)', '', [2, 5, 6]),
      frame(2, 'apply', 'file:///profile/node_modules/demo-plugin/index.js', [3]),
      frame(3, 'open', '', [7]),
      frame(7, 'readFileUtf8', ''),
      frame(5, '', ''),
      frame(6, 'Module._load', 'node:internal/modules/cjs/loader'),
    ],
    samples: [2, 3, 7, 6, 5],
    timeDeltas: [1000, 2000, 3000, 4000, 5000],
  }
  const report = summarize(cpuProfile, null)
  const byName = new Map(report.packages.map((row) => [row.name, row]))
  const plugin = byName.get('demo-plugin')
  assert.equal(plugin.cpuMs, 1, '插件自己的 JS 只有 1ms')
  assert.equal(plugin.nativeMs, 5, 'open + readFileUtf8 都归给它')
  assert.equal(plugin.totalMs, 6, '排序/展示用 JS + 原生')
  const node = byName.get('(Node 内部)')
  assert.equal(node.cpuMs, 4)
  assert.equal(node.nativeMs, 0)
  assert.equal(report.nativeUnattributedMs, 5, 'GC 帧没有 JS 调用方')
  assert.equal(report.packages[0].name, 'demo-plugin', '按含原生的总耗时排序')
  const native = new Map(report.native.map((row) => [row.name, row.cpuMs]))
  assert.equal(native.get('open'), 2)
  assert.equal(native.get('readFileUtf8'), 3)
  assert.equal(native.get('(匿名原生)'), 5)
})

test('模块加载沿依赖图归到插件，共用依赖均摊', () => {
  const url = (name) => `file:///profile/node_modules/${name}/index.js`
  const cpuProfile = {
    nodes: [
      frame(1, '(root)', '', [2]),
      frame(2, 'apply', url('demo-plugin')),
    ],
    samples: [2],
    timeDeltas: [1000],
  }
  const timing = {
    resolveCalls: [
      { parent: url('demo-plugin'), specifier: 'dep-a', url: url('dep-a'), us: 5000 },
      { parent: url('dep-a'), specifier: 'dep-b', url: url('dep-b'), us: 2000 },
      { parent: url('dep-b'), specifier: 'node:fs', url: 'node:fs', us: 1000 },
      // 加载器自己触发的解析不算到任何插件头上
      { parent: 'node:internal/modules/cjs/loader', specifier: 'other', url: url('other'), us: 7000 },
    ],
    loadCalls: [
      { url: url('demo-plugin'), us: 300 },
      { url: url('dep-a'), us: 1000 },
      { url: url('dep-b'), us: 500 },
    ],
  }
  const report = summarize(cpuProfile, null, timing, ['demo-plugin'])
  assert.equal(report.plugins.length, 1)
  const plugin = report.plugins[0]
  assert.equal(plugin.name, 'demo-plugin')
  assert.equal(plugin.loadMs, 10, '自身 + 依赖的解析/读取都算进来')
  assert.equal(plugin.runMs, 1, '插件与依赖的 JS 执行')
  assert.equal(plugin.totalMs, 11)
  assert.equal(report.moduleLoadMs, 17)
  const pkg = report.packages.find((row) => row.name === 'dep-a')
  assert.equal(pkg.loadMs, 1, '读 dep-a 自己的文件')
  assert.equal(pkg.resolveMs, 2, '它触发的解析')
  assert.equal(pkg.totalMs, 3)
  assert.equal(pkg.plugin, false, '依赖包不是插件本体')
})

test('空剖析不报错', () => {
  const report = summarize({ nodes: [], samples: [], timeDeltas: [] }, null)
  assert.deepEqual(report.packages, [])
  assert.equal(report.nativeUnattributedMs, 0)
})

test('pnpm 隔离布局：按最里层的 node_modules/<包> 归属，不全归成 .pnpm', () => {
  const pnpm = (name) => `file:///profile/node_modules/.pnpm/${name.replace('/', '+')}@1.0.0/node_modules/${name}/index.js`
  const cpuProfile = {
    nodes: [frame(1, '(root)', '', [2, 3]), frame(2, 'apply', pnpm('demo-plugin')), frame(3, 'run', pnpm('@scope/dep'))],
    samples: [2, 3],
    timeDeltas: [3000, 2000],
  }
  const timing = { resolveCalls: [{ parent: pnpm('demo-plugin'), specifier: '@scope/dep', url: pnpm('@scope/dep'), us: 1000 }], loadCalls: [] }
  const report = summarize(cpuProfile, null, timing, ['demo-plugin'])
  assert.ok(!report.packages.some((row) => row.name === '.pnpm'), '没有 .pnpm 这一行')
  assert.equal(report.plugins[0].runMs, 5, '插件自己 3ms + 只有它用的依赖 2ms')
})

test('宿主也加载的框架包（@deepseek-ai/*、dsh 自身）不摊给插件', () => {
  const url = (name) => `file:///profile/node_modules/${name}/index.js`
  const cpuProfile = {
    nodes: [frame(1, '(root)', '', [2, 3, 4]), frame(2, 'apply', url('demo-plugin')), frame(3, 'emit', url('@deepseek-ai/cordis')), frame(4, 'main', 'file:///opt/dsh/dist/main.js')],
    samples: [2, 3, 4],
    timeDeltas: [1000, 50000, 7000],
  }
  const timing = {
    resolveCalls: [
      { parent: 'file:///opt/dsh/dist/main.js', specifier: '@deepseek-ai/cordis', url: url('@deepseek-ai/cordis'), us: 100 },
      { parent: url('@deepseek-ai/cordis'), specifier: 'demo-plugin', url: url('demo-plugin'), us: 100 },
      { parent: url('demo-plugin'), specifier: '@deepseek-ai/cordis', url: url('@deepseek-ai/cordis'), us: 100 },
      { parent: url('demo-plugin'), specifier: 'x', url: 'file:///elsewhere/x.js', us: 100 },
    ],
    loadCalls: [],
  }
  const plugin = summarize(cpuProfile, null, timing, ['demo-plugin']).plugins[0]
  assert.equal(plugin.runMs, 1, 'cordis 的 50ms 和 dsh 自身的 7ms 是框架开销，不算插件的')
})

test('报告文件名：ASCII 名字不变，中文按 UTF-8 转义，不再互相撞名', async () => {
  const { reportFileName } = await import('../src/perf/plugin-profile.mjs')
  assert.equal(reportFileName('0.2.1@web'), '0.2.1@web')
  assert.equal(reportFileName('0.2.1@工作'), '0.2.1@%E5%B7%A5%E4%BD%9C')
  assert.notEqual(reportFileName('0.2.1@工作'), reportFileName('0.2.1@学习'))
  const server = (await import('node:fs')).readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  assert.match(server, /function pluginProfileFile[\s\S]*?\[\^0-9A-Za-z@\._-\]/, '管理页读报告用同一套规则')
})
