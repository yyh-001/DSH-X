import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// dsh 的 node-addon-require-builtin 用「Node 版本 + V8 版本」精确匹配运行时指纹，
// 不在这张表里的 Electron 会让实例一启动就死在 requireBuiltin：
// `unsupported Electron runtime fingerprint`（#115）。
// 表来源：packages/native/src/runtime_context/runtime_profile.cc
// https://github.com/deepseek-ai/dsh-node-addon-require-builtin/blob/master/packages/native/src/runtime_context/runtime_profile.cc
const NATIVE_ADDON_ELECTRON_PROFILES = [
  { electron: '43.0.0', node: '24.17.0', v8: '15.0.245.13-electron.0' },
  { electron: '44.0.0', node: '24.18.1', v8: '15.2.124.13-electron.0' },
  { electron: '44.7.0', node: '24.21.0', v8: '15.2.124.28-electron.0' },
  { electron: '45.0.0-alpha.6', node: '24.21.0', v8: '15.4.80-electron.0' },
]

test('固定的 Electron 必须在 dsh 原生模块的指纹表里，升级前先确认表里有新版本', () => {
  const supported = NATIVE_ADDON_ELECTRON_PROFILES.map((profile) => profile.electron)
  const electron = root.devDependencies.electron
  assert.ok(supported.includes(electron),
    `Electron ${electron} 不在 dsh 原生模块支持的版本里（${supported.join(' / ')}），实例会启动失败：unsupported Electron runtime fingerprint`)
})

test('打包脚本的兜底版本与 package.json 一致，避免 npm pack 打出对不上的运行时', () => {
  const source = readFileSync(new URL('../scripts/pack-npm.mjs', import.meta.url), 'utf8')
  const after = source.slice(source.indexOf('devDependencies?.electron'))
  const fallback = /\|\|\s*'(\d+\.\d+\.\d[^']*)'/.exec(after)
  assert.ok(fallback, 'pack-npm.mjs 应该有 electron 兜底版本')
  assert.equal(fallback[1], root.devDependencies.electron)
})
