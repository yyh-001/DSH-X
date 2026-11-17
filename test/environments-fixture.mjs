/**
 * 环境（Environment）/ Profile 拆分系列测试的公共件：会记账的假 dsh、假 npm registry（插件包）、
 * Profile 目录播种与快照。
 *
 * 为什么单独成文件：四份环境测试各起一个进程内真服务（模块级状态，只能一个文件一套夹具），
 * 但「假 dsh 怎么记账」「插件包从哪解析」这些驱动件是同一套，写一遍。
 * 这里只描述「怎么驱动系统」，不含任何对实现的预期——预期都写在各用例里，只来自需求。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, relative } from 'node:path'

export const BASE = '@deepseek-ai/dsh-base'
export const WEB = '@deepseek-ai/dsh-web-app'
export const ENV_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

/**
 * 假 dsh：每次被拉起都往 DSH_HOME/calls.jsonl 记一行（插件命令还是启动、argv、
 * 当时 profile 的 package.json 原文），用来验「写清单 → 装依赖 → 启动」的先后与次数。
 *   - `plugin …`：退出码取 DSH_HOME/plugin-exit 的内容（没有这个文件就是 0），非 0 时打一行像样的报错。
 *   - 启动：打印真实格式的就绪地址并真的监听端口（服务端据此标成 running）；GET /exit 让它自己退出（模拟意外退出）。
 */
export function recordingBin(version) {
  return `import { createServer } from 'node:http'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.DSH_HOME
const argv = process.argv.slice(2)
const plugin = argv[0] === 'plugin'
const at = argv.indexOf('--profile')
const profile = at >= 0 ? argv[at + 1] : argv[0]
const file = join(home, 'profiles', profile, 'package.json')
const manifest = existsSync(file) ? readFileSync(file, 'utf8') : null
appendFileSync(join(home, 'calls.jsonl'), JSON.stringify({ kind: plugin ? 'plugin' : 'boot', version: ${JSON.stringify(version)}, profile, argv, manifest, at: Date.now() }) + '\\n')
if (plugin) {
  const control = join(home, 'plugin-exit')
  const code = existsSync(control) ? Number(readFileSync(control, 'utf8').trim()) || 0 : 0
  if (code) console.error('ERR_FAKE_INSTALL fake plugin command failed on purpose')
  process.exit(code)
}
const server = createServer((req, res) => {
  if (req.url === '/exit') { res.end('bye'); setTimeout(() => process.exit(0), 20); return }
  res.end('fake dsh ${version}')
})
const portAt = argv.indexOf('--port')
server.listen(portAt >= 0 ? Number(argv[portAt + 1]) : 0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=fake'))
`
}

/** DSH_HOME/calls.jsonl 解析成数组；可按 profile 过滤。 */
export function readCalls(home, profile) {
  const file = join(home, 'calls.jsonl')
  if (!existsSync(file)) return []
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return profile ? rows.filter((row) => row.profile === profile) : rows
}
/** 只看 `dsh plugin … install`（装依赖）那一类调用。 */
export const installCalls = (home, profile) => readCalls(home, profile).filter((row) => row.kind === 'plugin' && row.argv.includes('install'))
export const bootCalls = (home, profile) => readCalls(home, profile).filter((row) => row.kind === 'boot')

/** 让假 dsh 的插件命令按这个退出码结束（0 = 恢复正常）。 */
export function setPluginExit(home, code) {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'plugin-exit'), String(code))
}

export const profileDir = (home, profile) => join(home, 'profiles', profile)
export const profileManifestPath = (home, profile) => join(profileDir(home, profile), 'package.json')

/**
 * 在某个 dsh 用户目录里播一份 Profile。manifest 是对象时按「怪格式」写出（4 空格缩进、无结尾换行），
 * 这样「原样还原」「没被改写」能按字节判断，重新序列化一遍就会露馅；传字符串则原样写。
 */
export function seedProfile(home, profile, manifest) {
  const dir = profileDir(home, profile)
  mkdirSync(dir, { recursive: true })
  const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 4)
  writeFileSync(join(dir, 'package.json'), text)
  return dir
}

/** 一份普通的 Profile 清单：带上几个「不属于插件列表」的字段，用来验它们原样保留。 */
export function profileManifest(profile, { dependencies = {}, bundles = [BASE, WEB], extra = {} } = {}) {
  return {
    name: `dsh-profile-${profile}`,
    private: true,
    marker: `keep-${profile}`,
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
    pnpm: { overrides: { 'left-pad': '1.3.0' } },
    dsh: { profile: { bundles, patchReload: true } },
    ...extra,
  }
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** 目录里每个文件的 sha256（相对路径 → 摘要），跳过 node_modules。 */
export function snapshotDir(dir) {
  const out = {}
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (statSync(path).isFile()) out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

export async function waitFor(predicate, why, timeout = 10000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${why}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * 假 npm registry：packages 是「包名 → { tags, versions }」。认 `/<名>`（packument）与 `/<名>/<版本或 tag>`（单版本文档），
 * 范围内找不到就 404。requests 记下每次请求解码后的路径，用来验「精确版本不联网」。
 */
export async function startPluginRegistry(packages) {
  const requests = []
  const table = new Map(Object.entries(packages).map(([name, value]) => [name.toLowerCase(), { name, ...value }]))
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
    requests.push(path)
    const parts = path.split('/')
    const name = (parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]).toLowerCase()
    const rest = parts.slice(parts[0].startsWith('@') ? 2 : 1).join('/')
    const pkg = table.get(name)
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (!pkg) return json(404, { error: 'not found' })
    const doc = (version) => ({ name: pkg.name, version, dist: { tarball: `http://127.0.0.1/${pkg.name}-${version}.tgz` } })
    if (!rest) {
      return json(200, { name: pkg.name, 'dist-tags': pkg.tags, versions: Object.fromEntries(pkg.versions.map((version) => [version, doc(version)])) })
    }
    const version = pkg.tags[rest] || (pkg.versions.includes(rest) ? rest : '')
    if (!version) return json(404, { error: 'version not found' })
    return json(200, doc(version))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    /** 这个包有没有被问过（不分大小写）。 */
    asked: (name) => requests.some((path) => path.toLowerCase() === name.toLowerCase() || path.toLowerCase().startsWith(`${name.toLowerCase()}/`)),
    /** 换掉某个包的版本表（模拟作者发了新版）。 */
    publish(name, value) { table.set(name.toLowerCase(), { name, ...value }) },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
