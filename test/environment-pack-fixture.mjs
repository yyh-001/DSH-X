/**
 * 环境文件（导入 / 导出，第二期）系列测试的驱动件：造包、造 tarball、假 npm registry（带真 tarball）、
 * 假 GitHub（https 源站 + CONNECT 代理）、假市场索引 / 直链站。
 *
 * 为什么单独成文件：导入、导出两份系统测试和纯规则测试都要「造一个 .dspack」「读回一个 .dspack」，
 * 导入导出还要同一套离线假服务。这里只描述「怎么驱动系统」，不含任何对实现的预期——预期都写在用例里，只来自需求。
 *
 * 注意：这里不 import 任何会在导入时定下 APP_DIR 的模块（filemanager / settings / server），
 * 只用 zip.js 这种纯字节层；用例文件要先隔离 HOME 再动态导入业务模块。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect } from 'node:net'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { readZip, writeZip } from '../src/zip.js'

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const sha512b64 = (data) => createHash('sha512').update(data).digest('base64')
const sha1 = (data) => createHash('sha1').update(data).digest('hex')

/** 一份最小的 v5 清单：用例在它上面改字段（展开覆盖），字段名照 PackForge manifest v5。 */
export function baseManifest(patch = {}) {
  return {
    manifestVersion: 5,
    type: 'profile',
    name: 'demo-env',
    version: '1.0.0',
    displayName: '演示环境',
    description: '测试用的环境文件',
    dshVersion: '1.1.0',
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-x-foo'],
    dependencies: { 'dsh-x-foo': '1.0.0' },
    ...patch,
  }
}

/** 包里的条目：dspack.json 标记 + manifest.json + 额外文件（路径 → 内容）。 */
function packEntries(manifest, files = {}, { marker = true } = {}) {
  return [
    ...(marker ? [{ name: 'dspack.json', data: `${JSON.stringify({ format: 'dspack', version: 3 }, null, 2)}\n` }] : []),
    { name: 'manifest.json', data: typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n` },
    ...Object.entries(files).map(([name, data]) => ({ name, data })),
  ]
}

/** 内存里的 .dspack（ZIP）。 */
export const packBuffer = (manifest, files, options) => writeZip(packEntries(manifest, files, options))

/** 写一个 .dspack 文件，返回路径。 */
export function writePackFile(file, manifest, files, options) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, packBuffer(manifest, files, options))
  return file
}

/** 写一个目录形态的包（作者本地调试 / 仓库目录就是这个形态），返回目录。 */
export function writePackDir(dir, manifest, files = {}) {
  for (const entry of packEntries(manifest, files)) {
    const file = join(dir, entry.name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, entry.data)
  }
  return dir
}

/** 读回一个 .dspack：条目名 → Buffer。 */
export function readPack(buffer) {
  const { entries } = readZip(buffer)
  return new Map(entries.map((entry) => [entry.name, entry.data]))
}

/** 读一个目录里的全部文件（相对路径，/ 分隔 → Buffer）。 */
export function readTree(dir) {
  const out = new Map()
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (statSync(path).isFile()) out.set(relative(dir, path).split(/[\\/]/).join('/'), readFileSync(path))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

/** 改包里的一个条目再写回（用来模拟「包被人动过」）。 */
export function tamperPack(buffer, name, data) {
  const { entries } = readZip(buffer)
  return writeZip(entries.map((entry) => (entry.name === name ? { name, data } : entry)))
}

// ---------------------------------------------------------------- tarball（npm pack 的格式：ustar + gzip，根目录 package/）

function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write(`${Math.floor(Date.UTC(2026, 0, 1) / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

/** 路径 → 内容 打成 .tgz（路径照 npm 的习惯写 package/…）。 */
export function makeTgz(files) {
  const chunks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content))
    chunks.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512, 0))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(chunks))
}

