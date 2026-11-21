import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/** 读取前端英文词典源码（已从 index.html 拆到 src/public/i18n-en.js）。 */
export function readEnSource() {
  return readFileSync(new URL('../../src/public/i18n-en.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
}

/** 解析英文词典对象，供各页面单测校验文案覆盖。 */
export function readEnDict() {
  const source = readEnSource()
  const match = source.match(/const EN = (\{[\s\S]*?\n\})/)
  if (!match) throw new Error('src/public/i18n-en.js 中找不到 const EN = { ... }')
  return new vm.Script(`(${match[1]})`).runInNewContext({})
}
