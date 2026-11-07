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
