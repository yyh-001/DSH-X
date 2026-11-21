import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const page = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/public/launcher.css', import.meta.url), 'utf8')
const section = (from, to) => page.slice(page.indexOf(from), page.indexOf(to, page.indexOf(from)))
const helpers = section('    const normalizeHomePath =', '    const sameHomePath =')
const pluginHomeName = section('    function pluginHomeName(', '    function paintPluginHomes()')

/** 只装取名字这段：state.dshHomeNames 就是设置里登记过的「目录 → 显示名」。 */
function namer(names) {
  const context = vm.createContext({ state: { dshHomeNames: names } })
  vm.runInContext(helpers + pluginHomeName, context)
  return context.pluginHomeName
}

const home = 'C:\\Users\\weini\\AppData\\Roaming\\DSH\\data\\homes\\dsh1\\0.2.2-rc.3'

test('目录名被登记成路径时当作没名字，交给调用方的短名兜底（#122）', () => {
  const pluginHomeName = namer({ [home]: home })
  assert.equal(pluginHomeName(home, ''), '', '路径同名不该当显示名')
  assert.equal(pluginHomeName(home, '兜底'), '兜底')
  // 大小写、斜杠方向不同也算同一个路径
  const other = namer({ [home]: home.replaceAll('\\', '/').toUpperCase() })
  assert.equal(other(home, ''), '')
})

test('正常登记的名字照旧返回', () => {
  const pluginHomeName = namer({ [home]: '我的项目' })
  assert.equal(pluginHomeName(home, ''), '我的项目')
  assert.equal(pluginHomeName(home.toLowerCase(), '兜底'), '我的项目', '比较路径不分大小写')
})

test('没登记过的目录用调用方兜底', () => {
  const pluginHomeName = namer({})
  assert.equal(pluginHomeName(home, ''), '')
  assert.equal(pluginHomeName(home, '全局目录'), '全局目录')
})

test('重命名目录的建议名不再拿路径预填', () => {
  const line = page.slice(page.indexOf('let proposed = homeName ?'), page.indexOf('\n', page.indexOf('let proposed = homeName ?')))
  assert.match(line, /folderBaseName\(source\)/, '目录没名字时建议名取最后一段')
  assert.doesNotMatch(line, /pluginHomes\(\)\.get\(source\)/, '别再拿 homeOptions 的原始值（可能是路径）当名字')
})

test('启动项卡片行允许收缩，长文本走省略号而不是把按钮顶出卡片', () => {
  const rule = css.slice(css.indexOf('.launch-preset {'), css.indexOf('\n', css.indexOf('.launch-preset {')))
  assert.match(rule, /min-width: 0;?/, '.launch-preset 是 grid 子项，min-width:auto 会被超长路径撑开')
})
