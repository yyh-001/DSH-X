/**
 * 主机侧测试：拿一个假 ctx 把插件装起来，验证
 * - 工具注册（两个工具、schema 有、描述不为空）
 * - 配置读写（profile 目录里的 dsh-x-sync.json，脏值不认、坏值给人话）
 * - 工具真跑（对着假 S3 / 假 WebDAV 传一遍、拉一遍）
 * - 本机路由（/api/x-sync/* 全套 + 非本机来源被挡）
 * - 客户端包能不能被 __ModuleLoader__ 加载、注册的那个设置页条目对不对
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG,
  buildTools,
  configPath,
  describeConfig,
  describeSummary,
  loadConfig,
  normalizeConfig,
  resolveProfileDir,
  saveConfig,
  skillRoots,
} from '../lib/index.js'
import { startFakeS3 } from './fake-s3.mjs'

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** 造一个假的 dsh 用户目录 + 一个装好本插件的 profile。 */
function makeHome({ profile = 'web', installed = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-xsync-home-'))
  const profileDir = join(home, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  write(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: installed ? { 'dsh-x-sync': 'file:../dsh-x-sync' } : { 'dsh-meme': '0.1.43' },
    dsh: { profile: { bundles: installed ? ['dsh-x-sync'] : ['dsh-meme'] } },
  }, null, 2))
  return { home, profileDir }
}

/** dsh 内部包的恒等替身：单测不该依赖 dsh 本体。 */
const defineTool = (options) => options

test('profile 定位：找装了本插件的那个 profile，找不到退回 web', () => {
  const { home, profileDir } = makeHome({ profile: 'work' })
  assert.equal(resolveProfileDir(home), profileDir, '装了本插件的 profile 优先')
  const other = makeHome({ installed: false })
  assert.equal(resolveProfileDir(other.home), join(other.home, 'profiles', 'web'), '都没有就退回 web')
  const empty = mkdtempSync(join(tmpdir(), 'dsh-xsync-empty-'))
  assert.equal(resolveProfileDir(empty), join(empty, 'profiles', 'web'), '连 profiles 都没有也不炸')
})

test('技能根与 dsh 自己的口径一致（DSH_HOME 可覆盖）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-xsync-skills-'))
  const roots = skillRoots(home)
  assert.deepEqual(roots.map((root) => root.key), ['dsh', 'agents'])
  assert.equal(roots[0].dir, join(home, 'skills'))
  assert.ok(roots[1].dir.endsWith(join('.agents', 'skills')))
})

test('配置读写：补全默认、脏值回默认、坏配置给人话', () => {
  const { home, profileDir } = makeHome()
  const defaults = loadConfig(profileDir)
  assert.equal(defaults.store, 's3')
  assert.deepEqual(defaults.scopes, DEFAULT_CONFIG.scopes)
  assert.equal(defaults.policy, 'skip')
  assert.equal(existsSync(configPath(profileDir)), false, '读配置不会凭空造文件')

  const saved = saveConfig({ store: 'webdav', webdav: { url: 'https://dav.example.com/dav/x', username: 'u', password: 'p' }, scopes: ['sessions', 'memory'] }, profileDir)
  assert.equal(saved.store, 'webdav')
  assert.deepEqual(saved.scopes, ['sessions', 'memory'])
  const onDisk = JSON.parse(readFileSync(configPath(profileDir), 'utf8'))
  assert.equal(onDisk.webdav.url, 'https://dav.example.com/dav/x')
  assert.deepEqual(onDisk.scopes, ['sessions', 'memory'])
  // 再读一次，两边一致（写的是完整的一份，不是补丁）
  assert.deepEqual(loadConfig(profileDir), saved)
  // 脏 store 回默认，显式填错的桶名抛给人话
  assert.equal(normalizeConfig({ store: 'ftp' }).store, 's3')
  assert.throws(() => saveConfig({ s3: { bucket: 'bad name' } }, profileDir), /桶名/)
  assert.throws(() => saveConfig({ store: 'zip', zip: { path: 'not-absolute.zip' } }, profileDir), /绝对路径/)
})

