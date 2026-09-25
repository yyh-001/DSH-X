import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'

import { orderRuntimePaths, withBundledRuntime, withVersionBin } from '../server.js'

const BUNDLED = 'E:\\DSH\\node'

function dirWithPnpm() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pnpm-'))
  // Windows 上 pnpm 的 shim 是 .cmd，POSIX 上是可执行文件；两个都放，测试不挑平台
  writeFileSync(join(dir, 'pnpm.cmd'), '@echo off\r\n')
  writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\n')
  return dir
}

function plainDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-bin-'))
}

test('系统没有 pnpm：自带运行时排最前，其余顺序不变', () => {
  const a = plainDir()
  const b = plainDir()
  assert.deepEqual(orderRuntimePaths([a, b], BUNDLED), [BUNDLED, a, b])
})

test('系统有 pnpm：它的目录优先，自带运行时紧随其后（#12）', () => {
  // 场景：老 profile 的 .modules.yaml 记的是全局 pnpm 11 的 v11 store，
  // 自带 pnpm 8 顶在前面会让 pnpm 以 ERR_PNPM_UNEXPECTED_STORE 拒绝一切安装
  const npmRoot = dirWithPnpm()
  const other = plainDir()
  const ordered = orderRuntimePaths([other, npmRoot], BUNDLED)
  assert.equal(ordered[0], npmRoot, '系统的 pnpm 要最先被找到')
  assert.equal(ordered[1], BUNDLED, '自带的 node/npm 仍优先于系统其余目录')
  assert.deepEqual(ordered.slice(2), [other], '其余目录相对顺序不变')
})

test('pnpm 在 PATH 第一项也认，不只看最后', () => {
  const npmRoot = dirWithPnpm()
  const other = plainDir()
  assert.equal(orderRuntimePaths([npmRoot, other], BUNDLED)[0], npmRoot)
})

test('多个目录带 pnpm：取 PATH 里最靠前的那一个', () => {
  const first = dirWithPnpm()
  const second = dirWithPnpm()
  const ordered = orderRuntimePaths([first, second], BUNDLED)
  assert.equal(ordered[0], first)
  assert.deepEqual(ordered.slice(1), [BUNDLED, second])
})

test('自带目录去重：不会在 PATH 里出现两次', () => {
  const npmRoot = dirWithPnpm()
  const ordered = orderRuntimePaths([BUNDLED, npmRoot, BUNDLED], BUNDLED)
  assert.deepEqual(ordered, [npmRoot, BUNDLED])
  assert.equal(orderRuntimePaths([BUNDLED, npmRoot, BUNDLED], BUNDLED).filter((item) => item === BUNDLED).length, 1)
})

test('pnpm 只在自带目录里：不算系统的，照旧排最前', () => {
  const other = plainDir()
  assert.deepEqual(orderRuntimePaths([BUNDLED, other], BUNDLED), [BUNDLED, other])
})

test('withBundledRuntime：没有自带 node.exe 时原样返回', () => {
  // 开发环境（仓库里没有 node/ 目录）不走重排，直接交回原 PATH
  const original = process.env.PATH || ''
  assert.equal(withBundledRuntime(original), original)
})

// 第 1 条：agent 在 shell 里要能直接调 dsh（版本跟着启动器选的那个走）。
// 追加到 PATH 末尾，用户自己 PATH 上已有的 dsh 仍然优先。
test('版本自己的 .bin 追加在 PATH 末尾：用户已有的 dsh 优先，只有我们能让它可用', () => {
  const userPnpm = dirWithPnpm()
  const userBin = plainDir()          // 假设用户在这里也有个 dsh
  const versionBin = plainDir()
  const pathValue = [userPnpm, userBin].join(delimiter)
  const next = withVersionBin(pathValue, versionBin)
  const parts = next.split(delimiter)
  assert.equal(parts[parts.length - 1], versionBin, '追加在末尾，不插队')
  assert.equal(parts[0], userPnpm, '用户自己的目录顺序不变')
  assert.equal(parts[1], userBin, '用户自己的目录顺序不变')
})

test('版本 .bin 已经在 PATH 里就不重复追加', () => {
  const dir = plainDir()
  const pathValue = [dir, 'C:\Windows'].join(delimiter)
  assert.equal(withVersionBin(pathValue, dir), pathValue)
})

test('版本 .bin 不存在（还没装好 / 系统版 dsh）时原样返回', () => {
  const pathValue = 'C:\Windows'
  assert.equal(withVersionBin(pathValue, ''), pathValue)
  assert.equal(withVersionBin(pathValue, join(tmpdir(), 'dsh-no-such-bin-' + Date.now())), pathValue)
})
