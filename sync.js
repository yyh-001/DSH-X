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
import { copyFile, mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { looksLikeZip, readZipEntry, readZipIndex, writeZip } from './zipfile.js'
import { cmpVer, parseVer } from './version.js'

/** 远端存储里的顶层目录：同一只桶（或同一个 WebDAV 目录）可能还放着别的东西。 */
export const SYNC_NAMESPACE = 'dsh-x/v1'
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

// ---------------------------------------------------------- 远端存储（两种后端）

/**
 * 远端存储类型。同步引擎只跟「列目录 / 上传 / 下载」打交道，所以三种后端
 * （S3 兼容对象存储、WebDAV、本地目录）共用同一套比对与合并逻辑，只换下面这个客户端。
 * 本地目录那种就是「手动导出 / 导入」：导出到一个文件夹，或者从那个文件夹导回来。
 */
export const STORE_TYPES = ['s3', 'webdav', 'folder', 'zip']

export function safeStoreType(value) {
  return STORE_TYPES.includes(value) ? value : 's3'
}

/** 本地目录配置：就一个路径（导出到哪 / 从哪导入）。 */
export function safeFolderConfig(value) {
  const source = value && typeof value === 'object' ? value : {}
  const path = String(source.path ?? '').trim()
  if (path && !isAbsolute(path)) throw new Error('导出目录要填绝对路径（例如 D:\\dsh-backup）')
  return { path }
}

export function folderConfigured(config = {}) {
  return Boolean(config.path)
}

export function folderMissing(config = {}) {
  return config.path ? [] : ['导出目录']
}

export function folderDisplayUrl(config = {}) {
  return String(config.path ?? '')
}

/** ZIP 文件的配置：就一个 .zip 路径（导出写它、导入读它）。 */
export function safeZipConfig(value) {
  const source = value && typeof value === 'object' ? value : {}
  const path = String(source.path ?? '').trim()
  if (path && !isAbsolute(path)) throw new Error('ZIP 文件要填绝对路径（例如 D:\\dsh-backup.zip）')
  if (path && !/\.zip$/i.test(path)) throw new Error('ZIP 文件要以 .zip 结尾')
  return { path }
}

export function zipConfigured(config = {}) {
  return Boolean(config.path)
}

export function zipMissing(config = {}) {
  return config.path ? [] : ['ZIP 文件']
}

export function zipDisplayUrl(config = {}) {
  return String(config.path ?? '')
}

/**
 * WebDAV 配置：地址（集合 URL）、用户名、密码、可选的目录前缀。
 * 认证只做 Basic——坚果云 / Nextcloud / 群晖 / Alist 都支持；所以务必走 https，
 * 界面上也写着这句。
 */
export function safeWebdavConfig(value) {
  const source = value && typeof value === 'object' ? value : {}
  const config = {
    url: String(source.url ?? '').trim(),
    username: String(source.username ?? '').trim(),
    password: String(source.password ?? '').trim(),
    prefix: String(source.prefix ?? '').trim().replace(/^\/+|\/+$/g, ''),
    insecure: source.insecure === true,
  }
  if (config.prefix.includes('..')) throw new Error('目录前缀不能包含 ..')
  if (config.url) {
    if (!/^https?:\/\/[^\s]+$/i.test(config.url)) {
      throw new Error('WebDAV 地址要像 https://dav.jianguoyun.com/dav/你的目录 这样（带 http/https）')
    }
    if (!URL.canParse(config.url)) throw new Error('WebDAV 地址不是个能解析的地址')
  }
  return config
}

export function webdavConfigured(config = {}) {
  return Boolean(config.url && config.username && config.password)
}

export function webdavMissing(config = {}) {
  const missing = []
  if (!config.url) missing.push('WebDAV 地址')
  if (!config.username) missing.push('用户名')
  if (!config.password) missing.push('密码')
  return missing
}

/** 同步页上显示「将同步到 …」（不含密码）。 */
export function webdavDisplayUrl(config = {}) {
  if (!config.url) return ''
  let base
  try {
    base = new URL(config.url)
  } catch {
    return config.url
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const prefix = config.prefix ? `${config.prefix}/` : ''
  return `${base.origin}${decodePathname(base.pathname)}${prefix}${SYNC_NAMESPACE}`
}

/**
 * 一次同步的远端配置：{ store: 's3' | 'webdav' | 'folder', s3: {...}, webdav: {...}, folder: {...} }。
 * 几套配置都留在 settings.json 里，切类型不用重填。
 * 没填全在这里就拦下来，一次把缺的字段都列出来（比构造函数里只说一个字段友好）。
 */
export function storeClient(config = {}) {
  if (!storeConfigured(config)) {
    throw new Error(`${storeLabel(config)} 还没填完：${storeMissing(config).join('、')}`)
  }
  switch (safeStoreType(config.store)) {
    case 'webdav': return new Webdav(config.webdav)
    case 'folder': return new LocalDir(config.folder)
    case 'zip': return new ZipStore(config.zip)
    default: return new S3(config.s3)
  }
}

export function storeConfigured(config = {}) {
  switch (safeStoreType(config.store)) {
    case 'webdav': return webdavConfigured(config.webdav)
    case 'folder': return folderConfigured(config.folder)
    case 'zip': return zipConfigured(config.zip)
    default: return s3Configured(config.s3)
  }
}

export function storeMissing(config = {}) {
  switch (safeStoreType(config.store)) {
    case 'webdav': return webdavMissing(config.webdav)
    case 'folder': return folderMissing(config.folder)
    case 'zip': return zipMissing(config.zip)
    default: return s3Missing(config.s3)
  }
}

export function storeDisplayUrl(config = {}) {
  switch (safeStoreType(config.store)) {
    case 'webdav': return webdavDisplayUrl(config.webdav || {})
    case 'folder': return folderDisplayUrl(config.folder || {})
    case 'zip': return zipDisplayUrl(config.zip || {})
    default: return s3DisplayUrl(config.s3 || {})
  }
}

/** 哪种存储的人类叫法（日志、界面提示用）。 */
export function storeLabel(config = {}) {
  switch (safeStoreType(config.store)) {
    case 'webdav': return 'WebDAV'
    case 'folder': return '本地目录'
    case 'zip': return 'ZIP 文件'
    default: return 'S3 兼容存储'
  }
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
    return `${prefix}${SYNC_NAMESPACE}`
  }

  /** 键 → 请求路径（路径风格带桶名，虚拟主机风格不带）。 */
  pathFor(key) {
    const encoded = uriEncode(key, false)
    if (this.style === 'path') return `/${uriEncode(this.config.bucket)}/${encoded}`
    return `/${encoded}`
  }

  /**
   * 发一个请求。返回 { status, headers, stream }；正文由调用方消费（上传大文件要流式）。
   * 连接层的抖动（超时、断流、DNS）在这里退避重试；服务端回的 5xx / 429 交给 withRetry。
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
    throw httpError(s3ErrorMessage(result.status, text), result.status)
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
      throw httpError(s3ErrorMessage(result.status, text), result.status)
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
   * 最后把 mtime 对齐成远端的时间——下一次上传就不用再传一遍。
   */
  async getFile(key, dest, { lastModifiedMs = 0, mkdirTo = true } = {}) {
    const result = await this.send({ method: 'GET', path: this.pathFor(key), payloadHash: sha256Hex('') })
    if (result.status !== 200) {
      const text = await readAll(result.stream)
      throw httpError(s3ErrorMessage(result.status, text), result.status)
    }
    return writeStreamToFile(result.stream, dest, { lastModifiedMs, mkdirTo })
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

  /** 同步页上显示「将同步到 …」（不含密钥）。 */
  get displayUrl() {
    return s3DisplayUrl(this.config)
  }

  /** 配置填全了没：没填全就抛出人话（两个后端同名的接口，引擎不关心是哪一种）。 */
  checkReady() {
    if (!s3Configured(this.config)) throw new Error(`存储桶还没填完：${s3Missing(this.config).join('、')}`)
  }

  /** 连通性自检：能不能走到这个桶、密钥认不认、命名空间下有没有东西。 */
  async test() {
    this.checkReady()
    const result = await this.send({
      method: 'GET',
      path: this.pathFor(''),
      query: { 'list-type': '2', prefix: `${this.namespace}/`, 'max-keys': '1', 'encoding-type': 'url' },
      payloadHash: sha256Hex(''),
    })
    const text = await this.expect(result)
    const parsed = parseListXml(text)
    return {
      empty: parsed.contents.length === 0,
      namespace: this.namespace,
      host: this.host,
      detail: this.style === 'path' ? 'S3 · 路径风格' : 'S3 · 虚拟主机',
    }
  }
}

/**
 * WebDAV 客户端（Basic 认证）：只做同步用得上的四个动作——PROPFIND 列目录、
 * MKCOL 建目录、PUT 上传、GET 下载。和 S3 那套同一个接口，引擎不关心用的是哪种。
 *
 * 两点和 S3 不一样，都是 WebDAV 协议本身的限制：
 * - **没有前缀列举**：只能一层一层 Depth: 1 地走，所以 list() 是 BFS，请求数 ≈ 目录数。
 *   坚果云免费版有请求频率限制（每小时几百次），目录多的时候会把配额吃掉一部分。
 * - **上传前得自己保证父集合存在**：MKCOL 逐级建（列过目录的层级会记在 collections 里，
 *   不重复发请求），否则 PUT 会 409 Conflict。
 */
export class Webdav {
  constructor(config) {
    this.config = safeWebdavConfig(config)
    if (!this.config.url) throw new Error('还没填 WebDAV 地址')
    let base
    try {
      base = new URL(this.config.url)
    } catch {
      throw new Error('WebDAV 地址不是个能解析的地址')
    }
    // 一律按「集合」理解：末尾补斜杠，之后所有路径都从这里拼
    if (!base.pathname.endsWith('/')) base.pathname += '/'
    this.base = base
    this.basePath = base.pathname
    this.basePathDecoded = decodePathname(base.pathname)
    this.secure = base.protocol === 'https:'
    this.agent = this.secure && this.config.insecure ? new Agent({ rejectUnauthorized: false }) : undefined
    /** 这次跑已经确认存在的集合（列过或建过），省掉重复的 MKCOL。 */
    this.collections = new Set()
    this.authorization = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`
  }

  /** 用户填的前缀 + 命名空间：所有键都在这下面。 */
  get namespace() {
    const prefix = this.config.prefix ? `${this.config.prefix}/` : ''
    return `${prefix}${SYNC_NAMESPACE}`
  }

  get displayUrl() {
    return webdavDisplayUrl(this.config)
  }

  checkReady() {
    if (!webdavConfigured(this.config)) throw new Error(`WebDAV 还没填完：${webdavMissing(this.config).join('、')}`)
  }

  /** 键 → 完整地址（每段单独编码，斜杠保留）。 */
  urlFor(key) {
    const encoded = String(key).split('/').map((part) => encodeURIComponent(part)).join('/')
    return new URL(`${this.basePath}${encoded}`, this.base)
  }

  /** 集合地址：末尾要有斜杠，否则有些服务端会当成文件处理（甚至 301 掉）。 */
  dirUrl(key) {
    const text = String(key ?? '')
    return this.urlFor(text.endsWith('/') || text === '' ? text : `${text}/`)
  }

  /**
   * 发一个请求。返回 { status, headers, stream }。
   * 连接层的抖动在这里退避重试；服务端回的 5xx / 429 交给 withRetry。
   */
  async send({ method, url, headers = {}, file, body, size }, attempt = 0) {
    const options = {
      method,
      host: url.hostname,
      path: `${url.pathname}${url.search}`,
      port: url.port || (this.secure ? 443 : 80),
      headers: {
        authorization: this.authorization,
        'user-agent': USER_AGENT,
        ...headers,
      },
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
          request.destroy(new Error('连接空闲超时（网络太慢或服务端不通）'))
        })
        request.on('error', reject)
        if (file) {
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
        return this.send({ method, url, headers, file, body, size }, attempt + 1)
      }
      throw new Error(describeNetworkError(error, url.host))
    }
  }

  /** 读干正文并校验状态码；错了抛出带人话的错。 */
  async expect(result, allowed = [200]) {
    const text = (await readAll(result.stream)).toString('utf8')
    if (allowed.includes(result.status)) return text
    throw httpError(webdavErrorMessage(result.status, text), result.status)
  }

  /** PROPFIND 一个集合。集合不存在返回 null（第一次同步时各处都还不存在）。 */
  async propfind(key, depth = 1) {
    const body = PROPFIND_BODY
    const result = await this.send({
      method: 'PROPFIND',
      url: this.dirUrl(key),
      headers: { depth: String(depth), 'content-type': 'application/xml; charset=utf-8' },
      body,
      size: Buffer.byteLength(body),
    })
    const text = (await readAll(result.stream)).toString('utf8')
    if (result.status === 404) return null
    if (result.status !== 207 && result.status !== 200) {
      throw httpError(webdavErrorMessage(result.status, text), result.status)
    }
    this.collections.add(String(key ?? ''))
    return parsePropfindXml(text, this.basePathDecoded)
  }

  /**
   * 列一个前缀下的所有文件。WebDAV 只能逐层走，所以是广度优先：
   * 每层一次 PROPFIND Depth: 1，集合继续排队，文件进结果。
   */
  async list(prefixKey, { maxCollections = 4000 } = {}) {
    const out = new Map()
    const queue = [String(prefixKey ?? '')]
    const seen = new Set()
    let visited = 0
    while (queue.length) {
      const dir = queue.shift()
      if (seen.has(dir)) continue
      seen.add(dir)
      visited += 1
      if (visited > maxCollections) {
        throw new Error(`远端目录太多（超过 ${maxCollections} 层），这个范围的同步先停一下——是不是把别的目录也框进来了？`)
      }
      const entries = await this.propfind(dir, 1)
      if (!entries) continue
      for (const entry of entries) {
        if (entry.path === dir || entry.path === `${dir}/`) continue
        if (entry.isCollection) {
          queue.push(entry.path)
          continue
        }
        out.set(entry.path, {
          key: entry.path,
          size: entry.size,
          lastModifiedMs: entry.lastModifiedMs,
          etag: '',
        })
      }
    }
    return out
  }

  /** 逐级建集合（已存在的 405 当成功）。 */
  async ensureParents(key) {
    const parts = String(key).split('/')
    parts.pop()
    let path = ''
    for (const part of parts) {
      path = path ? `${path}/${part}` : part
      if (this.collections.has(path)) continue
      const result = await this.send({ method: 'MKCOL', url: this.dirUrl(path) })
      const text = (await readAll(result.stream)).toString('utf8')
      // 405 = 已经在了；201 新建、200/204 也算成功
      if (result.status >= 400 && result.status !== 405) {
        throw httpError(webdavErrorMessage(result.status, text), result.status)
      }
      this.collections.add(path)
    }
  }

  async putFile(key, file, size, { contentType = 'application/octet-stream' } = {}) {
    await this.ensureParents(key)
    const result = await this.send({
      method: 'PUT',
      url: this.urlFor(key),
      headers: { 'content-type': contentType },
      file,
      size,
    })
    await this.expect(result, [200, 201, 204])
    return size
  }

  async putText(key, text, contentType = 'application/json') {
    return this.putBuffer(key, Buffer.from(text, 'utf8'), contentType)
  }

  async putBuffer(key, buffer, contentType = 'application/octet-stream') {
    await this.ensureParents(key)
    const result = await this.send({
      method: 'PUT',
      url: this.urlFor(key),
      headers: { 'content-type': contentType },
      body: buffer,
      size: buffer.length,
    })
    await this.expect(result, [200, 201, 204])
    return buffer.length
  }

  /** 下载到文件（临时文件 + 改名 + mtime 对齐，和 S3 那条路共用实现）。 */
  async getFile(key, dest, { lastModifiedMs = 0, mkdirTo = true } = {}) {
    const result = await this.send({ method: 'GET', url: this.urlFor(key) })
    if (result.status !== 200 && result.status !== 206) {
      const text = (await readAll(result.stream)).toString('utf8')
      throw httpError(webdavErrorMessage(result.status, text), result.status)
    }
    return writeStreamToFile(result.stream, dest, { lastModifiedMs, mkdirTo })
  }

  /** 读一个对象成文本（远端 profile 清单用这个）。不存在返回 null。 */
  async getText(key) {
    const result = await this.send({ method: 'GET', url: this.urlFor(key) })
    const text = await readAll(result.stream)
    if (result.status === 404) return null
    if (result.status !== 200) throw httpError(webdavErrorMessage(result.status, text.toString('utf8')), result.status)
    return text.toString('utf8')
  }

  /** 连通性自检：地址通不通、账号对不对、我们的目录里有没有东西。 */
  async test() {
    this.checkReady()
    const root = await this.propfind('', 0)
    if (!root) throw new Error('WebDAV 地址打不开：服务端说找不到这个集合（检查地址里的目录名对不对）')
    const entries = await this.propfind(this.namespace, 1)
    // Depth: 1 会把自己也带回来，减掉它再看有没有东西（目录也算「有东西」）
    const children = (entries || []).filter((entry) => entry.path !== this.namespace && entry.path !== `${this.namespace}/`)
    return {
      empty: children.length === 0,
      namespace: this.namespace,
      host: this.base.host,
      detail: `WebDAV · ${this.secure ? 'https' : 'http'}`,
    }
  }
}

/**
 * 本地目录：把同一套内容**导出**到一个文件夹，或从那个文件夹**导入**。
 *
 * 不联网、不要账号——就是「手动导出 / 导入」：导出的目录可以拷到移动硬盘、丢进网盘
 * 的同步盘、或者整个打包发人。目录布局与远端一模一样（`dsh-x/v1/…`），所以它既能当
 * 备份，也能当两台机器之间的中转站。
 *
 * 两个细节：
 * - 拷贝后把时间戳对齐成源文件的（导出时对齐本机、导入时对齐目录里的），否则下一轮
 *   比对会以为「本机更新了」把整个目录重传一遍；
 * - 导出目录不能落在会被同步的目录里（`~/.dsh` 里面），不然会自己套自己——这条在
 *   runSync 里挡（这里拿不到 home）。
 */
export class LocalDir {
  constructor(config) {
    this.config = safeFolderConfig(config)
    if (!this.config.path) throw new Error('还没选导出目录')
    this.root = this.config.path
  }

  /** 导出目录里也是同一套命名空间，方便和远端互换。 */
  get namespace() {
    return SYNC_NAMESPACE
  }

  get displayUrl() {
    return this.root
  }

  checkReady() {
    if (!this.config.path) throw new Error('本地目录还没选：填一个目录，或点「浏览…」')
  }

  /** 键 → 绝对路径（键里的每段都先过一遍路径安全检查）。 */
  pathFor(key) {
    const parts = String(key).split('/')
    if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`导出目录里的路径不合法：${key}`)
    }
    return join(this.root, ...parts)
  }

  /** 列一个前缀下的文件（就是本机扫描，跳过我们自己的临时/副本文件）。 */
  async list(prefixKey) {
    const base = this.pathFor(prefixKey)
    const out = new Map()
    for (const file of walkFiles(base)) {
      const key = `${prefixKey}/${file.rel}`
      out.set(key, { key, size: file.size, lastModifiedMs: file.mtimeMs, etag: '' })
    }
    return out
  }

  /** 导出：拷过去，并把时间戳对齐成源文件的。 */
  async putFile(key, file, size) {
    const dest = this.pathFor(key)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(file, dest)
    await copyTimes(file, dest)
    return size
  }

  async putText(key, text, contentType = 'application/json') {
    return this.putBuffer(key, Buffer.from(text, 'utf8'), contentType)
  }

  async putBuffer(key, buffer) {
    const dest = this.pathFor(key)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buffer)
    return buffer.length
  }

  /** 导入：拷回来（先写 .sync-part 再改名，和时间戳对齐都跟远端那条路一个口径）。 */
  async getFile(key, dest, { lastModifiedMs = 0, mkdirTo = true } = {}) {
    const source = this.pathFor(key)
    let bytes = 0
    try {
      bytes = statSync(source).size
    } catch {
      throw new Error(`导出目录里没有这个文件：${key}（重新导出一次？）`)
    }
    if (mkdirTo) await mkdir(dirname(dest), { recursive: true })
    const temp = `${dest}.sync-part`
    await copyFile(source, temp)
    await rm(dest, { force: true })
    await rename(temp, dest)
    await touch(dest, lastModifiedMs)
    return bytes
  }

  async getText(key) {
    try {
      return await readFile(this.pathFor(key), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return null
      throw error
    }
  }

  /** 自检：目录能不能用、里面有没有东西。 */
  async test() {
    this.checkReady()
    await mkdir(this.root, { recursive: true })
    // 写一个探针文件，确认真的能写（目录已存在但只读是常见坑）
    const probe = join(this.root, '.dsh-sync-probe')
    try {
      await writeFile(probe, '')
      await rm(probe, { force: true })
    } catch (error) {
      throw new Error(`这个目录写不了：${this.root}（${error?.code || error?.message}）`)
    }
    const files = await this.list(this.namespace)
    return {
      empty: files.size === 0,
      namespace: this.namespace,
      host: this.root,
      detail: '本地目录',
    }
  }
}

/**
 * ZIP 文件：把同一套内容**导出成一个 .zip / 从 .zip 导入**——「一个文件走天下」。
 *
 * 和别的后端不一样的地方：ZIP 不是能随手改的存储，写它得整份重写一遍。所以这里把写攒到
 * `finish()`（引擎跑完所有范围之后调一次）：
 * - 旧档案里已有的条目**原样搬压缩数据**（不解压也不重压），只把这次改动的条目换掉；
 * - 于是导出是增量的（不会每次都重压几十 MB），但产出的永远是一份完整、干净的档案；
 * - 导入方向只读不写，`finish()` 什么都不做。
 *
 * 另外宽容一层：用户很可能把「导出目录」手动压成 zip 再拿来导入，里面会多套一层文件夹
 * （`dsh-backup/dsh-x/v1/…`），列目录时会把 `dsh-x/v1/` 前面那截剥掉。
 */
export class ZipStore {
  constructor(config) {
    this.config = safeZipConfig(config)
    if (!this.config.path) throw new Error('还没选 ZIP 文件')
    this.path = this.config.path
    /** 这次要写进档案的条目：key → { file | buffer, mtime }。 */
    this.pending = new Map()
    /** 旧档案的索引，第一次列目录时读一次。 */
    this.index = null
  }

  get namespace() {
    return SYNC_NAMESPACE
  }

  get displayUrl() {
    return this.path
  }

  checkReady() {
    if (!this.config.path) throw new Error('ZIP 文件还没选：填一个 .zip 路径，或点「浏览…」')
  }

  /** 读一次旧档案的索引（不存在就是空档案）。 */
  async readIndex() {
    if (this.index) return this.index
    this.index = new Map()
    if (!existsSync(this.path)) return this.index
    if (!(await looksLikeZip(this.path))) {
      throw new Error(`${this.path} 不是个 ZIP 文件（导入要选之前导出的那个；导出会覆盖它）`)
    }
    const { entries } = await readZipIndex(this.path)
    const root = `${SYNC_NAMESPACE}`
    const marker = `${SYNC_NAMESPACE}/`
    for (const entry of entries.values()) {
      const name = entry.name
      if (name === root || name === marker) continue
      // 名字里找 dsh-x/v1/ 的位置：自己的包从头就是，手动压过一层的话前面会多一截
      const at = name.indexOf(marker)
      if (at < 0) continue
      this.index.set(name.slice(at), entry)
    }
    return this.index
  }

  /** 列一个前缀下的条目（读旧档案 + 这次已经攒下的改动）。 */
  async list(prefixKey) {
    const index = await this.readIndex()
    const prefix = `${prefixKey}/`
    const out = new Map()
    for (const [key, entry] of index) {
      if (!key.startsWith(prefix)) continue
      out.set(key, { key, size: entry.size, lastModifiedMs: entry.mtime.getTime(), etag: '' })
    }
    for (const [key, item] of this.pending) {
      if (!key.startsWith(prefix)) continue
      out.set(key, {
        key,
        size: item.buffer ? item.buffer.length : safeSize(item.file),
        lastModifiedMs: (item.mtime || new Date()).getTime(),
        etag: '',
      })
    }
    return out
  }

  async putFile(key, file, size) {
    this.pending.set(key, { file, mtime: safeMtime(file) })
    return size
  }

  async putText(key, text, contentType = 'application/json') {
    return this.putBuffer(key, Buffer.from(text, 'utf8'), contentType)
  }

  async putBuffer(key, buffer) {
    this.pending.set(key, { buffer })
    return buffer.length
  }

  /** 从档案里解出条目写到本地（临时文件 + 改名 + 时间戳对齐，和别的后端一个口径）。 */
  async getFile(key, dest, { lastModifiedMs = 0, mkdirTo = true } = {}) {
    const entry = (await this.readIndex()).get(key)
    if (!entry) throw new Error(`ZIP 里没有 ${key}（重新导出一次？）`)
    if (mkdirTo) await mkdir(dirname(dest), { recursive: true })
    const temp = `${dest}.sync-part`
    const chunks = []
    try {
      await readZipEntry(this.path, entry, (chunk) => { chunks.push(chunk) })
      await writeFile(temp, Buffer.concat(chunks))
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    await rm(dest, { force: true })
    await rename(temp, dest)
    await touch(dest, lastModifiedMs || entry.mtime.getTime())
    return entry.size
  }

  async getText(key) {
    const entry = (await this.readIndex()).get(key)
    if (!entry) return null
    return (await readZipEntry(this.path, entry)).toString('utf8')
  }

  /** 自检：档案能不能写、里面有没有东西。 */
  async test() {
    this.checkReady()
    await mkdir(dirname(this.path), { recursive: true })
    const files = [...(await this.readIndex()).keys()]
    return {
      empty: files.length === 0,
      namespace: this.namespace,
      host: this.path,
      detail: files.length ? `ZIP · 已有 ${files.length} 个文件` : 'ZIP · 还没有内容（导出时会新建）',
    }
  }

  /**
   * 收尾：这次改动的条目 + 旧档案里没动的条目 → 写一份新档案。
   * 什么都没改就原样不动（导入方向走到这里必然是空的）。
   */
  async finish() {
    if (!this.pending.size) return ''
    const index = await this.readIndex().catch(() => new Map())
    const entries = []
    for (const [key, entry] of index) {
      if (this.pending.has(key)) continue
      entries.push({ name: key, copy: { file: this.path, entry } })
    }
    for (const [key, item] of this.pending) {
      entries.push(item.buffer ? { name: key, buffer: item.buffer } : { name: key, file: item.file, mtime: item.mtime })
    }
    await mkdir(dirname(this.path), { recursive: true })
    const result = await writeZip(this.path, entries)
    this.pending.clear()
    this.index = null
    const kb = result.size < 1024 ? `${result.size} B` : `${(result.size / 1024).toFixed(1)} KB`
    return `ZIP 已更新：${result.entries} 个文件（${kb}）`
  }
}

/** 源文件的修改时间 / 大小（读不到就用退路值，别把整个导出带崩）。 */
function safeMtime(file) {
  try {
    return statSync(file).mtime
  } catch {
    return new Date()
  }
}

function safeSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** 把 a 的修改时间复制给 b（源文件读不到时间就算了）。 */
async function copyTimes(source, dest) {
  try {
    const info = statSync(source)
    await touch(dest, info.mtimeMs)
  } catch {
    // 对齐失败不影响内容
  }
}

async function touch(file, timeMs) {
  if (!timeMs) return
  const seconds = timeMs / 1000
  try {
    await utimes(file, seconds, seconds)
  } catch {
    // 同上：顶多多传一遍
  }
}

function retryableError(error) {
  const code = String(error?.code || '')
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND'].includes(code)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 带上状态码的错误：上层据此判断值不值得重试。 */
function httpError(message, status) {
  const error = new Error(message)
  error.status = status
  error.transient = (status >= 500 && status < 600) || status === 429 || status === 408
  return error
}

/**
 * 重试一个操作：网络抖动已经在各自的 send() 里退避重试过了，这里管的是**服务端**的
 * 临时故障——5xx、429（坚果云这类网盘会限流）、408。PUT/GET 都是幂等的，重来没坏处；
 * 连着失败就到顶抛出，别把用户晾在那儿。
 */
export async function withRetry(work, { attempts = RETRIES + 1, onRetry = () => {} } = {}) {
  let attempt = 0
  for (;;) {
    try {
      return await work()
    } catch (error) {
      const transient = error?.transient === true || (Number(error?.status) >= 500 && Number(error?.status) < 600)
      if (!transient || attempt + 1 >= attempts) throw error
      await delay(400 * 2 ** attempt)
      attempt += 1
      onRetry(attempt, error)
    }
  }
}

/** 只问我们要的三样：是不是集合、多大、什么时候改的。 */
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getlastmodified/></prop></propfind>'

/** 路径里的百分号编码解回人话（解不开就原样——文件名里真有 % 的少见但不是不可能）。 */
export function decodePathname(pathname) {
  try {
    return decodeURIComponent(String(pathname ?? ''))
  } catch {
    return String(pathname ?? '')
  }
}

/**
 * 解析 PROPFIND 的 207 响应。
 *
 * 各家的 XML 命名空间前缀各不相同（`d:`、`D:`、`lp1:`，甚至不带前缀），所以按**本地名**
 * 匹配，不看前缀；href 可能是完整 URL、也可能只有路径，还可能带着百分号编码，
 * 统一解成「相对用户填的那个目录的路径」当键。
 */
export function parsePropfindXml(xml, basePathDecoded = '/') {
  const results = []
  const text = String(xml ?? '')
  for (const match of text.matchAll(/<(?:\w+:)?response\b[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/g)) {
    const block = match[1]
    const pick = (name) => {
      const found = new RegExp(`<(?:(?:\\w+):)?${name}\\b[^>]*>([\\s\\S]*?)</(?:(?:\\w+):)?${name}>`).exec(block)
      return found ? xmlDecode(found[1]).trim() : ''
    }
    const href = pick('href')
    if (!href) continue
    const isCollection = /<(?:\w+:)?collection\b/.test(block)
    let path = href
    try {
      path = decodePathname(new URL(href, 'http://x/').pathname)
    } catch {
      path = decodePathname(href)
    }
    if (path.startsWith(basePathDecoded)) path = path.slice(basePathDecoded.length)
    path = path.replace(/^\/+/, '').replace(/\/+$/, '')
    const size = Number(pick('getcontentlength'))
    results.push({
      href,
      path,
      isCollection,
      size: Number.isFinite(size) ? size : 0,
      lastModifiedMs: Date.parse(pick('getlastmodified')) || 0,
    })
  }
  return results
}

/** WebDAV 的状态码 → 人话。401/403 基本都是账号或权限问题。 */
export function webdavErrorMessage(status, xml = '') {
  const known = {
    400: '服务端说请求不合法（地址里有特殊字符？）',
    401: '认证失败：用户名或密码不对',
    403: '没有权限：这个账号不能写这个目录',
    404: '远端没有这个路径（检查 WebDAV 地址里的目录名）',
    405: '服务端不允许这个操作（有些网盘关掉了 MKCOL 或 PUT）',
    409: '父目录不存在（服务端拒绝了创建）',
    412: '服务端的条件请求失败（并发写冲突，稍后再试）',
    423: '目标被锁住了（有别的客户端正在写这个文件）',
    507: '远端空间不足',
  }
  const hint = known[status] || ''
  const message = xmlDecode((/<(?:\w+:)?message[^>]*>([\s\S]*?)<\/(?:\w+:)?message>/.exec(String(xml ?? '')) || [])[1] || '').trim()
  // 服务端常把「Unauthorized」这类标准短语塞进 message，跟前面那句重复，就别拼上去了
  const standard = /^(unauthorized|forbidden|not found|conflict|bad request|method not allowed|precondition failed|locked|insufficient storage|service unavailable)$/i
  const extra = message && !standard.test(message) ? message : ''
  return [hint || extra || `HTTP ${status}`, hint && extra ? extra : ''].filter(Boolean).join('：')
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

/**
 * 响应流落到本地文件：先写 .sync-part 再改名，下载中途断了不会留下半个文件冒充完整的；
 * 最后把 mtime 对齐成远端给的时间（否则刚拉下来的文件会被下一次上传当成「本机更新」）。
 * S3 与 WebDAV 两条路共用这一段。
 */
async function writeStreamToFile(stream, dest, { lastModifiedMs = 0, mkdirTo = true } = {}) {
  if (mkdirTo) await mkdir(join(dest, '..'), { recursive: true })
  const temp = `${dest}.sync-part`
  let bytes = 0
  try {
    await pipeline(
      stream.on('data', (chunk) => { bytes += chunk.length }),
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

/** 去掉若干依赖（顺带从 bundles 里摘掉同名条目）。 */
function withoutDeps(manifest, names) {
  const drop = new Set(names)
  const dependencies = {}
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
    if (!drop.has(name)) dependencies[name] = manifest.dependencies[name]
  }
  return removeBundles({ ...manifest, dependencies }, names)
}

/**
 * 合并两台机器的 profile 清单：
 * - dependencies 取并集，同名时版本号大的赢（比不出来就听本机的）；
 * - dsh.profile.bundles 取并集；只有「因为它指向本机不存在的本地路径而摘掉的依赖」才会从
 *   bundles 里一并摘掉（官方 dsh-base / dsh-web-app 只在 bundles 里、不在 dependencies 里，
 *   不能按 dependencies 过滤，否则误删）；
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
  return { manifest: removeBundles({ ...manifest, dependencies }, dropped.map((item) => item.name)), dropped }
}

/**
 * 从 bundles 里摘掉指定名字（只摘这些——**不能**写成「只留 dependencies 里有的」：
 * 官方那两个包 @deepseek-ai/dsh-base / dsh-web-app 只出现在 dsh.profile.bundles 里、
 * 不在 dependencies 里，按 dependencies 过滤会把它们误删，profile 直接起不来）。
 */
function removeBundles(manifest, names) {
  const drop = new Set(names)
  if (!manifest.dsh?.profile || !Array.isArray(manifest.dsh.profile.bundles)) return manifest
  return {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh.profile,
        bundles: manifest.dsh.profile.bundles.filter((name) => !drop.has(name)),
      },
    },
  }
}

// ---------------------------------------------------------------- 跑一次同步

/**
 * 跑一次同步。调用方给方向、范围、冲突策略和上下文（本机目录），
 * 过程通过 onProgress 报告，随时可以 shouldStop() 喊停。
 * config 是远端配置：{ store: 's3' | 'webdav', s3: {...}, webdav: {...} }。
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
  const client = storeClient(config)
  client.checkReady()
  // 导出目录不能落在会被同步的目录里：第一次导出会把备份也写进去，第二次再把备份的备份
  // 算进来，越滚越大。这条只有本地目录这种后端需要管。
  if (client instanceof LocalDir) {
    const root = resolve(client.root)
    const guarded = [context?.home, context?.profileDir, ...(context?.roots || []).map((item) => item.dir)]
      .filter(Boolean)
      .map((dir) => resolve(dir))
    const inside = guarded.find((dir) => root === dir || root.startsWith(`${dir}${sep}`))
    if (inside) {
      throw new Error(`导出目录不能放在会被同步的目录里（${inside}），换个地方，比如 D:\\dsh-backup`)
    }
  }
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
    // 列目录也可能撞上服务端的临时故障（5xx / 限流），重试一下再放弃
    const remote = await withRetry(() => client.list(prefix))
    // 技能有两个根，前缀不止一个：按每个根各列一次，合并成一张表
    for (const target of targets.slice(1)) {
      const more = await withRetry(() => client.list(`${client.namespace}/${target.prefix}`))
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
      // 单文件失败时把键名带上：不然只有一句「S3 请求失败」，几十个文件里根本不知道是哪个。
      // 服务端的临时故障（5xx / 限流）在这里退避重试：PUT 与 GET 都幂等，重来一次没坏处。
      const guard = async (action, work) => {
        try {
          return await withRetry(work)
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
  // 有的后端要收尾（ZIP：所有条目都定了才写档案）。别的后端没这个方法，跳过。
  if (typeof client.finish === 'function' && !summary.stopped) {
    const written = await client.finish()
    if (written) summary.notes.push(written)
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
  const at = parts.indexOf(SYNC_NAMESPACE.split('/')[0])
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