/** 读 .tgz：条目名 → 内容（认 ustar 的 prefix 字段，跳过 pax 头）。 */
export function readTgz(buffer) {
  const tar = gunzipSync(buffer)
  const out = new Map()
  let offset = 0
  let paxName = ''
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1) || '0'
    const prefix = field(345, 155)
    const name = paxName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    const data = tar.subarray(offset + 512, offset + 512 + size)
    paxName = ''
    if (type === 'x') {
      const path = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
      if (path) paxName = path[1]
    } else if (type === '0' || type === '') {
      out.set(name, Buffer.from(data))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

/**
 * 需求里离线文件导入后的位置：<APP_DIR>/envs/<id>/files/<内容 sha256 前 8 位>/<文件名>。
 * 按内容分子目录：同名不同内容（作者改了本地插件没改版本号）各放各的。
 */
export function extractedOfflinePath(appDir, id, file, digest) {
  return join(appDir, 'envs', id, 'files', digest.slice(0, 8), file.replace(/^offline\//, ''))
}

/** 一个本地插件目录（npm 包的形状），可以顺带放进 node_modules / .git 这类 npm pack 永远不带的东西。 */
export function writePluginDir(dir, { name, version, extra = {} }) {
  const files = {
    'package.json': `${JSON.stringify({ name, version, main: 'index.js' }, null, 2)}\n`,
    'index.js': `export default { name: ${JSON.stringify(name)} }\n`,
    ...extra,
  }
  for (const [rel, data] of Object.entries(files)) {
    const file = join(dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
  return dir
}

// ---------------------------------------------------------------- 假 npm registry（packument + 真 tarball）

/**
 * packages：包名 → { tags, versions: [版本], tarballs?: { 版本: Buffer } }。
 * 有 tarball 的版本带 dist.integrity / shasum，npm install 能真装；没有的 tarball 地址 404（不会被装）。
 * requests 记下每次请求的解码路径。
 */
export async function startNpmRegistry(packages) {
  const requests = []
  const table = new Map(Object.entries(packages).map(([name, value]) => [name.toLowerCase(), { name, tarballs: {}, ...value }]))
  let base = ''
  // 模拟「tarball 暂时下不到」：打开时一律 404（npm 不重试 404，失败来得快）
  let tarballsDown = false
  const server = createHttpServer((req, res) => {
    const path = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
    requests.push(path)
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const tarball = /^(.+)\/-\/[^/]+-([^/]+)\.tgz$/.exec(path)
    if (tarball) {
      const pkg = table.get(tarball[1].toLowerCase())
      const data = pkg?.tarballs?.[tarball[2]]
      if (!data || tarballsDown) return json(404, { error: 'no tarball' })
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length })
      res.end(data)
      return
    }
    const parts = path.split('/')
    const scoped = parts[0].startsWith('@')
    const name = (scoped ? parts.slice(0, 2).join('/') : parts[0]).toLowerCase()
    const rest = parts.slice(scoped ? 2 : 1).join('/')
    const pkg = table.get(name)
    if (!pkg) return json(404, { error: 'not found' })
    const doc = (version) => {
      const data = pkg.tarballs?.[version]
      const file = `${pkg.name.split('/').pop()}-${version}.tgz`
      return {
        name: pkg.name,
        version,
        ...(pkg.type ? { type: pkg.type } : {}),
        dist: {
          tarball: `${base}/${pkg.name}/-/${file}`,
          ...(data ? { integrity: `sha512-${sha512b64(data)}`, shasum: sha1(data) } : {}),
        },
      }
    }
    if (!rest) return json(200, { name: pkg.name, 'dist-tags': pkg.tags, versions: Object.fromEntries(pkg.versions.map((version) => [version, doc(version)])) })
    const version = pkg.tags[rest] || (pkg.versions.includes(rest) ? rest : '')
    if (!version) return json(404, { error: 'version not found' })
    return json(200, doc(version))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  return {
    url: base,
    requests,
    asked: (name) => requests.some((path) => path.toLowerCase() === name.toLowerCase() || path.toLowerCase().startsWith(`${name.toLowerCase()}/`)),
    /** 换掉（或新增）一个包的版本表：模拟作者在检查之后又发了新版。 */
    publish(name, value) { table.set(name.toLowerCase(), { name, tarballs: {}, ...value }) },
    /** tarball 下载临时坏掉 / 恢复。 */
    setTarballsDown(down) { tarballsDown = Boolean(down) },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

/** 一个能被 npm 真装上的假 dsh 包：lib/bin.js 就是传进来的脚本。 */
export function dshTarball(version, binScript) {
  return makeTgz({
    'package/package.json': `${JSON.stringify({ name: '@deepseek-ai/dsh', version, type: 'module' }, null, 2)}\n`,
    'package/lib/bin.js': binScript,
  })
}

// ---------------------------------------------------------------- 假 GitHub：https 源站 + CONNECT 代理

/**
 * 启动器取 owner/repo 的包要走 https://api.github.com 与 https://github.com（写死的地址）。
 * 离线测试的唯一办法：在设置里把代理指到这只假代理，它把所有 CONNECT 都接到本机的 https 源站
 * （仓库里那份自签证书，进程要设 NODE_TLS_REJECT_UNAUTHORIZED=0）。
 * releases：'owner/repo' → { tag, assets: [{ name, data }] }。
 */
export async function startFakeGithub(releases) {
  const pem = readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'localhost-tls.pem'), 'utf8')
  const hits = []
  const site = createHttpsServer({ cert: pem, key: pem }, (req, res) => {
    const host = String(req.headers.host || '').split(':')[0]
    const path = decodeURIComponent((req.url || '').split('?')[0])
    hits.push({ host, path })
    const api = /^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(path)
    if (api) {
      const release = releases[api[1]]
      if (!release) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"Not Found"}'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        tag_name: release.tag,
        name: release.tag,
        prerelease: false,
        assets: release.assets.map((asset) => ({
          name: asset.name,
          size: asset.data.length,
          browser_download_url: `https://github.com/${api[1]}/releases/download/${release.tag}/${asset.name}`,
        })),
      }))
      return
    }
    const download = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(path)
    const asset = download && releases[download[1]]?.assets.find((item) => item.name === download[3])
    if (asset) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': asset.data.length })
      res.end(asset.data)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const sitePort = site.address().port
  const connects = []
  const sockets = new Set()
  const proxy = createHttpServer((req, res) => { res.writeHead(502); res.end('只接 CONNECT') })
  proxy.on('connect', (req, socket, head) => {
    connects.push(req.url)
    const upstream = netConnect(sitePort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    for (const item of [socket, upstream]) {
      sockets.add(item)
      item.on('error', () => {})
      item.on('close', () => sockets.delete(item))
    }
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  return {
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    hits,
    connects,
    async close() {
      for (const socket of sockets) socket.destroy()
      for (const server of [proxy, site]) {
        server.closeAllConnections?.()
        await new Promise((resolve) => server.close(resolve))
      }
    },
  }
}

/** 一只普通 http 站：路径 → { body, type }。直链导入和市场索引都用它。 */
export async function startStaticSite(routes = {}) {
  const hits = []
  const server = createHttpServer((req, res) => {
    const path = (req.url || '').split('?')[0]
    hits.push(path)
    const route = routes[path]
    if (!route) { res.writeHead(404); res.end('not found'); return }
    const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(typeof route.body === 'string' ? route.body : JSON.stringify(route.body))
    res.writeHead(200, { 'content-type': route.type || 'application/octet-stream', 'content-length': body.length })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    hits,
    routes,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

/**
 * 装 DSH、按 npm pack 规则打本地插件都要 npm CLI。启动器只在两处找它：核心目录的 node/ 与运行时 node 旁边的
 * node_modules/npm（找不到就去 registry 下 npm，离线测试里做不到）。这里如实判断，找不到就让相关用例 skip 并说明。
 */
export function npmUnavailableReason() {
  const beside = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const bundled = join(REPO_ROOT, 'src', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(beside) || existsSync(bundled)) return false
  return `启动器找不到 npm（${beside} 与 ${bundled} 都不存在），离线装 DSH / npm pack 本地插件做不了：换一个旁边带 node_modules/npm 的 node 跑这组用例`
}
