/**
 * 客户端包的结构断言：这个文件是给 ModuleLoader 的工厂产物，跑不进 node，
 * 所以只验契约与词典——文案键漏一个，界面上就会显示成键名。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** 从 `const zh = {` 开始按大括号配对取出对象字面量，再抽一级键名。 */
function dictionaryKeys(name) {
  const start = source.indexOf(`const ${name} = {`)
  assert.notEqual(start, -1, `找不到 ${name} 词典`)
  let index = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  assert.notEqual(end, -1, `${name} 词典没有闭合`)
  const body = source.slice(start, end)
  return [...body.matchAll(/^\t\t\t([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
}

test('ModuleLoader 契约：id / inject / 导出', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id: "dsh-x-context-menu"/)
  assert.match(source, /const inject = \["slots", "locale"\]/)
  assert.match(source, /return \{ apply, inject \};/)
})

test('词典：中英键集合一致，且没有重复', () => {
  const zh = dictionaryKeys('zh')
  const en = dictionaryKeys('en')
  assert.ok(zh.length > 20, `中文词典太小：${zh.length}`)
  assert.deepEqual([...zh].sort(), [...en].sort())
  assert.equal(new Set(zh).size, zh.length, '中文词典有重复键')
})

test('用到的每个 t("key") 都在词典里', () => {
  const keys = new Set(dictionaryKeys('zh'))
  const used = [...source.matchAll(/\bt\("([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1])
  assert.ok(used.length > 10)
  for (const key of new Set(used)) assert.ok(keys.has(key), `词典缺 ${key}`)
})

test('挂到 shell.overlay，并保留默认右键行为', () => {
  assert.match(source, /ctx\.slots\.inject\("shell\.overlay"/)
  assert.match(source, /ctx\.slots\.register\(/)
  assert.match(source, /if \(!menu\) return;/)
})

test('动作走官方服务与自家环回路由', () => {
  for (const call of [
    'archiveSession',
    'pinSession',
    'unpinSession',
    'forkSession',
    'startSession',
    'sessions.manager?.rename',
  ]) {
    assert.ok(source.includes(call), `缺少对 ${call} 的调用`)
  }
  assert.match(source, /\/api\/x-context-menu\/reveal/)
  assert.match(source, /\/api\/x-context-menu\/open-url/)
})

test('目标解析只认 data-row-key 的两种前缀', () => {
  assert.match(source, /key\.startsWith\("session:"\)/)
  assert.match(source, /key\.startsWith\("workspace:"\)/)
})

/** `ctx.inject(["contextMenus"], ...` 到自绘菜单那一段之前（官方菜单贡献）。 */
function nativeBlock() {
  const start = source.indexOf('ctx.inject(["contextMenus"]')
  assert.notEqual(start, -1, '找不到 contextMenus 注册块')
  const end = source.indexOf('// ---- 菜单装配 ----', start)
  assert.notEqual(end, -1, '找不到自绘菜单的分界')
  return source.slice(start, end)
}

test('会话行/工作区行让给官方菜单，不再自绘', () => {
  assert.match(source, /const nativeOwnsRow = \(target\) => \{/)
  assert.match(source, /if \(nativeOwnsRow\(target\)\) \{/)
  // 让给官方时既不 preventDefault 也不 stopPropagation：官方自己的触发器才收得到。
  const start = source.indexOf('const onContextMenu = (event) => {')
  const end = source.indexOf('const onPointerDown =', start)
  const handler = source.slice(start, end)
  const defer = handler.slice(handler.indexOf('if (nativeOwnsRow(target))'), handler.indexOf('const menu = buildMenu'))
  assert.doesNotMatch(defer, /preventDefault|stopPropagation/)
  assert.match(defer, /close\(\)/)
})

test('官方不挂触发器的行仍归自绘：空白会话、没有路径的工作区', () => {
  const start = source.indexOf('const nativeOwnsRow = (target) => {')
  const end = source.indexOf('// ---- 事件 ----', start)
  const block = source.slice(start, end)
  assert.match(block, /sessionSummary\(target\.sessionId\)\?\.blank !== true/)
  assert.match(block, /workspace\?\.workspaceId && workspace\?\.path/)
})

test('官方菜单里只加官方没有的动作', () => {
  const block = nativeBlock()
  assert.match(block, /target: "session"/)
  assert.match(block, /target: "workspace"/)
  for (const id of ['copy-title', 'copy-cwd', 'reveal', 'new-session', 'copy-name', 'copy-path']) {
    assert.ok(block.includes(`id: "${id}"`), `官方菜单贡献缺 ${id}`)
  }
  // 官方已有的：置顶/重命名/分叉/归档/删除/复制 Session ID/在应用中打开，这里一个都不能再出现。
  for (const duplicate of ['pinSession', 'unpinSession', 'forkSession', 'archiveSession', 'unarchiveSession', 'renameSession', 'copySessionId', 'togglePin']) {
    assert.ok(!block.includes(duplicate), `官方菜单贡献重复了 ${duplicate}`)
  }
})

test('官方菜单开着时自家菜单收掉，反之亦然', () => {
  assert.match(source, /menus\.active\.subscribe|active\.subscribe\(/)
  // 自绘菜单打开前先关官方菜单：官方只认没被 preventDefault 的 contextmenu 关闭。
  assert.match(source, /menus\.close\(\)/)
})
