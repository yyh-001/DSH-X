/**
 * 一个够用的假 S3：ListObjectsV2 / PUT / GET / HEAD，用来在没有真实桶的情况下把
 * 同步链路整条跑通（请求怎么拼、签名和实际请求对不对得上、翻页、错误码）。
 *
 * 服务端会独立复算一遍签名（用签名函数本身当参考实现，它已经对着 AWS 文档的例子
 * 单测过了），签错说明客户端「签的和发出去的不是同一个请求」——这是最容易出的那类错。
 */
import { createServer } from 'node:http'
import { SYNC_NAMESPACE, signV4 } from '../sync.js'

const xmlEscape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function errorXml(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`
}

/** 从 Authorization 头里拆出凭据、签名头名单和签名。 */
export function parseAuthorization(header) {
  const text = String(header || '')
  const credential = /Credential=([^,]+)/.exec(text)?.[1] || ''
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(text)?.[1] || ''
  const signature = /Signature=([0-9a-f]+)/.exec(text)?.[1] || ''
  const [accessKeyId, dateStamp, region, service] = credential.split('/')
  return { accessKeyId, dateStamp, region, service, signedHeaders: signedHeaders.split(';'), signature }
}

/**
 * 起一只假桶。返回 { url, bucket, store, requests, close }。
 * store 是 Map<key, Buffer>，可以直接断言内容。
 */
export async function startFakeS3({ accessKeyId = 'AKIATEST', secretAccessKey = 'secret-test-key', bucket = 'test-bucket', pageSize = 1000 } = {}) {
  const store = new Map()
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
      // 路径风格：第一段是桶名，其余是对象键（键里的 / 就是路径分隔符）
      const bucketName = segments[0] || ''
      const key = segments.slice(1).join('/')
      const auth = parseAuthorization(req.headers.authorization)
      const record = { method: req.method, path: url.pathname, query: url.search, key, auth, body }
      requests.push(record)
      const fail = (status, code, message) => {
        res.writeHead(status, { 'content-type': 'application/xml' })
        res.end(errorXml(code, message))
      }
      if (!req.headers.authorization) return fail(403, 'AccessDenied', 'no signature')
      if (auth.accessKeyId !== accessKeyId) return fail(403, 'InvalidAccessKeyId', 'unknown key')
      if (bucketName !== bucket) return fail(404, 'NoSuchBucket', `no bucket ${bucketName}`)
      // 复算签名：签的必须是这一个请求（签名头就是 Authorization 里报的那几个）
      const expected = signV4({
        method: req.method,
        host: req.headers.host,
        path: url.pathname,
        query: url.search.replace(/^\?/, ''),
        region: auth.region,
        service: auth.service,
        accessKeyId,
        secretAccessKey,
        sessionToken: req.headers['x-amz-security-token'] || '',
        payloadHash: req.headers['x-amz-content-sha256'],
        headers: Object.fromEntries(auth.signedHeaders
          .filter((name) => name !== 'host')
          .map((name) => [name, req.headers[name]])),
        date: new Date(req.headers['x-amz-date'].replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
          '$1-$2-$3T$4:$5:$6Z',
        )),
      })
      if (expected.signature !== auth.signature) {
        record.badSignature = { expected: expected.signature, got: auth.signature }
        return fail(403, 'SignatureDoesNotMatch', 'signature mismatch')
      }
      if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || ''
        const max = Math.min(Number(url.searchParams.get('max-keys') || 1000), pageSize)
        const token = url.searchParams.get('continuation-token') || ''
        const all = [...store.keys()].filter((name) => name.startsWith(prefix)).sort()
        const start = token ? all.indexOf(token) : 0
        const page = all.slice(start, start + max)
        const truncated = all.length > start + page.length
        const contents = page.map((name) => [
          '<Contents>',
          `<Key>${xmlEscape(name)}</Key>`,
          `<LastModified>${new Date(store.get(name).at).toISOString()}</LastModified>`,
          `<ETag>&quot;${store.get(name).etag}&quot;</ETag>`,
          `<Size>${store.get(name).body.length}</Size>`,
          '</Contents>',
        ].join(''))
        res.writeHead(200, { 'content-type': 'application/xml' })
        return res.end([
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<ListBucketResult>',
          `<Name>${bucket}</Name>`,
          `<Prefix>${xmlEscape(prefix)}</Prefix>`,
          `<MaxKeys>${max}</MaxKeys>`,
          `<IsTruncated>${truncated}</IsTruncated>`,
          truncated ? `<NextContinuationToken>${xmlEscape(page[page.length - 1])}</NextContinuationToken>` : '',
          ...contents,
          '</ListBucketResult>',
        ].join(''))
      }
      if (req.method === 'PUT' && key) {
        // 声明的长度和真收到的不一致说明流式上传的 header 写错了
        if (Number(req.headers['content-length']) !== body.length) {
          return fail(400, 'IncompleteBody', `content-length ${req.headers['content-length']} vs ${body.length}`)
        }
        store.set(key, { body, at: Date.now(), etag: `${body.length}-${record.key}` })
        res.writeHead(200)
        return res.end()
      }
      if (req.method === 'HEAD' && key) {
        const item = store.get(key)
        if (!item) {
          res.writeHead(404)
          return res.end()
        }
        res.writeHead(200, { 'content-length': String(item.body.length), 'last-modified': new Date(item.at).toUTCString() })
        return res.end()
      }
      if (req.method === 'GET' && key) {
        const item = store.get(key)
        if (!item) return fail(404, 'NoSuchKey', key)
        res.writeHead(200, { 'content-length': String(item.body.length), 'last-modified': new Date(item.at).toUTCString() })
        return res.end(item.body)
      }
      return fail(400, 'BadRequest', `${req.method} ${url.pathname}`)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    bucket,
    store,
    requests,
    namespace: `${SYNC_NAMESPACE}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
