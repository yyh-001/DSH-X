/**
 * 最小 ZIP 读写：整合包（.dspack）就是一个 ZIP，而启动器不带任何依赖——npm 包里没有
 * zip 库，Node 也没内置，所以这里手写一份，够读别人的包、也够写我们自己的。
 *
 * 只做 store 与 deflate 两种方式（所有打包工具默认都用这两种），加密和 ZIP64 直接拒绝：
 * 那两种形状这个启动器没有场景，硬着头皮解析只会读出一堆错数据。
 *
 * 读出来的条目只做「名字 + 内容」两件事，路径安全由调用方（packs.js）判定——
 * 这里是纯字节层，不猜任何业务语义。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
/** 32 位字段里的「见 ZIP64 扩展」标记。 */
const ZIP64_MARK = 0xffffffff
/** ZIP 里的文件名按规范是 UTF-8，但 Windows 老工具会写本地代码页，这里只认 UTF-8。 */
const FLAG_UTF8 = 0x0800

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** ZIP 条目与整包校验都用它（和 PNG / gzip 同一个多项式）。 */
export function crc32(buffer) {
  let value = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/**
 * 从尾部找中央目录结束记录：注释最长 65535，所以只扫最后这么多字节。
 *
 * 光看签名不够——普通文本里也可能凑巧出现这四个字节，所以还要过一遍自洽检查
 * （注释长度对得上、中央目录落在文件里、第一条条目的签名正确）。
 */
function findEndOfCentralDirectory(buffer) {
  const from = Math.max(0, buffer.length - 65557)
  for (let at = buffer.length - 22; at >= from; at -= 1) {
    if (buffer.readUInt32LE(at) !== SIG_EOCD) continue
    const commentLength = buffer.readUInt16LE(at + 20)
    if (at + 22 + commentLength !== buffer.length) continue
    const count = buffer.readUInt16LE(at + 10)
    const size = buffer.readUInt32LE(at + 12)
    const offset = buffer.readUInt32LE(at + 16)
    // 32 位字段被写成 ZIP64 标记时值本身就不可信，交给调用方报「不支持 ZIP64」
    const zip64 = count === 0xffff || size === ZIP64_MARK || offset === ZIP64_MARK
    if (!zip64 && offset + size > at) continue
    if (!zip64 && count > 0 && buffer.readUInt32LE(offset) !== SIG_CENTRAL) continue
    return at
  }
  return -1
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** 条目名统一用正斜杠；写包的调用方给什么都按这个归一。 */
function normalizeEntryName(name) {
  return String(name ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * 读一个 ZIP，返回 `{ entries: [{ name, dir, size, data }] }`。
 *
 * 每个条目的内容都过一次 CRC 校验：整合包是从网上来的，静默读出半截数据比报错危险得多。
 */
export function readZip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length < 22) throw new Error('不是 ZIP：文件太小')
  // ZIP 一定以本地文件头的 'PK' 开头：这一条就能把普通文本、图片挡在外面
  if (buffer.readUInt16LE(0) !== 0x4b50) throw new Error('不是 ZIP：开头没有 PK 标记')
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('不是 ZIP：找不到中央目录（文件可能被截断）')
  const count = buffer.readUInt16LE(eocd + 10)
  const size = buffer.readUInt32LE(eocd + 12)
  const offset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || size === ZIP64_MARK || offset === ZIP64_MARK) {
    throw new Error('不支持 ZIP64 格式的压缩包')
  }
  if (offset + size > buffer.length) throw new Error('ZIP 中央目录越界（文件可能被截断）')

  const entries = []
  let cursor = offset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error('ZIP 中央目录损坏')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const storedCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength

    if (flags & 0x01) throw new Error(`压缩包已加密，无法读取：${name}`)
    if (compressedSize === ZIP64_MARK || uncompressedSize === ZIP64_MARK) {
      throw new Error(`不支持 ZIP64 条目：${name}`)
    }
    if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式（${method}）：${name}`)
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`ZIP 条目头损坏：${name}`)
    }
    // 本地头里的名字/扩展区长度可能和中央目录不同（尤其带数据描述符的包），必须读本地头
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const from = localOffset + 30 + localNameLength + localExtraLength
    if (from + compressedSize > buffer.length) throw new Error(`ZIP 条目数据越界：${name}`)
    const raw = buffer.subarray(from, from + compressedSize)
    let data
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    } catch (error) {
      // zlib 报的是它自己的话（invalid code lengths set 之类），这里换成能看懂的说法
      throw new Error(`ZIP 条目解压失败（文件损坏？）：${name} —— ${error.message}`)
    }
    if (data.length !== uncompressedSize) throw new Error(`ZIP 条目长度对不上：${name}`)
    if (crc32(data) !== storedCrc) throw new Error(`ZIP 条目校验失败：${name}`)

    const entryName = normalizeEntryName(name)
    entries.push({
      name: entryName,
      dir: entryName.endsWith('/'),
      size: uncompressedSize,
      data,
    })
  }
  return { entries }
}

/**
 * 写一个 ZIP，entries 是 `[{ name, data }]`（data 为 Buffer 或字符串）。
 *
 * 目录条目不用给：解包方看到 `a/b/c.txt` 会自己建目录。压缩后更大的条目（小文件很常见）
 * 原样存，省得包比内容还大。
 */
export function writeZip(entries, { date = new Date() } = {}) {
  const stamp = dosDateTime(date)
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(normalizeEntryName(entry.name), 'utf8')
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data === undefined || entry.data === null ? '' : String(entry.data), 'utf8')
    const crc = crc32(raw)
    const deflated = deflateRawSync(raw, { level: 9 })
    const method = deflated.length < raw.length ? 8 : 0
    const payload = method === 8 ? deflated : raw

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, payload)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(SIG_CENTRAL, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(FLAG_UTF8, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(stamp.time, 12)
    header.writeUInt16LE(stamp.date, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(payload.length, 20)
    header.writeUInt32LE(raw.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)

    offset += local.length + name.length + payload.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, eocd])
}