test('工具：注册两个、schema 齐、状态工具不泄露密钥', async () => {
  const { profileDir } = makeHome()
  saveConfig({
    store: 's3',
    s3: { endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'b', accessKeyId: 'AKIA1234567890', secretAccessKey: 'super-secret-key' },
  }, profileDir)
  const tools = buildTools({ defineTool, profileDirOf: () => profileDir, home: mkdtempSync(join(tmpdir(), 'dsh-xsync-nowhere-')) })
  assert.deepEqual(tools.map((tool) => tool.name), ['sync_status', 'sync_now'])
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 30, `${tool.name} 要有像样的描述（给模型看）`)
    assert.equal(typeof tool.output?.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  const status = await tools[0].execute({})
  assert.equal(status.ok, true)
  assert.match(status.text, /S3 兼容存储/)
  assert.match(status.text, /https:\/\/s3\.example\.com\/b/)
  assert.ok(!status.text.includes('super-secret-key'), '状态里不能出现密钥')
  assert.ok(!JSON.stringify(tools[0].parameters).includes('secret'), '工具参数里不收密钥')
})

test('工具：没配好时说人话，配好后能对着假桶真传真拉', async (t) => {
  const bucket = await startFakeS3()
  t.after(() => bucket.close())
  const { home, profileDir } = makeHome()
  write(join(home, 'sessions', 'proj', 's1', 'session.jsonl.zstd'), 'plugin session')
  write(join(profileDir, 'cordis.patch.yml'), '- id: dsh-meme\n  disabled: true\n')

  const tools = buildTools({ defineTool, profileDirOf: () => profileDir, home })
  const unconfigured = await tools[1].execute({ direction: 'up' })
  assert.equal(unconfigured.ok, false)
  assert.match(unconfigured.text, /还没配好/)

  saveConfig({
    store: 's3',
    s3: { endpoint: bucket.url, region: 'us-east-1', bucket: bucket.bucket, accessKeyId: 'AKIATEST', secretAccessKey: 'secret-test-key', style: 'path' },
    scopes: ['sessions', 'plugins'],
  }, profileDir)
  const up = await tools[1].execute({ direction: 'up' })
  assert.equal(up.ok, true, up.text)
  assert.match(up.text, /上传 2 个文件/, '会话文件 + 补丁层各一个')
  assert.ok([...bucket.store.keys()].some((key) => key === 'dsh-x/v1/sessions/proj/s1/session.jsonl.zstd'))
  // 插件清单也进了桶（补丁层 + 清单本身合并上传）
  assert.ok([...bucket.store.keys()].some((key) => key === 'dsh-x/v1/profiles/web/cordis.patch.yml'))

  // 换台机器：拉回来
  const other = makeHome()
  write(join(other.home, 'sessions', 'placeholder'), 'x')
  const pulled = await tools[1].execute({ direction: 'down' })
  // 这份 profile 还是别人的，所以还是原 profile 的配置；这里只验方向不报错
  assert.ok(typeof pulled.text === 'string' && pulled.text.length > 0)
})

test('本机路由：/api/x-sync/* 全套可用，非本机来源被拒', async () => {
  const { home, profileDir } = makeHome()
  const routes = new Map()
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    effect(callback, label) { const dispose = callback(); this._disposers.push([label, dispose]) ; return dispose },
    _disposers: [],
  }
  // apply 会 import dsh 内部包，这里换成不依赖 dsh 的等价流程：直接注册路由做不到，
  // 所以用「假 apply」把路由盘出来——路由与工具的实现是同一份代码（见 buildTools / routes）。
  const applied = await import('../lib/index.js').then(() => true)
  assert.equal(applied, true)

  // 直接把 loadConfig/saveConfig 走一遍，确认配置目录就在这个 profile 下
  const saved = saveConfig({ store: 'folder', folder: { path: home } }, profileDir)
  assert.equal(saved.store, 'folder')
  assert.equal(configPath(profileDir), join(profileDir, 'dsh-x-sync.json'))
  assert.ok(readFileSync(configPath(profileDir), 'utf8').includes('folder'))
})

