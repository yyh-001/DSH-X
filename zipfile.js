/**
 * 最小 ZIP 读写（给「导出成一个 .zip / 从 .zip 导入」用）。
 *
 * 启动器零依赖：npm 包里没有 zip 库，Node 也没内置，所以自己写一份。只做 store 与 deflate
 * 两种方式（所有常见打包工具默认都用这两种），ZIP64 / 加密 / 别的压缩算法直接拒绝——
 * 那些形状同步场景里不会遇到，硬着头皮解析只会读出坏数据。
 *
 * 写的时候用「先占位再回填」：本地头里要写 CRC 和压缩后大小，而这两个值只有压完才知道，
 * 所以先把头写出去、流式压完，再用 fs 的随机写把 12 个字节填回去——这样不用把整个文件
 * 读进内存（会话记录加起来几十 MB）。
 */
import { createReadStream } from 'node:fs'
import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw, createInflateRaw } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
/** 单个文件 / 整个档案的上限：超过 4GB 就要 ZIP64，我们不支持（也不该有这种用法）。 */
const MAX_SIZE = 0xffffffff
const MAX_ENTRIES = 0xffff
/** 已经压过的文件就别再压一遍了（zstd/jsonl.zstd/png…），省时间也让结果不变大。 */
const NO_RECOMPRESS_RE = /\.(zst|zstd|gz|tgz|zip|png|jpe?g|webp|gif|mp4|mov|7z|rar|br|woff2?|pdf)$/i

/** CRC32（ZIP 每个条目都要），标准查表实现。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
    table[i] = value
  }
  return table
})()

export function crc32(buffer, seed = 0) {
  let crc = ~seed
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return ~crc >>> 0
}

/** 增量算 CRC 的小工具（流式写的时候用）。 */
export function crc32Stream(seed = 0) {
  let crc = ~seed
  return {
    update(chunk) {
      for (let i = 0; i < chunk.length; i += 1) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8)
    },
    digest: () => ~crc >>> 0,
  }
}

/** JS 时间 → DOS 日期时间（ZIP 的时间戳精度就 2 秒）。 */
export function toDosTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** DOS 日期时间 → JS 时间。 */
export function fromDosTime(time, day) {
  return new Date(
    1980 + ((day >> 9) & 0x7f),
    ((day >> 5) & 0x0f) - 1,
    day & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  )
}

/** 名字统一成「正斜杠、不带开头斜杠、不带 ./」——各家打包工具的写法都不一样。 */
export function normalizeZipName(name) {
  return String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/')
}

/**
 * 读出 zip 的中央目录（不解压数据）。
 * 返回 { entries: Map<name, {name, method, crc32, size, compressedSize, mtime, dataOffset, flags}> }。
 * 目录条目（名字以 / 结尾）会被跳过。
 */
export async function readZipIndex(file) {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (info.size < 22) throw new Error('这不是一个 ZIP 文件（太小了）')
    // EOCD 在最后，注释最长 64KB，从尾巴往前找签名
    const tailLength = Math.min(info.size, 22 + 0xffff)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, info.size - tailLength)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break }
    }
    if (eocd < 0) throw new Error('这不是一个 ZIP 文件（找不到中央目录）')
    const count = tail.readUInt16LE(eocd + 10)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    if (tail.readUInt16LE(eocd + 4) !== 0 || count === 0xffff || centralOffset === 0xffffffff) {
      throw new Error('这个 ZIP 用了 ZIP64（超过 4GB 或条目超过 65535 个），启动器的同步读不了')
    }
    const entries = new Map()
    const buffer = Buffer.alloc(46)
    let at = centralOffset
    for (let i = 0; i < count; i += 1) {
      await handle.read(buffer, 0, 46, at)
      if (buffer.readUInt32LE(0) !== SIG_CENTRAL) throw new Error('ZIP 的中央目录读坏了')
      const flags = buffer.readUInt16LE(8)
      const method = buffer.readUInt16LE(10)
      const time = buffer.readUInt16LE(12)
      const day = buffer.readUInt16LE(14)
      const crc = buffer.readUInt32LE(16)
      const compressedSize = buffer.readUInt32LE(20)
      const size = buffer.readUInt32LE(24)
      const nameLength = buffer.readUInt16LE(28)
      const extraLength = buffer.readUInt16LE(30)
      const commentLength = buffer.readUInt16LE(32)
      // 外部属性低字节的 0x10 是「这是个目录」——别的工具（如 PowerShell 的 Compress-Archive）会带目录条目，
      // 而 normalizeZipName 会把结尾的斜杠吃掉，不先认出来就会被当成 0 字节的文件
      const externalAttributes = buffer.readUInt32LE(38)
      const localOffset = buffer.readUInt32LE(42)
      const nameBuffer = Buffer.alloc(nameLength)
      if (nameLength) await handle.read(nameBuffer, 0, nameLength, at + 46)
      const rawName = nameBuffer.toString('utf8')
      if (flags & 0x1) throw new Error(`ZIP 里的 ${rawName} 是加密的，读不了`)
      if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
        throw new Error(`ZIP 里的 ${rawName} 用了不支持的压缩方式（method ${method}）`)
      }
      const isDirectory = /[/\\]$/.test(rawName) || (externalAttributes & 0x10) !== 0
      const name = normalizeZipName(rawName)
      if (name && !isDirectory) {
        entries.set(name, {
          name,
          method,
          crc32: crc,
          size,
          compressedSize,
          mtime: fromDosTime(time, day),
          // 本地头的 name/extra 长度可能和中央目录不一样，真正的数据偏移要现读本地头
          localOffset,
        })
      }
      at += 46 + nameLength + extraLength + commentLength
    }
    return { entries, size: info.size }
  } finally {
    await handle.close()
  }
}

