/**
 * 桌面端系统开关（shell/prefs.mjs）：外壳直接读核心写的 settings.json，脏值 / 缺字段 /
 * 写了一半的文件都必须落回安全的默认值——这些开关会决定硬件加速、关窗口和防休眠。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PREF_DEFAULTS, parsePrefs, readPrefs } from '../shell/prefs.mjs'

test('缺字段时回默认：硬件加速 / 通知 / 托盘 / 电脑操作默认开，自动更新 / 防休眠 / 忽略证书默认关', () => {
  assert.deepEqual(parsePrefs({}), { ...PREF_DEFAULTS })
  assert.equal(PREF_DEFAULTS.hardwareAcceleration, true)
  assert.equal(PREF_DEFAULTS.taskNotifications, true)
  assert.equal(PREF_DEFAULTS.closeToTray, true)
  assert.equal(PREF_DEFAULTS.autoUpdate, false)
  assert.equal(PREF_DEFAULTS.keepAwake, false)
  assert.equal(PREF_DEFAULTS.reduceMotion, false)
  assert.equal(PREF_DEFAULTS.browserIgnoreCertificate, false)
  assert.equal(PREF_DEFAULTS.computerUse, true)
})

test('只认布尔语义：true 型不会把脏值当成开，false 型不会被字符串关掉', () => {
  const prefs = parsePrefs({
    hardwareAcceleration: 'no',
    autoUpdate: 'true',
    taskNotifications: 0,
    notificationSound: 'false',
    closeToTray: null,
    keepAwake: {},
    reduceMotion: 'true',
    browserIgnoreCertificate: 'yes',
    computerUse: 'no',
  })
  assert.equal(prefs.hardwareAcceleration, true, "'no' 不是 false，按默认开")
  assert.equal(prefs.autoUpdate, false, "'true' 字符串不算 true")
  assert.equal(prefs.taskNotifications, true, '0 不算 false')
  assert.equal(prefs.notificationSound, true, "'false' 字符串不算 false")
  assert.equal(prefs.closeToTray, true, 'null 不算 false')
  assert.equal(prefs.keepAwake, false, '对象不算 true')
  assert.equal(prefs.reduceMotion, false)
  assert.equal(prefs.browserIgnoreCertificate, false, "'yes' 不算 true")
  assert.equal(prefs.computerUse, true, "'no' 不是 false，按默认开")
})

test('显式布尔值原样生效', () => {
  const prefs = parsePrefs({
    hardwareAcceleration: false,
    autoUpdate: true,
    taskNotifications: false,
    notificationSound: false,
    closeToTray: false,
    keepAwake: true,
    reduceMotion: true,
    browserIgnoreCertificate: true,
    computerUse: false,
  })
  assert.deepEqual(prefs, {
    hardwareAcceleration: false,
    autoUpdate: true,
    taskNotifications: false,
    notificationSound: false,
    closeToTray: false,
    keepAwake: true,
    reduceMotion: true,
    browserIgnoreCertificate: true,
    computerUse: false,
  })
})

test('readPrefs：文件不存在、内容坏了都回默认值，不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-x-prefs-'))
  try {
    assert.deepEqual(readPrefs(join(dir, 'missing.json')), { ...PREF_DEFAULTS })
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ "hardwareAcceleration": false')
    assert.deepEqual(readPrefs(broken), { ...PREF_DEFAULTS }, '写了一半的文件不能当开关生效')
    const ok = join(dir, 'ok.json')
    writeFileSync(ok, JSON.stringify({ hardwareAcceleration: false, keepAwake: true }))
    const prefs = readPrefs(ok)
    assert.equal(prefs.hardwareAcceleration, false)
    assert.equal(prefs.keepAwake, true)
    assert.equal(prefs.closeToTray, true, '没写的字段仍回默认')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