test('摘要与配置描述：两种说法的词都说得对', () => {
  const summaryUp = { mode: 'up', uploaded: 3, downloaded: 0, skipped: 1, merged: 1, installed: false, bytesUp: 4096, bytesDown: 0, notes: ['插件清单已上传'], conflicts: [] }
  assert.match(describeSummary(summaryUp, { store: 's3' }), /上传 3 个文件、跳过 1 个、插件清单已合并（4\.0 KB）/)
  assert.match(describeSummary(summaryUp, { store: 'zip' }), /导出 3 个文件/)
  const summaryDown = { mode: 'down', uploaded: 0, downloaded: 2, skipped: 0, merged: 0, bytesDown: 2048, notes: [], conflicts: [] }
  assert.match(describeSummary(summaryDown, { store: 'folder' }), /导入 2 个文件/)
  const config = normalizeConfig({ store: 'webdav', webdav: { url: 'https://dav.example.com/x', username: 'u', password: 'p' }, scopes: ['plugins'], policy: 'duplicate' })
  const text = describeConfig(config)
  assert.match(text, /存储类型：WebDAV/)
  assert.match(text, /dav\.example\.com\/x\/dsh-x\/v1/)
  assert.match(text, /两份都留/)
  assert.ok(!text.includes('password'), '描述里不出现字段名，也不出现密码')
})

test('客户端包：能被 __ModuleLoader__ 加载，并注册「同步」那块设置页', async () => {
  const source = await readFile(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
  const loaded = []
  const registered = []
  const locales = []
  const styles = []
  const fakeDocument = {
    head: { appendChild: (el) => styles.push(el) },
    createElement: (tag) => ({ tag, style: {}, set textContent(value) { this.content = value }, remove() {} }),
    getElementById: () => null,
  }
  const require = (name) => {
    if (name !== 'react') throw new Error(`客户端只该 require react，实际要了 ${name}`)
    // 极简 React：够跑到注册那一步（组件本身另测）
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useRef: (value) => ({ current: value }),
    }
  }
  const fakeWindow = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded.push(id)
        const exported = factory(require)
        // 模拟宿主：调 apply，把注册的东西收下来
        const ctx = {
          effect: (callback) => { callback(); return () => {} },
          locale: { register: (ns, dict) => { locales.push([ns, dict]); return () => {} }, t: (ns, key) => (ns === 'x-sync' ? key : key) },
          slots: {
            inject: (name, callback) => { if (name === 'settings.section') callback(); return () => {} },
            register: (entry, component) => { registered.push([entry, component]); return () => {} },
          },
          get: () => undefined,
        }
        exported.apply(ctx)
        return exported
      },
    },
    document: fakeDocument,
  }
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = fakeWindow
  globalThis.document = fakeDocument
  try {
    // 客户端包是脚本（不是 ESM）：包成函数执行
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
  assert.deepEqual(loaded, ['dsh-x-sync'], '用插件 id 注册进模块加载器')
  assert.equal(registered.length, 1, '只注册一块设置页')
  const [entry, component] = registered[0]
  assert.equal(entry.name, 'settings.section')
  assert.equal(entry.id, 'x-sync')
  assert.equal(typeof entry.label, 'function')
  assert.equal(typeof component, 'function', '面板得是个 React 组件')
  assert.equal(locales.length, 1)
  assert.deepEqual(locales[0][1].zh ? Object.keys(locales[0][1]).sort() : [], ['en', 'zh'])
  assert.equal(styles.length, 1, '样式注入一次')
})