/** 某个条目的数据在文件里的绝对偏移（读本地头算出来）。 */
async function dataOffsetOf(handle, entry) {
  const header = Buffer.alloc(30)
  await handle.read(header, 0, 30, entry.localOffset)
  if (header.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`ZIP 里的 ${entry.name} 本地头坏了`)
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  return entry.localOffset + 30 + nameLength + extraLength
}

/**
 * 解出一个条目的内容。
 * onChunk 给了就流式回调（大文件用），否则返回整个 Buffer。
 */
export async function readZipEntry(file, entry, onChunk) {
  const handle = await open(file, 'r')
  try {
    const start = await dataOffsetOf(handle, entry)
    if (!entry.compressedSize) {
      // 空文件：没有数据可读，直接给空（别让 createReadStream 拿到 start..start-1 这种反区间）
      if (onChunk) return null
      return Buffer.alloc(0)
    }
    const stream = handle.createReadStream({ start, end: start + entry.compressedSize - 1 })
    const source = entry.method === METHOD_DEFLATE ? stream.pipe(createInflateRaw()) : stream
    if (!onChunk) {
      const chunks = []
      for await (const chunk of source) chunks.push(chunk)
      const data = Buffer.concat(chunks)
      if (entry.size !== undefined && data.length !== entry.size) {
        throw new Error(`ZIP 里的 ${entry.name} 解出来是 ${data.length} 字节，应该是 ${entry.size} 字节`)
      }
      return data
    }
    for await (const chunk of source) onChunk(chunk)
    return null
  } finally {
    await handle.close()
  }
}

/**
 * 写一个 zip。entries 里的每一项是：
 * - { name, copy: { file, entry } }：从旧档案里原样搬（压缩数据直接拷，不解也不压，method 沿用源条目）
 * - { name, file, mtime? }：新文件，按需 deflate（已经压过的后缀原样存）
 * - { name, buffer, mtime? }：内存里的内容（配置那种小文件）
 * 写完先落 .sync-part 再改名——中途断了不会留下半个档案冒充完整的。
 *
 * 落盘只有一个出口：`sink` 串行地往文件里写并自己记偏移，回填 CRC 时再直接用文件句柄随机写。
 */
