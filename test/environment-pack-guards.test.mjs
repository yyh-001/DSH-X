import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { gzipSync, gunzipSync } from 'node:zlib'
import test from 'node:test'
import { installedSatisfies, sensitiveTarballFiles, tarballFiles } from '../src/environment-pack.js'
import { makeTgz } from './environment-pack-fixture.mjs'

test('导出钉版：认不出的范围不能当成 tag，不能复用范围外的实装版本', () => {
  for (const spec of ['1.0.0 - 2.0.0', '>= 1.0.0 < 2.0.0', '~ 1.2.0', 'not a tag', '^broken']) {
    assert.equal(installedSatisfies('9.9.9', spec), false, spec)
  }
  assert.equal(installedSatisfies('1.5.0', '^1.0.0'), true)
  assert.equal(installedSatisfies('9.9.9', '^1.0.0'), false)
  assert.equal(installedSatisfies('1.2.3', 'v1.2.3'), true)
  assert.equal(installedSatisfies('9.9.9', 'v1.2.3'), false)
  assert.equal(installedSatisfies('1.5.0-beta.1', '^1.0.0'), false)
  assert.equal(installedSatisfies('1.5.0-beta.1', 'next'), true)
  assert.equal(installedSatisfies('1.5.0', 'latest'), true)
  assert.equal(installedSatisfies('1.5.0', 'canary-2026'), true)
  assert.equal(installedSatisfies('not-a-version', 'next'), false)
})

test('tar 扫描：负数 / 非八进制长度和截断内容都报错，不能卡住主线程', () => {
  // 同步死循环无法被 node:test 的 timeout 中断，放进可杀掉的子进程，退化时测试也会有界结束。
  const moduleUrl = new URL('../src/environment-pack.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { gzipSync } from 'node:zlib'
    import { tarballFiles } from ${JSON.stringify(moduleUrl)}
    for (const type of ['x', 'g', 'L', '0']) {
      for (const size of ['-1000', '-2000', '8', '1junk', '77777777777']) {
        const header = Buffer.alloc(512)
        header.write('package/file')
        header.write(size, 124)
        header.write(type, 156)
        assert.throws(() => tarballFiles(gzipSync(header)), /tar/, type + ':' + size)
      }
    }
    const header = Buffer.alloc(512)
    header.write('package/file')
    header.write('1', 124)
    assert.throws(() => tarballFiles(gzipSync(header)), /tar/, '缺少内容')
    assert.throws(() => tarballFiles(gzipSync(Buffer.concat([header, Buffer.from('x')]))), /tar/, '缺少块填充')
    assert.throws(() => tarballFiles(gzipSync(Buffer.from('truncated header'))), /tar/, '缺少完整头')
  `], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.error, undefined, `子进程必须正常结束：${result.error?.message}`)
  assert.equal(result.status, 0, result.stderr)
})

test('tar 扫描：零长度和跨块文件照常扫描，pax / GNU 长名后的凭据仍会提示', () => {
  assert.deepEqual(tarballFiles(makeTgz({ 'package/empty': '', 'package/index.js': 'x'.repeat(513) })), ['empty', 'index.js'])
  for (const type of ['x', 'L']) {
    const name = `package/${'long/'.repeat(25)}.env`
    const body = type === 'x' ? `${Buffer.byteLength(name) + 10} path=${name}\n` : `${name}\0`
    const extension = gunzipSync(makeTgz({ extension: body })).subarray(0, 1024)
    extension.write(type, 156)
    extension.fill(0x20, 148, 156)
    const checksum = extension.subarray(0, 512).reduce((sum, byte) => sum + byte, 0)
    extension.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    const actual = gunzipSync(makeTgz({ 'package/placeholder': 'secret' }))
    const tgz = gzipSync(Buffer.concat([extension, actual]))
    assert.deepEqual(sensitiveTarballFiles(tgz), [name.slice('package/'.length)], type)
  }
})
