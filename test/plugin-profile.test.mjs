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

test('空剖析不报错', () => {
  const report = summarize({ nodes: [], samples: [], timeDeltas: [] }, null)
  assert.deepEqual(report.packages, [])
  assert.equal(report.nativeUnattributedMs, 0)
})
