/**
 * S3 同步：把 dsh 的会话记录、附件与插件配置在 S3 兼容的对象存储（AWS S3 / R2 / MinIO /
 * B2 / OSS / COS…）上做一次上传或下载。
 *
 * 为什么手写 SigV4 而不用 @aws-sdk/client-s3：启动器是零依赖的（安装包里只有一份 node
 * 运行时和几个纯 JS 文件），AWS SDK 光本体几十 MB，还得跟着打包清单走。我们用到的只有
 * PUT / GET / HEAD / LIST 四个动作，签名不到两百行，而所有 S3 兼容实现都认这一套。
 *
 * 语义（故意做窄，宁少不误伤）：
 * - 只做新增与更新，**不传播删除**：桶和本机各自留下并集，误删的文件不会被同步抹掉。
 * - 会话/附件/技能/记忆按文件比（大小 + 修改时间）。下载后把本地 mtime 对齐成桶里的
 *   时间戳，否则「刚拉下来的文件」会被下一次上传当成「本机更新的文件」再传一遍。
 * - 插件清单（package.json）两个方向都做**并集合并**：两台机器各装的插件都不丢，合并结果
 *   同时写回本机和桶。其余 profile 文件（cordis.yml / cordis.patch.yml）按冲突策略处理。
 * - 本地路径依赖（`file:` 指向本机不存在的目录）在合并时摘掉并在结果里点名——留着它
 *   下次 pnpm install 必然失败，整个 profile 起不来。
 * - 冲突默认「保留本机」；要覆盖得自己选。
 */
import { createHash, createHmac } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { cmpVer, parseVer } from './registry.js'

/** 桶里的顶层目录：同一只桶可能还放着别的东西，我们的内容都在这一层下面。 */
export const S3_NAMESPACE = 'dsh-x/v1'
/** 修改时间相差这么多秒以内算「一样新」，容忍两台机器的时钟差。 */
const CLOCK_SLACK_MS = 2000
const MAX_KEYS = 1000
/** 每个请求最多重试几次（网络抖动、5xx、限流）。 */
const RETRIES = 2
/** 单个请求的空闲超时：卡住不动的连接不会一直挂着。 */
const IDLE_TIMEOUT_MS = 120_000
const USER_AGENT = 'DSH-X-sync'
/** 同步时跳过的临时文件（我们自己写的备份、下载中的半成品、冲突时另存的副本）。 */
const SKIP_FILE_RE = /\.(sync-bak|sync-part|tmp)$|\.remote-\d{8}-\d{4}$/i

/** 端点写在配置里时可能不带协议；不带就按 https 补全（明文传输凭据要显式写 http://）。 */
export function s3Endpoint(endpoint) {
  const text = String(endpoint ?? '').trim().replace(/\/+$/, '')
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) return text
  return `https://${text}`
}

/** 主页地址（管理页要显示往哪儿传，别把密钥带出去）。 */
export function s3DisplayUrl(config = {}) {
  const endpoint = s3Endpoint(config.endpoint)
  if (!endpoint) return ''
  const prefix = String(config.prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
  const base = `${endpoint}/${config.bucket || ''}`
  return prefix ? `${base}/${prefix}` : base
}

/**
 * 把「桶 + 前缀」从可能带 s3:// 的填写方式里拆出来。
 * `s3://my-bucket/dsh` 这种写法在 AWS 控制台里到处都是，用户会直接贴进来——那就当
 * 它同时给出了桶名和前缀，端点按区域补（没填区域就用 us-east-1）。
 */
export function parseS3Address(value, region = '') {
  const text = String(value ?? '').trim()
  const match = /^s3:\/\/([^/]+)(?:\/(.*))?$/i.exec(text)
  if (!match) return null
  return {
    bucket: match[1],
    prefix: (match[2] || '').replace(/^\/+|\/+$/g, ''),
    endpoint: `https://s3.${String(region || '').trim() || 'us-east-1'}.amazonaws.com`,
  }
}

/**
 * 归一化存储桶配置。缺项不报错（用户是分步填的），只在真要同步时检查。
 * 抛错的地方都是「填了但填错」，比如端点根本不像个地址。
 */
export function safeS3Config(value) {
  const source = value && typeof value === 'object' ? value : {}
  const region = String(source.region ?? '').trim()
  const raw = String(source.endpoint ?? '').trim()
  const address = parseS3Address(raw, region)
  const bucket = String(address ? address.bucket : source.bucket ?? '').trim()
  const prefix = String(address ? address.prefix : source.prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
  const style = ['auto', 'path', 'virtual'].includes(source.style) ? source.style : 'auto'
  const config = {
    endpoint: address ? address.endpoint : s3Endpoint(raw),
    region: region || 'us-east-1',
    bucket,
    prefix,
    accessKeyId: String(source.accessKeyId ?? '').trim(),
    secretAccessKey: String(source.secretAccessKey ?? '').trim(),
    sessionToken: String(source.sessionToken ?? '').trim(),
    style,
    insecure: source.insecure === true,
  }
  if (bucket && !/^[A-Za-z0-9._-]{1,255}$/.test(bucket)) {
    throw new Error('桶名只能用字母、数字、点、下划线、连字符')
  }
  if (prefix.includes('..')) throw new Error('桶内前缀不能包含 ..')
  if (config.endpoint && !/^https?:\/\/[^\s]+$/i.test(config.endpoint)) {
    throw new Error('存储端点要像 https://s3.us-east-1.amazonaws.com 这样')
  }
  if (config.endpoint && config.endpoint.includes('://') && !URL.canParse(config.endpoint)) {
    throw new Error('存储端点不是个能解析的地址')
  }
  return config
}

/** 配置填全了没有（四个必填项都非空）。 */
export function s3Configured(config = {}) {
  return Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey)
}

/** 缺哪一项，说人话（设置页的提示行直接用它）。 */
export function s3Missing(config = {}) {
  const missing = []
  if (!config.endpoint) missing.push('存储端点')
  if (!config.bucket) missing.push('桶名')
  if (!config.accessKeyId) missing.push('AccessKey')
  if (!config.secretAccessKey) missing.push('SecretKey')
  return missing
}

// ---------------------------------------------------------------- 签名（SigV4）

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

/** AWS4 的派生签名密钥：HMAC 链（日期 → 区域 → 服务 → aws4_request）。 */
export function signingKey(secret, dateStamp, region, service = 's3') {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request')
}

const UNRESERVED_RE = /^[A-Za-z0-9_.~-]$/

/**
 * RFC3986 逐字节百分号编码（十六进制大写）。encodeURIComponent 会漏掉 `!'()*`，
 * 而这些字符在签名里必须被编码，否则签名和实际请求对不上。
 */
export function uriEncode(text, encodeSlash = true) {
  let out = ''
  for (const byte of Buffer.from(String(text ?? ''), 'utf8')) {
    const char = String.fromCharCode(byte)
    if (UNRESERVED_RE.test(char)) out += char
    else if (char === '/' && !encodeSlash) out += char
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** 规范化查询串：按 key 排序、键值都做严格编码、空值丢掉。 */
export function canonicalQuery(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [uriEncode(key), uriEncode(value)])
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
}

/** 规范化请求（SigV4 的 CanonicalRequest，逐字对齐 AWS 文档的排版）。 */
export function canonicalRequest({ method, path, query = '', headers, signedHeaders, payloadHash }) {
  const block = signedHeaders
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  return [
    method,
    path,
    query,
    block,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n')
}

export function amzDates(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]|\.\d{3}/g, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

/**
 * 给一个请求签上 SigV4 的头。返回要发的头 + 中间产物（测试直接比对中间产物）。
 * payloadHash 传 'UNSIGNED-PAYLOAD' 表示不签正文——上传大文件时流式发送要用它。
 */
export function signV4({
  method,
  host,
  path,
  query = '',
  region,
  accessKeyId,
  secretAccessKey,
  sessionToken = '',
  payloadHash,
  headers = {},
  date = new Date(),
  service = 's3',
}) {
  const { amzDate, dateStamp } = amzDates(date)
  const all = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...headers,
  }
  if (sessionToken) all['x-amz-security-token'] = sessionToken
  const signedHeaders = Object.keys(all).map((name) => name.toLowerCase()).sort()
  const canonical = canonicalRequest({ method, path, query, headers: all, signedHeaders, payloadHash })
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n')
  const signature = createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, service))
    .update(stringToSign)
    .digest('hex')
  return {
    amzDate,
    scope,
    canonicalRequest: canonical,
    stringToSign,
    signature,
    headers: {
      ...all,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    },
  }
}

