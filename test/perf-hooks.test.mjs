import assert from 'node:assert/strict'
import test from 'node:test'
import { load as compatLoad } from '../compat/session-events.mjs'
import { load as perfLoad } from '../perf/patch-hooks.mjs'

test('同步补丁不解码无关模块的源码，也不改变下一层的结果', () => {
  const result = { format: 'module', source: { toString() { throw new Error('不应读取无关源码') } } }
  for (const load of [compatLoad, perfLoad]) {
    assert.equal(load('file:///unrelated/index.js', {}, () => result), result)
  }
})

test('同步兼容钩子仍补齐事件词汇并保护只读 stack 错误', () => {
  const source = 'const KNOWN_SESSION_EVENT_TYPES = new Set(["known"]);'
  const result = compatLoad('file:///node_modules/@deepseek-ai/dsh-session/lib/index.js', {}, () => ({ format: 'module', source: Buffer.from(source) }))
  assert.ok(!(result instanceof Promise))
  const types = new Function(`${result.source}; return KNOWN_SESSION_EVENT_TYPES;`)()
  for (const type of ['known', 'filesnap/point', 'filesnap/rewound', 'filesnap/redone']) assert.ok(types.has(type))
  const boot = compatLoad('file:///node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', {}, () => ({ format: 'module', source: 'if (stack !== void 0) error.stack = stack.replace(originalMessage, message);' }))
  assert.match(boot.source, /try \{ error.stack/)
})

test('字符串加速补丁的换行计数和 sourcemap 与原实现一致', () => {
  const source = 'function newlineCount(value) {\n\tlet count = 0;\n\tfor (const char of value) if (char === "\\n") count += 1;\n\treturn count;\n}\nconst mappings = Array.from({ length: newlineCount(source) }, (_, index) => index === 0 ? "AAAA" : "AACA").join(";");'
  const result = perfLoad('file:///node_modules/@deepseek-ai/dsh-client-modules/lib/index.js', {}, () => ({ format: 'module', source: Buffer.from(source) }))
  assert.ok(!(result instanceof Promise))
  assert.notEqual(result.source, source)
  const before = new Function('source', `${source}; return {count: newlineCount(source), mappings};`)
  const after = new Function('source', `${result.source}; return {count: newlineCount(source), mappings};`)
  for (const text of ['', '无换行😀', '\n', '\n\n', 'first\nlast', 'a\r\nb\n😀\n']) assert.deepEqual(after(text), before(text))
})

test('上游改写补丁目标或模块不是 ESM 时保持原样', () => {
  for (const load of [compatLoad, perfLoad]) {
    for (const url of ['file:///dsh-client-modules/lib/index.js', 'file:///dsh-session/lib/index.js']) {
      for (const result of [{format:'commonjs', source:'const x = 1'}, {format:'module', source:'const x = 1'}, {format:'module'}]) assert.equal(load(url, {}, () => result), result)
    }
  }
})
