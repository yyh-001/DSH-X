import assert from 'node:assert/strict'
import test from 'node:test'

import { appBootStackPatch } from '../compat/session-events.mjs'

// issue #24：注册过任意 ESM loader 钩子（我们的 perf/ 与 compat/ 就是）时，Node 22.19 把
// 解析错误的 stack 变成**只读的自有属性**；dsh-app-boot 为了还原 importer 路径会写
// error.stack，这一写抛 TypeError 并顶掉原始错误码，于是 0.1.7 的插件元数据读取大面积报错。
// 补丁把赋值包进 try/catch —— 这里既钉住「改了什么」，也钉住「为什么需要」。

const LINE_WITH_MESSAGE = 'if (stack !== void 0) error.stack = stack.replace(originalMessage, message);'
const LINE_WITH_ERROR_MESSAGE = 'if (stack !== void 0) error.stack = stack.replace(originalMessage, error.message);'

const readOnlyStackError = () => {
  const error = new Error('Package subpath "./locale/en.json" is not defined by "exports"')
  error.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  Object.defineProperty(error, 'stack', { value: 'Error: original\n    at somewhere', writable: false, configurable: true })
  return error
}

test('两处 error.stack 赋值都会被包进 try/catch', () => {
  const source = `function a() {\n\t${LINE_WITH_MESSAGE}\n}\nfunction b() {\n\t${LINE_WITH_ERROR_MESSAGE}\n}\n`
  const patched = appBootStackPatch(source)
  assert.ok(patched, '认得出锚点就该改')
  assert.equal((patched.match(/try \{ error\.stack = /g) || []).length, 2, '两处都要包上')
  assert.ok(!patched.includes(`if (stack !== void 0) error.stack = `), '不该留下未包裹的赋值')
})

test('认不出的源码（dsh 换了写法）原样跳过，不改坏东西', () => {
  assert.equal(appBootStackPatch('const x = 1;'), null)
  assert.equal(appBootStackPatch('error.stack = other;'), null)
})

test('正常情况：行为不变，stack 仍按原意改写', () => {
  const patched = appBootStackPatch(LINE_WITH_MESSAGE)
  const run = new Function('error', 'stack', 'originalMessage', 'message', `'use strict';
${patched}\nreturn error.stack;`)
  const error = new Error('routed path')
  assert.equal(run(error, error.stack, 'routed', 'real'), error.stack.replace('routed', 'real'))
})

test('只读 stack（注册过钩子的环境）：原写法抛错，补丁后不抛错且保住错误码', () => {
  const original = new Function('error', 'stack', 'originalMessage', 'message', `'use strict';
${LINE_WITH_MESSAGE}\nreturn error;`)
  assert.throws(() => original(readOnlyStackError(), 'x', 'a', 'b'), /read only property 'stack'/, '这是 issue #24 的失效机制本身')

  const patched = appBootStackPatch(LINE_WITH_MESSAGE)
  const run = new Function('error', 'stack', 'originalMessage', 'message', `'use strict';
${patched}\nreturn error;`)
  const error = readOnlyStackError()
  const stack = error.stack
  assert.doesNotThrow(() => run(error, stack, 'a', 'b'), '补丁后不能再抛')
  assert.equal(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED', '原始错误码必须留着，上层靠它判断「资源缺失」')
})