// ---------------------------------------------------------------- 响应解析

/** XML 里那几个实体，S3 的键名可能带 & < >。 */
export function xmlDecode(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 请求带了 encoding-type=url 时，键与续传令牌都是百分号编码的（`%` 不在 base64 里，解一次不会伤到没编码的值）。 */
function decodeXmlValue(text) {
  const raw = xmlDecode(text)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 解析 ListObjectsV2 的一页：内容 + 是否还有下一页。 */
export function parseListXml(xml) {
  const contents = []
  for (const match of String(xml ?? '').matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1]
    const tag = (name) => {
      const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
      return found ? found[1] : ''
    }
    const size = Number(tag('Size'))
    contents.push({
      key: decodeXmlValue(tag('Key')),
      size: Number.isFinite(size) ? size : 0,
      lastModifiedMs: Date.parse(tag('LastModified')) || 0,
      etag: xmlDecode(tag('ETag')).replace(/"/g, ''),
    })
  }
  const text = String(xml ?? '')
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(text)
  const token = decodeXmlValue((/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text) || [])[1] || '')
  return { contents, truncated, nextToken: token }
}

/** S3 的报错码 → 人话。设置写错了几乎都能在这里认出来。 */
export function s3ErrorMessage(status, xml, extra = '') {
  const code = xmlDecode((/<Code>([\s\S]*?)<\/Code>/.exec(String(xml ?? '')) || [])[1] || '')
  const message = xmlDecode((/<Message>([\s\S]*?)<\/Message>/.exec(String(xml ?? '')) || [])[1] || '')
  const known = {
    SignatureDoesNotMatch: '签名不对：SecretKey 填错了（也可能是区域或端点填错）',
    InvalidAccessKeyId: 'AccessKey 不存在',
    AccessDenied: '没有权限：换个密钥，或给这个账号放开桶的读写权限',
    NoSuchBucket: '桶不存在：检查桶名和端点是不是同一家的',
    AllAccessDisabled: '这个桶被禁用了',
    PermanentRedirect: '端点不是这个桶所在的地方：检查区域（Region）和端点',
    AuthorizationHeaderMalformed: '区域填错了：报错里的区域才是这只桶的区域',
    RequestTimeTooSkewed: '本机时间和真实时间差太多，校准系统时间后再试',
    InvalidBucketName: '桶名不合法',
    NoSuchKey: '桶里没有这个对象',
    EntityTooLarge: '文件太大了',
    RequestTimeout: '请求超时了，网络可能不稳',
  }
  const hint = known[code] || ''
  const text = [code, hint || message || `HTTP ${status}`, extra].filter(Boolean).join('：')
  return text || `S3 请求失败（HTTP ${status}）`
}

// ---------------------------------------------------------------- S3 客户端

/** 端点主机是不是个 IP 字面量（这种端点只能用路径风格）。 */
function isIpLiteral(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[/.test(host)
}

/** 用哪种寻址风格：auto 时 IP / localhost 走路径风格，域名走虚拟主机。 */
export function resolveStyle(config, endpoint) {
  if (config.style === 'path') return 'path'
  if (config.style === 'virtual') return 'virtual'
  const host = endpoint.hostname
  if (isIpLiteral(host) || host === 'localhost') return 'path'
  // 端点里已经带了桶名（各家控制台给的就是这种地址），那它本身就是虚拟主机风格
  if (config.bucket && host.startsWith(`${config.bucket}.`)) return 'virtual'
  return 'virtual'
}

export class S3 {
  constructor(config) {
    this.config = safeS3Config(config)
    if (!this.config.endpoint) throw new Error('还没填存储端点')
    let endpoint
    try {
      endpoint = new URL(this.config.endpoint)
    } catch {
      throw new Error('存储端点不是个能解析的地址')
    }
    this.endpoint = endpoint
    this.secure = endpoint.protocol === 'https:'
    this.style = resolveStyle(this.config, endpoint)
    const prefixed = this.style === 'virtual' && this.config.bucket && !endpoint.hostname.startsWith(`${this.config.bucket}.`)
    // 签名与 Host 头用的是「带桶名的主机:端口」；真正连哪台机器是 connectHost（不带端口）。
    // 桶名里有点（my.bucket）时虚拟主机风格会踩到通配证书校验，那就换路径风格。
    this.host = prefixed ? `${this.config.bucket}.${endpoint.host}` : endpoint.host
    this.connectHost = prefixed ? `${this.config.bucket}.${endpoint.hostname}` : endpoint.hostname
    this.agent = this.secure && this.config.insecure ? new Agent({ rejectUnauthorized: false }) : undefined
    if (this.secure && this.config.insecure) this.insecureTls = true
  }

  /** 用户填的前缀 + 命名空间：所有键都在这下面。 */
  get namespace() {
    const prefix = this.config.prefix ? `${this.config.prefix}/` : ''
    return `${prefix}${S3_NAMESPACE}`
  }

  /** 键 → 请求路径（路径风格带桶名，虚拟主机风格不带）。 */
  pathFor(key) {
    const encoded = uriEncode(key, false)
    if (this.style === 'path') return `/${uriEncode(this.config.bucket)}/${encoded}`
    return `/${encoded}`
  }

  /**
   * 发一个请求。返回 { status, headers, stream }；正文由调用方消费（上传大文件要流式）。
   * 网络错误、5xx、429 会按退避重试——同步常常跑在不太稳的网络上。
   */
  async send({ method, path, query = {}, payloadHash, file, body, size, headers = {} }, attempt = 0) {
    const signed = signV4({
      method,
      host: this.host,
      path,
      query: canonicalQuery(query),
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      payloadHash,
      headers,
    })
    const queryText = canonicalQuery(query)
    const url = `${this.endpoint.protocol}//${this.host}${path}${queryText ? `?${queryText}` : ''}`
    const options = {
      method,
      host: this.connectHost,
      path: `${path}${queryText ? `?${queryText}` : ''}`,
      port: this.endpoint.port || (this.secure ? 443 : 80),
      headers: { ...signed.headers, 'user-agent': USER_AGENT },
    }
    if (size !== undefined) options.headers['content-length'] = String(size)
    if (this.agent) options.agent = this.agent
    try {
      return await new Promise((resolve, reject) => {
        const request = (this.secure ? httpsRequest : httpRequest)(options, (res) => resolve({
          status: res.statusCode,
          headers: res.headers,
          stream: res,
        }))
        request.setTimeout(IDLE_TIMEOUT_MS, () => {
          request.destroy(new Error('连接空闲超时（网络太慢或端点不通）'))
        })
        request.on('error', reject)
        if (file) {
          // 大文件流式发（content-length 必须显式给，否则会变成 chunked，S3 那边不好判断长度）
          const stream = createReadStream(file)
          stream.on('error', (error) => request.destroy(error))
          stream.pipe(request)
        } else {
          request.end(body)
        }
      })
    } catch (error) {
      if (attempt < RETRIES && retryableError(error)) {
        await delay(400 * 2 ** attempt)
        return this.send({ method, path, query, payloadHash, file, body, size, headers }, attempt + 1)
      }
      throw new Error(describeNetworkError(error, this.host))
    }
  }

  /** 读干正文并校验状态码；错了就抛出带人话的错。 */
  async expect(result, allowed = [200]) {
    const text = await readAll(result.stream)
    if (allowed.includes(result.status)) return text
    if (result.status === 404 && allowed.includes(404)) return text
    throw new Error(s3ErrorMessage(result.status, text))
  }

  /** 列一个前缀下的所有对象（翻页到底）。 */
  async list(prefixKey, { maxKeys = MAX_KEYS } = {}) {
    const out = new Map()
    let token = ''
    for (let page = 0; page < 1000; page += 1) {
      const result = await this.send({
        method: 'GET',
        path: this.pathFor(''),
        query: {
          'list-type': '2',
          prefix: `${prefixKey}/`,
          'max-keys': String(maxKeys),
          'encoding-type': 'url',
          ...(token ? { 'continuation-token': token } : {}),
        },
        payloadHash: sha256Hex(''),
      })
      const text = await this.expect(result)
      const parsed = parseListXml(text)
      for (const item of parsed.contents) out.set(item.key, item)
      if (!parsed.truncated || !parsed.nextToken) break
      token = parsed.nextToken
    }
    return out
  }

  async head(key) {
    const result = await this.send({ method: 'HEAD', path: this.pathFor(key), payloadHash: sha256Hex('') })
    if (result.status === 404) {
      result.stream.resume()
      return null
    }
    if (result.status !== 200) {
      const text = await readAll(result.stream)
      throw new Error(s3ErrorMessage(result.status, text))
    }
    result.stream.resume()
    return {
      size: Number(result.headers['content-length'] || 0),
      lastModifiedMs: Date.parse(result.headers['last-modified'] || '') || 0,
      etag: String(result.headers.etag || '').replace(/"/g, ''),
    }
  }

  /** 上传一个文件（流式，正文不参与签名）。 */
  async putFile(key, file, size, { contentType = 'application/octet-stream' } = {}) {
    const result = await this.send({
      method: 'PUT',
      path: this.pathFor(key),
      payloadHash: 'UNSIGNED-PAYLOAD',
      file,
      size,
      headers: { 'content-type': contentType },
    })
    await this.expect(result)
    return size
  }

  /** 上传一段文本（配置文件很小，直接进内存）。 */
  async putText(key, text, contentType = 'application/json') {
    return this.putBuffer(key, Buffer.from(text, 'utf8'), contentType)
  }

  async putBuffer(key, buffer, contentType = 'application/octet-stream') {
    const result = await this.send({
      method: 'PUT',
      path: this.pathFor(key),
      payloadHash: sha256Hex(buffer),
      body: buffer,
      size: buffer.length,
      headers: { 'content-type': contentType },
    })
    await this.expect(result)
    return buffer.length
  }

  /**
   * 下载到文件：先写临时文件再改名（中途断了不会留下半个文件冒充完整文件），
   * 最后把 mtime 对齐成桶里的时间——下一次上传就不用再传一遍。
   */
  async getFile(key, dest, { lastModifiedMs = 0, mkdirTo = true } = {}) {
    const result = await this.send({ method: 'GET', path: this.pathFor(key), payloadHash: sha256Hex('') })
    if (result.status !== 200) {
      const text = await readAll(result.stream)
      throw new Error(s3ErrorMessage(result.status, text))
    }
    if (mkdirTo) await mkdir(join(dest, '..'), { recursive: true })
    const temp = `${dest}.sync-part`
    let bytes = 0
    try {
      await pipeline(
        result.stream.on('data', (chunk) => { bytes += chunk.length }),
        createWriteStream(temp),
      )
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    await rm(dest, { force: true })
    await rename(temp, dest)
    if (lastModifiedMs) {
      const seconds = lastModifiedMs / 1000
      try {
        await utimes(dest, seconds, seconds)
      } catch {
        // 时间戳对齐失败不影响内容同步，下次顶多多传一遍
      }
    }
    return bytes
  }

  /** 读一个对象成文本（桶里的 profile 清单用这个）。不存在返回 null。 */
  async getText(key) {
    const result = await this.send({ method: 'GET', path: this.pathFor(key), payloadHash: sha256Hex('') })
    if (result.status === 404) {
      await readAll(result.stream)
      return null
    }
    const text = await this.expect(result)
    return text.toString('utf8')
  }

  /** 连通性自检：能不能走到这个桶、密钥认不认。 */
  async test() {
    if (!s3Configured(this.config)) throw new Error(`还没填完：${s3Missing(this.config).join('、')}`)
    const result = await this.send({
      method: 'GET',
      path: this.pathFor(''),
      query: { 'list-type': '2', prefix: `${this.namespace}/`, 'max-keys': '1', 'encoding-type': 'url' },
      payloadHash: sha256Hex(''),
    })
    const text = await this.expect(result)
    const parsed = parseListXml(text)
    return { objects: parsed.contents.length, namespace: this.namespace, style: this.style, host: this.host }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryableError(error) {
  const code = String(error?.code || '')
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND'].includes(code)
}

/** 网络层错误也翻译成人话：用户看到 ENOTFOUND 只会一头雾水。 */
export function describeNetworkError(error, host = '') {
  const code = String(error?.code || '')
  const map = {
    ENOTFOUND: `域名解析不了：${host || '端点'} 这个地址对不对？`,
    EAI_AGAIN: '域名解析超时（DNS 不通）',
    ECONNREFUSED: `连不上 ${host || '端点'}（服务没开或端口不对）`,
    ECONNRESET: '连接被对方重置（端点不支持这个协议？自建存储试试 http://）',
    ETIMEDOUT: '连接超时（地址不通或被墙）',
    CERT_HAS_EXPIRED: '证书过期了',
    DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书：勾上「跳过证书校验」或用 http://',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链不完整：勾上「跳过证书校验」或用 http://',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书和域名不匹配',
  }
  if (map[code]) return map[code]
  return error instanceof Error ? error.message : String(error)
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

// ---------------------------------------------------------------- 同步范围

/**
 * 可同步的内容。plugins 后面那段是「哪些文件算插件配置」的取舍：
 * - package.json：插件清单（依赖 + dsh.profile.bundles），合并走并集；
 * - cordis.patch.yml：插件开关、MCP 条目、技能覆盖都写这儿；
 * - cordis.yml：profile 入口，理论上只有 `[]`，但用户可能被别的工具改过。
 * 有意不同步的：node_modules（太大，且平台相关）、pnpm-lock.yaml（本机重装时重算）、
 * .npmrc（写着 node-linker=hoisted 这类机器相关的设置，同步过去会搞坏好机器）。
 */
export const PROFILE_SYNC_FILES = [
  { name: 'package.json', kind: 'manifest' },
  { name: 'cordis.yml', kind: 'file' },
  { name: 'cordis.patch.yml', kind: 'file' },
]

export const SYNC_SCOPES = [
  { id: 'sessions', label: '会话记录', hint: '每个项目的聊天记录（session.jsonl.zstd）' },
  { id: 'attachments', label: '附件', hint: '对话里贴的图片和文件' },
  { id: 'plugins', label: '插件与配置', hint: '当前 profile 的插件清单、补丁层（拉下来后自动重装依赖）' },
  { id: 'skills', label: '技能', hint: 'dsh 与 agents 两个用户级技能目录' },
  { id: 'memory', label: '记忆', hint: 'dsh 的长期记忆目录' },
]

export const DEFAULT_SCOPE_IDS = ['sessions', 'attachments', 'plugins']
/** 冲突策略：本机优先（默认）/ 桶优先 / 两份都留。 */
export const CONFLICT_POLICIES = ['skip', 'overwrite', 'duplicate']
export const DEFAULT_POLICY = 'skip'

export function safeScopeIds(value) {
  const list = Array.isArray(value) ? value : DEFAULT_SCOPE_IDS
  const known = SYNC_SCOPES.map((scope) => scope.id)
  const picked = list.map((id) => String(id)).filter((id) => known.includes(id))
  return [...new Set(picked)]
}

export function safePolicy(value) {
  return CONFLICT_POLICIES.includes(value) ? value : DEFAULT_POLICY
}

/**
 * 一个范围对应哪些「本地目录 → 键前缀」。files 存在时只同步列出的文件（插件配置）。
 * 技能分两个根（dsh 与 agents），所以一个范围可能对应多个目录。
 */
export function scopeTargets(scope, { home, profile, profileDir, roots = [] } = {}) {
  switch (scope) {
    case 'sessions':
      return [{ prefix: 'sessions', dir: join(home, 'sessions') }]
    case 'attachments':
      return [{ prefix: 'attachments', dir: join(home, 'attachments') }]
    case 'memory':
      return [{ prefix: 'memory', dir: join(home, 'memory') }]
    case 'skills':
      return roots.map((root) => ({ prefix: `skills/${root.key}`, dir: root.dir }))
    case 'plugins':
      return [{ prefix: `profiles/${profile}`, dir: profileDir, files: PROFILE_SYNC_FILES }]
    default:
      return []
  }
}

/** 相对路径一律用正斜杠——桶里的键不能带 Windows 的反斜杠。 */
export function toKeyPath(relativePath) {
  return String(relativePath).split(sep).join('/')
}

/** 目录递归列出文件（只收普通文件，符号链接跳过）。 */
export function walkFiles(dir, base = dir) {
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_FILE_RE.test(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFiles(path, base))
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = statSync(path)
      out.push({ rel: toKeyPath(path.slice(base.length + 1)), path, size: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // 读不到状态的（被别的进程占着）当没有，下次再说
    }
  }
  return out
}

/** 本机这一侧的全量清单：键 → {path, size, mtimeMs, kind}。 */
export function scanLocal(targets) {
  const local = new Map()
  for (const target of targets) {
    if (target.files) {
      for (const file of target.files) {
        const path = join(target.dir, file.name)
        try {
          const info = statSync(path)
          if (!info.isFile()) continue
          local.set(`${target.prefix}/${file.name}`, { path, size: info.size, mtimeMs: info.mtimeMs, kind: file.kind })
        } catch {
          // 本机没这个文件：可能这个 profile 还没建出补丁层
        }
      }
      continue
    }
    for (const file of walkFiles(target.dir)) {
      local.set(`${target.prefix}/${file.rel}`, { path: file.path, size: file.size, mtimeMs: file.mtimeMs, kind: 'file' })
    }
  }
  return local
}

/** 桶里的键 → 本机该落到哪个路径（不在同步范围内的键、带 .. 的键返回空串）。 */
export function localPathFor(key, targets) {
  const parts = String(key).split('/')
  if (parts.includes('..') || parts.includes('')) return ''
  for (const target of targets) {
    if (!key.startsWith(`${target.prefix}/`)) continue
    const rest = key.slice(target.prefix.length + 1)
    if (target.files) {
      const known = target.files.find((file) => file.name === rest)
      return known ? join(target.dir, known.name) : ''
    }
    return join(target.dir, ...rest.split('/'))
  }
  return ''
}

/**
 * 差异计划（纯函数，方便对着表格单测）：
 * - 上传：桶里没有 → 传；大小不同 → 传；本机更新 → 传；开关「强制」时一律传。
 * - 下载：本机没有 → 拉；大小相同 → 跳过；大小不同 → 按冲突策略。
 * 只比较大小和修改时间：内容哈希要读全部文件，几十 MB 的会话记录每次全读一遍不值得。
 */
export function planSync({ entries, remote, mode, policy = DEFAULT_POLICY, force = false }) {
  const items = []
  if (mode === 'up') {
    for (const [key, local] of entries) {
      const there = remote.get(key)
      const reason = !there ? 'new'
        : force ? 'force'
          : local.size !== there.size ? 'changed'
            : local.mtimeMs > there.lastModifiedMs + CLOCK_SLACK_MS ? 'newer'
              : ''
      if (reason) items.push({ key, action: 'upload', reason, local, remote: there })
    }
  } else {
    for (const [key, there] of remote) {
      const local = entries.get(key)
      if (!local) {
        items.push({ key, action: 'download', reason: 'new', remote: there })
        continue
      }
      if (local.size === there.size && !force) continue
      if (force || policy === 'overwrite') items.push({ key, action: 'download', reason: 'overwrite', local, remote: there })
      else if (policy === 'duplicate') items.push({ key, action: 'duplicate', reason: 'duplicate', local, remote: there })
      else items.push({ key, action: 'conflict', reason: 'conflict', local, remote: there })
    }
  }
  return items
}

// ---------------------------------------------------------------- 插件清单合并

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** `file:xxx` 这类本地依赖指向的绝对路径（其它协议返回空串）。 */
export function localDepPath(profileDir, spec) {
  const match = /^(?:file|link|portal):(.+)$/.exec(String(spec ?? ''))
  if (!match) return ''
  const target = match[1]
  if (!target) return ''
  return isAbsolute(target) ? target : resolve(profileDir, target)
}

/** 版本号能不能比（`^1.2.3`、`file:…`、`workspace:*` 这类都返回 0 = 不比）。 */
function compareVersions(left, right) {
  const a = parseVer(left)
  const b = parseVer(right)
  if (!a || !b) return 0
  return cmpVer(a, b)
}

/** 清单一律按 2 空格 + 结尾换行写回（pnpm 与 dsh 自己也是这个格式，正常情况等于没动）。 */
function stringifyManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * 两份清单内容是不是同一回事（不管缩进、键序）。
 * 只差格式就不要重写本机文件——重写会顺带触发一次依赖重装，白等几十秒。
 */
export function sameManifestContent(left, right) {
  const a = parseJsonObject(left)
  const b = parseJsonObject(right)
  if (!a || !b) return false
  return stableStringify(a) === stableStringify(b)
}

/** 依赖里指向本机不存在路径的那些 `file:` 包（返回名字）。 */
function missingLocalDeps(dependencies, { profileDir, exists }) {
  const missing = []
  for (const [name, spec] of Object.entries(dependencies ?? {})) {
    const path = localDepPath(profileDir, spec)
    if (!path) continue
    let there = false
    try {
      there = exists(path)
    } catch {
      there = false
    }
    if (!there) missing.push(name)
  }
  return missing
}

/** 去掉若干依赖，并把 bundles 里已经没有依赖的条目一并去掉（自愈脏清单）。 */
function withoutDeps(manifest, names) {
  const drop = new Set(names)
  const dependencies = {}
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
    if (!drop.has(name)) dependencies[name] = manifest.dependencies[name]
  }
  const next = { ...manifest, dependencies }
  if (manifest.dsh?.profile && Array.isArray(manifest.dsh.profile.bundles)) {
    next.dsh = {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh.profile,
        bundles: manifest.dsh.profile.bundles.filter((name) => name in dependencies),
      },
    }
  }
  return next
}

/**
 * 合并两台机器的 profile 清单：
 * - dependencies 取并集，同名时版本号大的赢（比不出来就听本机的）；
 * - dsh.profile.bundles 取并集，并丢掉「依赖里已经没有」的条目（自愈脏清单）；
 * - 其余字段以本机为准（name、patchReload 这些是本机 profile 的身份）；
 * - `file:` 依赖指向本机不存在的路径时：**远端来的不写进本机**（写了 pnpm install 必然
 *   失败，整个 profile 起不来），**本机自己的仍留在本机**、只是不往桶里传（用户本机
 *   的文件可能只是暂时不在，比如在移动硬盘上）。所以本机一份文本、桶一份文本，
 *   两份都要回去分别写。
 *
 * 返回 null 表示没什么可合并的（本机清单坏了、或两边都空）。
 */
export function mergeProfileManifest(localText, remoteText, { profileDir = '', exists = existsSync } = {}) {
  const options = { profileDir, exists }
  const remote = remoteText ? parseJsonObject(remoteText) : null
  const local = parseJsonObject(localText)
  if (!local) {
    // 本机清单读不出来（还没建、或坏了）：整份用桶里的，但仍然要摘掉本机没有的本地依赖
    if (!remote) return null
    const taken = sanitizeManifest(remote, options)
    const text = stringifyManifest(taken.manifest)
    return {
      text,
      bucketText: text,
      fromRemote: true,
      added: Object.keys(taken.manifest.dependencies ?? {}),
      updated: [],
      dropped: taken.dropped.map((item) => ({ ...item, local: false })),
      bundlesAdded: [],
      bundlesDropped: [],
    }
  }
  if (!remote) return null

  const localNames = new Set(Object.keys(local.dependencies ?? {}))
  const dependencies = { ...(local.dependencies ?? {}) }
  const added = []
  const updated = []
  for (const [name, spec] of Object.entries(remote.dependencies ?? {})) {
    const specText = String(spec ?? '')
    if (!(name in dependencies)) {
      dependencies[name] = specText
      added.push(name)
      continue
    }
    const mine = String(dependencies[name] ?? '')
    if (mine === specText) continue
    const winner = compareVersions(specText, mine)
    if (winner > 0) {
      dependencies[name] = specText
      updated.push({ name, from: mine, to: specText })
    }
  }
  const sorted = {}
  for (const name of Object.keys(dependencies).sort()) sorted[name] = dependencies[name]
  const localBundles = Array.isArray(local.dsh?.profile?.bundles) ? local.dsh.profile.bundles : []
  const remoteBundles = Array.isArray(remote.dsh?.profile?.bundles) ? remote.dsh.profile.bundles : []
  const bundles = [...new Set([...localBundles, ...remoteBundles])]
  // 先按「全都要」拼一份，再按两边各自该丢的丢——这样两边都只是这一份的子集
  const merged = { ...local, dependencies: sorted }
  if (local.dsh?.profile) merged.dsh = { ...local.dsh, profile: { ...local.dsh.profile, bundles } }
  const missing = missingLocalDeps(sorted, options)
  const remoteOnlyMissing = missing.filter((name) => !localNames.has(name))
  const localTarget = withoutDeps(merged, remoteOnlyMissing)
  const bucketTarget = withoutDeps(merged, missing)
  // 被摘掉的远端依赖不算「新增」——不然日志会同时说「加了 dsh-gone」和「dsh-gone 指向
  // 本机不存在的路径，已跳过」，自己打自己
  const droppedNames = new Set(missing)
  const dropped = missing.map((name) => ({ name, spec: String(dependencies[name] ?? ''), local: localNames.has(name) }))
  const keptBundles = (manifest) => manifest.dsh?.profile?.bundles ?? []
  return {
    text: stringifyManifest(localTarget),
    bucketText: stringifyManifest(bucketTarget),
    added: added.filter((name) => !droppedNames.has(name)),
    updated: updated.filter((item) => !droppedNames.has(item.name)),
    dropped,
    bundlesAdded: keptBundles(localTarget).filter((name) => !localBundles.includes(name)),
    bundlesDropped: localBundles.filter((name) => !keptBundles(localTarget).includes(name)),
  }
}

/** 摘掉指向本机不存在路径的 `file:` 依赖，同步更新 bundles。 */
export function sanitizeManifestText(text, options = {}) {
  const parsed = parseJsonObject(text)
  if (!parsed) return text
  return stringifyManifest(sanitizeManifest(parsed, options).manifest)
}

function sanitizeManifest(manifest, { profileDir, exists }) {
  const dropped = []
  const dependencies = { ...(manifest.dependencies ?? {}) }
  for (const [name, spec] of Object.entries(dependencies)) {
    const path = localDepPath(profileDir, spec)
    if (!path) continue
    let there = false
    try {
      there = exists(path)
    } catch {
      there = false
    }
    if (there) continue
    dropped.push({ name, spec: String(spec) })
    delete dependencies[name]
  }
  const next = { ...manifest, dependencies }
  if (manifest.dsh?.profile && Array.isArray(manifest.dsh.profile.bundles)) {
    next.dsh = {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh.profile,
        bundles: manifest.dsh.profile.bundles.filter((name) => name in dependencies),
      },
    }
  }
  return { manifest: next, dropped }
}

// ---------------------------------------------------------------- 跑一次同步

/**
 * 跑一次同步。调用方给方向、范围、冲突策略和上下文（本机目录），
 * 过程通过 onProgress 报告，随时可以 shouldStop() 喊停。
 */
export async function runSync({
  mode,
  scopes = DEFAULT_SCOPE_IDS,
  config,
  context,
  policy = DEFAULT_POLICY,
  force = false,
  onProgress = () => {},
  shouldStop = () => false,
  log = () => {},
} = {}) {
  const client = new S3(config)
  if (!s3Configured(client.config)) throw new Error(`存储桶还没填完：${s3Missing(client.config).join('、')}`)
  const picked = safeScopeIds(scopes)
  if (!picked.length) throw new Error('先选一个要同步的范围')
  const summary = {
    mode,
    scopes: [],
    uploaded: 0,
    downloaded: 0,
    merged: 0,
    skipped: 0,
    conflicts: [],
    bytesUp: 0,
    bytesDown: 0,
    stopped: false,
    manifestChanged: false,
    notes: [],
  }

  for (const scope of picked) {
    if (shouldStop()) {
      summary.stopped = true
      break
    }
    const meta = SYNC_SCOPES.find((item) => item.id === scope)
    const targets = scopeTargets(scope, context)
    const report = { scope, label: meta?.label || scope, uploaded: 0, downloaded: 0, merged: 0, skipped: 0, bytes: 0, notes: [] }
    const prefix = `${client.namespace}/${targets[0]?.prefix || scope}`
    onProgress({ phase: 'scan', scope, label: report.label, done: 0, total: 0 })
    // scanLocal 给的键是「范围前缀/相对路径」，桶里的键还多一层命名空间（含用户前缀），
    // 这里补上，否则本机那份永远匹配不上桶里的同名文件
    const entries = new Map()
    for (const [key, entry] of scanLocal(targets)) entries.set(`${client.namespace}/${key}`, entry)
    const remote = await client.list(prefix)
    // 技能有两个根，前缀不止一个：按每个根各列一次，合并成一张表
    for (const target of targets.slice(1)) {
      const more = await client.list(`${client.namespace}/${target.prefix}`)
      for (const [key, item] of more) remote.set(key, item)
    }
    // 插件清单不走普通的文件比对：它两个方向都做并集合并（下面的 mergeManifests 管），
    // 从计划里摘出去，免得「本机没有、桶里有」时被当成普通文件先拉下来再合并一遍
    const manifestKeys = new Set(targets.flatMap((target) => (target.files || [])
      .filter((file) => file.kind === 'manifest')
      .map((file) => `${client.namespace}/${target.prefix}/${file.name}`)))
    const plan = planSync({ entries, remote, mode, policy, force }).filter((item) => !manifestKeys.has(item.key))
    const total = plan.length
    let done = 0
    log(`[同步] ${report.label}：本机 ${entries.size} 个对象，桶里 ${remote.size} 个，需要处理 ${total} 个`)

    for (const item of plan) {
      if (shouldStop()) {
        summary.stopped = true
        break
      }
      done += 1
      onProgress({ phase: mode === 'up' ? 'upload' : 'download', scope, label: report.label, done, total, current: item.key })
      // 单文件失败时把键名带上：不然只有一句「S3 请求失败」，几十个文件里根本不知道是哪个
      const guard = async (action, work) => {
        try {
          return await work()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`${action} ${shortKey(item.key)} 失败：${message}`)
        }
      }
      if (item.action === 'upload') {
        const bytes = await guard('上传', () => client.putFile(item.key, item.local.path, item.local.size, { contentType: contentTypeOf(item.key) }))
        report.uploaded += 1
        report.bytes += bytes
        summary.uploaded += 1
        summary.bytesUp += bytes
        log(`[同步] 上传 ${shortKey(item.key)}（${item.reason === 'changed' ? '内容有变' : item.reason === 'newer' ? '本机更新' : item.reason === 'force' ? '强制' : '新增'}）`)
        continue
      }
      const dest = localPathFor(relativeKeyOf(item.key, client.namespace), targets)
        || join(context.home, ...relativeKeyOf(item.key, client.namespace).split('/'))
      if (item.action === 'download' || item.action === 'duplicate') {
        const target = item.action === 'duplicate' ? `${dest}.remote-${stamp()}` : dest
        const bytes = await guard('下载', () => client.getFile(item.key, target, { lastModifiedMs: item.remote.lastModifiedMs }))
        report.downloaded += 1
        report.bytes += bytes
        summary.downloaded += 1
        summary.bytesDown += bytes
        if (item.action === 'duplicate') {
          report.notes.push(`${shortKey(item.key)} 本机也有一份，桶里的存成了 ${target} 的副本`)
          summary.notes.push(`冲突保留两份：${shortKey(item.key)}`)
        }
        log(`[同步] 下载 ${shortKey(item.key)}${item.action === 'duplicate' ? '（两份都留）' : item.reason === 'overwrite' ? '（覆盖本机）' : ''}`)
        continue
      }
      // conflict：策略说了保留本机，只记账
      report.skipped += 1
      summary.skipped += 1
      summary.conflicts.push(relativeKeyOf(item.key, client.namespace))
      log(`[同步] 跳过 ${shortKey(item.key)}：两边都有且不一样，按「保留本机」处理`)
    }

    // 插件清单：并集合并（两个方向都做）
    if (scope === 'plugins' && !summary.stopped) {
      const merged = await mergeManifests({ client, targets, context, log })
      if (merged) {
        report.merged = merged.changed ? 1 : 0
        summary.merged = merged.changed ? 1 : 0
        // 只有本机清单真的被改过才需要重装依赖：单纯上传一份备份不用动 node_modules
        if (merged.localChanged) summary.manifestChanged = true
        report.notes.push(...merged.notes)
        summary.notes.push(...merged.notes)
      }
    }
    summary.scopes.push(report)
  }
  return summary
}

/** 插件清单的合并：本机 + 桶 → 两边各写一份（桶里那份会摘掉本机没有的本地依赖）。 */
async function mergeManifests({ client, targets, context, log }) {
  const target = targets[0]
  const file = (target.files || []).find((item) => item.kind === 'manifest')
  if (!file) return null
  const path = join(target.dir, file.name)
  const key = `${target.prefix}/${file.name}`
  let localText = ''
  try {
    localText = await readFile(path, 'utf8')
  } catch {
    localText = ''
  }
  const remoteText = await client.getText(`${client.namespace}/${key}`)
  if (!remoteText && !localText) return null
  const options = { profileDir: target.dir }
  if (!remoteText) {
    // 桶里还没有这份清单：只把本机这份传上去（仍然是净化过的那份），本机文件不动
    const bucketText = sanitizeManifestText(localText, options)
    await client.putText(`${client.namespace}/${key}`, bucketText)
    log('[同步] 插件清单已上传')
    return { changed: true, localChanged: false, notes: ['插件清单已上传'] }
  }
  const merged = mergeProfileManifest(localText, remoteText, options)
  if (!merged) return { changed: false, localChanged: false, notes: [] }
  const notes = []
  if (merged.fromRemote) notes.push('本机没有插件清单，整份用了桶里的')
  if (merged.added?.length) notes.push(`桶里多出 ${merged.added.length} 个插件：${merged.added.slice(0, 6).join('、')}${merged.added.length > 6 ? '…' : ''}`)
  for (const item of merged.updated ?? []) notes.push(`${item.name} ${item.from} → ${item.to}`)
  for (const item of merged.dropped ?? []) {
    notes.push(item.local
      ? `${item.name} 是本机的本地路径依赖、指向的目录不在了（${item.spec}）：本机保持原样，桶里这份不含它`
      : `${item.name} 指向本机不存在的路径（${item.spec}），不进本机清单`)
  }
  if (merged.bundlesAdded?.length) notes.push(`启用：${merged.bundlesAdded.join('、')}`)
  if (merged.bundlesDropped?.length) notes.push(`清单里已没有这些包，去掉启用项：${merged.bundlesDropped.join('、')}`)
  // 只差缩进/键序就不动本机文件：重写等于对用户说「清单变了」，还会白跑一次依赖重装
  const changedLocal = merged.text !== localText && !sameManifestContent(merged.text, localText)
  if (changedLocal) {
    if (localText) await backupFile(path)
    await writeFile(path, merged.text)
  }
  const remoteNormalized = `${remoteText.replace(/\s+$/, '')}\n`
  const changedRemote = merged.bucketText !== remoteNormalized
  if (changedRemote) await client.putText(`${client.namespace}/${key}`, merged.bucketText)
  for (const note of notes) log(`[同步] 插件清单 ${note}`)
  return { changed: changedLocal || changedRemote, localChanged: changedLocal, notes: notes.map((note) => `插件清单：${note}`) }
}

/** 覆盖别人的文件之前留一份 .sync-bak，出问题还能对着看。 */
async function backupFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    await writeFile(`${path}.sync-bak`, text)
  } catch {
    // 备份失败不挡同步
  }
}

function contentTypeOf(key) {
  if (key.endsWith('.json')) return 'application/json'
  if (key.endsWith('.yml') || key.endsWith('.yaml')) return 'text/yaml'
  if (key.endsWith('.jsonl.zstd')) return 'application/octet-stream'
  return 'application/octet-stream'
}

/** 日志里的键名去掉命名空间前缀，留「范围/…/文件名」。 */
export function shortKey(key) {
  const parts = String(key).split('/')
  const at = parts.indexOf(S3_NAMESPACE.split('/')[0])
  const trimmed = at >= 0 ? parts.slice(at + 2) : parts
  if (trimmed.length <= 3) return trimmed.join('/')
  return `${trimmed[0]}/…/${trimmed.slice(-1)[0]}`
}

/** 桶里的键去掉命名空间（含用户前缀），得到「范围前缀/相对路径」。 */
export function relativeKeyOf(key, namespace) {
  const head = `${namespace}/`
  return String(key).startsWith(head) ? String(key).slice(head.length) : String(key)
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}