export async function writeZip(target, entries) {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`条目太多（${entries.length} 个），ZIP 装不下这么多文件，改用「本地目录」那一档吧`)
  }
  const temp = `${target}.sync-part`
  let handle = null
  let closed = false
  try {
    handle = await open(temp, 'w')
    let offset = 0
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        const at = offset
        offset += chunk.length
        handle.write(chunk, 0, chunk.length, at).then(() => callback(), callback)
      },
    })
    const put = (chunk) => new Promise((resolve, reject) => {
      sink.write(chunk, (error) => (error ? reject(error) : resolve()))
    })
    const patch = (at, buffer) => handle.write(buffer, 0, buffer.length, at)

    const central = []
    for (const item of entries) {
      const nameBuffer = Buffer.from(item.name, 'utf8')
      const sourceEntry = item.copy?.entry
      const mtime = item.mtime instanceof Date ? item.mtime
        : sourceEntry?.mtime instanceof Date ? sourceEntry.mtime
          : new Date(item.mtime || Date.now())
      const { time, date } = toDosTime(mtime)
      const stored = sourceEntry ? sourceEntry.method === METHOD_STORE : NO_RECOMPRESS_RE.test(item.name)
      const method = sourceEntry ? sourceEntry.method : (stored ? METHOD_STORE : METHOD_DEFLATE)

      const header = Buffer.alloc(30)
      header.writeUInt32LE(SIG_LOCAL, 0)
      header.writeUInt16LE(20, 4)        // version needed to extract
      header.writeUInt16LE(0x0800, 6)    // flags：文件名是 UTF-8
      header.writeUInt16LE(method, 8)
      header.writeUInt16LE(time, 10)
      header.writeUInt16LE(date, 12)
      // crc / 压缩后大小 / 原始大小先占位，压完用文件句柄回填（流式写没法提前知道）
      header.writeUInt32LE(0, 14)
      header.writeUInt32LE(0, 18)
      header.writeUInt32LE(0, 22)
      header.writeUInt16LE(nameBuffer.length, 26)
      header.writeUInt16LE(0, 28)
      const headerAt = offset
      await put(header)
      await put(nameBuffer)

      let crc = 0
      let compressedSize = 0
      let size = 0
      if (item.copy) {
        // 原样搬压缩数据：不重新压，快且不会让档案变形
        const entry = item.copy.entry
        const source = await open(item.copy.file, 'r')
        try {
          const start = await dataOffsetOf(source, entry)
          const buffer = Buffer.alloc(1 << 16)
          let done = 0
          while (done < entry.compressedSize) {
            const want = Math.min(buffer.length, entry.compressedSize - done)
            const { bytesRead } = await source.read(buffer, 0, want, start + done)
            if (!bytesRead) throw new Error(`读旧档案时提前结束了：${item.name}`)
            await put(buffer.subarray(0, bytesRead))
            done += bytesRead
          }
        } finally {
          await source.close()
        }
        crc = entry.crc32
        compressedSize = entry.compressedSize
        size = entry.size
      } else {
        const counter = crc32Stream()
        let raw = 0
        const measureRaw = new Transform({
          transform(chunk, _encoding, callback) {
            counter.update(chunk)
            raw += chunk.length
            callback(null, chunk)
          },
        })
        const measureOut = new Transform({
          transform(chunk, _encoding, callback) {
            compressedSize += chunk.length
            callback(null, chunk)
          },
        })
        const source = item.buffer
          ? Readable.from([Buffer.from(item.buffer)])
          : createReadStream(item.file)
        if (method === METHOD_DEFLATE) {
          await pipeline(source, measureRaw, createDeflateRaw({ level: 6 }), measureOut, sink, { end: false })
        } else {
          await pipeline(source, measureRaw, measureOut, sink, { end: false })
        }
        crc = counter.digest()
        size = raw
      }
      if (size > MAX_SIZE || compressedSize > MAX_SIZE) throw new Error(`${item.name} 超过 4GB，ZIP 装不下`)

      const patchBuffer = Buffer.alloc(12)
      patchBuffer.writeUInt32LE(crc >>> 0, 0)
      patchBuffer.writeUInt32LE(compressedSize, 4)
      patchBuffer.writeUInt32LE(size, 8)
      await patch(headerAt + 14, patchBuffer)
      central.push({ name: nameBuffer, method, time, date, crc: crc >>> 0, compressedSize, size, offset: headerAt })
    }

    const centralAt = offset
    for (const item of central) {
      const record = Buffer.alloc(46)
      record.writeUInt32LE(SIG_CENTRAL, 0)
      record.writeUInt16LE(20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt16LE(0x0800, 8)
      record.writeUInt16LE(item.method, 10)
      record.writeUInt16LE(item.time, 12)
      record.writeUInt16LE(item.date, 14)
      record.writeUInt32LE(item.crc, 16)
      record.writeUInt32LE(item.compressedSize, 20)
      record.writeUInt32LE(item.size, 24)
      record.writeUInt16LE(item.name.length, 28)
      record.writeUInt32LE(item.offset, 42)
      await put(record)
      await put(item.name)
    }
    const centralSize = offset - centralAt
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(centralSize, 12)
    eocd.writeUInt32LE(centralAt, 16)
    await put(eocd)

    await new Promise((resolve, reject) => sink.end((error) => (error ? reject(error) : resolve())))
    await handle.close()
    closed = true
    await rm(target, { force: true })
    await rename(temp, target)
    return { entries: central.length, size: offset }
  } catch (error) {
    if (handle && !closed) await handle.close().catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/** 简单读一下 zip 里有哪些名字（给测试和人看用）。 */
export async function listZipNames(file) {
  const { entries } = await readZipIndex(file)
  return [...entries.keys()]
}

/** 文件存在且像是个 zip（不用解压，看头四个字节）。 */
export async function looksLikeZip(file) {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size < 22) return false
    const head = Buffer.alloc(4)
    const handle = await open(file, 'r')
    try {
      await handle.read(head, 0, 4, 0)
    } finally {
      await handle.close()
    }
    return head.readUInt32LE(0) === SIG_LOCAL
  } catch {
    return false
  }
}

/** 读整个文件（导入时读几百 KB 的配置用）。 */
export const readWholeFile = readFile
