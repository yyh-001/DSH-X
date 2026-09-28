/**
 * 一只够用的假 WebDAV：PROPFIND（Depth 0/1）/ MKCOL / PUT / GET + Basic 认证。
 * 用来在没有真实网盘的情况下把整条 WebDAV 链路跑通。
 *
 * 故意写得「像真的服务端」一点，踩中的坑都在这里复现：
 * - XML 里混用命名空间前缀（`D:` / `d:` / 不带前缀），客户端必须按本地名解析；
 * - href 是 URL 编码过的、相对服务端的路径；
 * - MKCOL 已存在返回 405、PUT 到不存在的父目录返回 409（客户端要先建目录）；
 * - 可选地「前几次写请求返回 503」，用来验证客户端的重试。
 */
import { createServer } from 'node:http'

const xmlEscape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function webdavErrorXml(status) {
  const labels = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 503: 'Service Unavailable' }
  return `<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:message>${labels[status] || status}</d:message></d:error>`
}

/**
 * 起一只假 WebDAV。basePath 是「用户填的那个目录」，所有内容都在它下面。
 * 返回 { url, files, mkcols, requests, close }。
 */
export async function startFakeWebdav({
  username = 'davuser',
  password = 'dav-pass',
  basePath = '/dav/notes',
  failFirstWrites = 0,
} = {}) {
  const files = new Map()   // path → { body, at }
  const dirs = new Set()    // MKCOL 建出来的空目录（有文件的目录是隐含的）
  const requests = []
  const mkcols = []
  let writeFailuresLeft = failFirstWrites
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`

  // 用户填的那个目录本身永远存在，其余按「有文件 / MKCOL 过 / 有子目录」判断
  const exists = (path) => path === '' || files.has(path) || dirs.has(path)
    || [...files.keys()].some((key) => key.startsWith(`${path}/`))
    || [...dirs].some((key) => key.startsWith(`${path}/`))
  const children = (path) => {
    const prefix = path === '' ? '' : `${path}/`
    const out = new Map()
    for (const key of [...files.keys(), ...dirs]) {
      if (!key.startsWith(prefix) || key === path) continue
      const rest = key.slice(prefix.length)
      const head = rest.split('/')[0]
      const isCollection = rest.includes('/') || dirs.has(key)
      const childPath = `${prefix}${head}`
      if (!out.has(childPath)) out.set(childPath, { path: childPath, isCollection, size: 0, at: 0 })
      if (!isCollection) out.get(childPath).size = files.get(childPath).body.length
      if (!isCollection) out.get(childPath).at = files.get(childPath).at
    }
    return [...out.values()]
  }

  const multistatus = (entries) => [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:multistatus xmlns:D="DAV:">',
    ...entries.map((entry) => [
      '  <D:response>',
      `    <D:href>${xmlEscape(encodeURI(entry.path))}</D:href>`,
      '    <D:propstat>',
      '      <d:prop xmlns:d="DAV:">',
      entry.isCollection ? '        <d:resourcetype><d:collection/></d:resourcetype>' : '        <resourcetype/>',
      `        <d:getcontentlength>${entry.size || 0}</d:getcontentlength>`,
      entry.at ? `        <d:getlastmodified>${new Date(entry.at).toUTCString()}</d:getlastmodified>` : '        <getlastmodified></getlastmodified>',
      '      </d:prop>',
      '      <d:status>HTTP/1.1 200 OK</d:status>',
      '    </D:propstat>',
      '  </D:response>',
    ].join('\n')),
    '</D:multistatus>',
  ].join('\n')

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url, 'http://127.0.0.1')
      const record = { method: req.method, path: url.pathname, depth: req.headers.depth || '', body }
      requests.push(record)
      const send = (status, text = '', type = 'application/xml; charset=utf-8', headers = {}) => {
        res.writeHead(status, { 'content-type': type, ...headers })
        res.end(text)
      }
      const authorized = req.headers.authorization === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      if (!authorized) {
        return send(401, webdavErrorXml(401), undefined, { 'www-authenticate': 'Basic realm="fake"' })
      }
      // 路径必须在用户填的那个目录下
      const rawPath = decodeURIComponent(url.pathname)
      if (!rawPath.startsWith(base) && rawPath.replace(/\/$/, '') !== base.replace(/\/$/, '')) {
        return send(404, webdavErrorXml(404))
      }
      const rel = rawPath.slice(base.length).replace(/\/+$/, '')
      const isCollectionUrl = url.pathname.endsWith('/')

      if (req.method === 'PROPFIND') {
        const depth = req.headers.depth === '0' ? 0 : 1
        if (rel !== '' && !isCollectionUrl && files.has(rel)) {
          return send(207, multistatus([{ path: rel, isCollection: false, size: files.get(rel).body.length, at: files.get(rel).at }]))
        }
        if (!exists(rel)) return send(404, webdavErrorXml(404))
        const entries = [{ path: rel, isCollection: true, size: 0, at: 0 }]
        if (depth === 1) entries.push(...children(rel))
        return send(207, multistatus(entries))
      }
      if (req.method === 'MKCOL') {
        if (files.has(rel) || dirs.has(rel)) return send(405, webdavErrorXml(405))
        const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
        if (parent && !exists(parent)) return send(409, webdavErrorXml(409))
        dirs.add(rel)
        mkcols.push(rel)
        return send(201, '')
      }
      if (req.method === 'PUT') {
        if (writeFailuresLeft > 0) {
          writeFailuresLeft -= 1
          return send(503, webdavErrorXml(503))
        }
        const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
        if (parent && !exists(parent)) return send(409, webdavErrorXml(409))
        if (Number(req.headers['content-length']) !== body.length) {
          return send(400, webdavErrorXml(400))
        }
        files.set(rel, { body, at: Date.now() })
        return send(201, '')
      }
      if (req.method === 'GET') {
        const file = files.get(rel)
        if (!file) return send(404, webdavErrorXml(404))
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(file.body.length) })
        return res.end(file.body)
      }
      return send(405, webdavErrorXml(405))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}${basePath}`,
    basePath: base,
    files,
    dirs,
    mkcols,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
