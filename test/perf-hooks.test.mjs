import assert from 'node:assert/strict'
import test from 'node:test'
import { load as compatLoad } from '../src/compat/session-events.mjs'
import { load as perfLoad } from '../src/perf/patch-hooks.mjs'

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

test('启动账本钩子同时认 cordis-plugin-loader 1.0.x 与 1.1.0 的 fiber 写法', () => {
  const url = 'file:///node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js'
  const init = 'async _init() {\n\t\tlet moduleNamespace;'
  const shapes = [
    // 1.0.x：registry.plugin() 返回 entry，fiber 在 .ctx.fiber
    'this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack).ctx.fiber;',
    // 1.1.0 起：registry.plugin() 直接返回 fiber
    'this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack);',
  ]
  for (const line of shapes) {
    const result = perfLoad(url, {}, () => ({ format: 'module', source: `${init}\n\t\t${line}\n\t}` }))
    assert.equal((result.source.match(/dsh-x\/plugin-profile/g) || []).length, 2)
    assert.ok(result.source.includes(`${line}\n\t\tglobalThis[Symbol.for("dsh-x/plugin-profile")]?.imported(this);`))
    assert.doesNotThrow(() => new Function(`return class { ${result.source} }`))
  }
})

test('loader 换成没见过的写法时不动源码', () => {
  const url = 'file:///node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js'
  const source = 'async _init() {\n\t\tthis.fiber = createFiber(plugin);\n\t}'
  const result = { format: 'module', source }
  assert.equal(perfLoad(url, {}, () => result), result)
})
