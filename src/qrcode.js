/**
 * 零依赖纯 JS 二维码生成器（严格遵循 ISO/IEC 18004：Byte 模式 UTF-8、Version 1..20、ECC L/M）。
 *
 * 为什么手写而不是引 npm 包：
 * DSH-X 核心运行时硬约束零第三方依赖；桌面管理页需要完全离线渲染配对二维码（不依赖外网
 * 二维码 API，也绝不能把一次性配对码发给任何第三方服务）。
 */

/**
 * ISO/IEC 18004 Table 9 纠错参数表（Version 1..20）。
 * 每一项为 [ecCodewordsPerBlock, numBlocks]；短/长块划分由总码字数唯一决定。
 */
const ECC_TABLE = {
  L: [
    null, // 1-based index
    [7, 1], [10, 1], [15, 1], [20, 1], [26, 1],
    [18, 2], [20, 2], [24, 2], [30, 2], [18, 4],
    [20, 4], [24, 4], [26, 4], [30, 4], [22, 6],
    [24, 6], [28, 6], [30, 6], [28, 7], [28, 8],
  ],
  M: [
    null,
    [10, 1], [16, 1], [26, 1], [18, 2], [24, 2],
    [16, 4], [18, 4], [22, 4], [22, 5], [26, 5],
    [30, 5], [22, 8], [22, 9], [24, 9], [24, 10],
    [28, 10], [28, 11], [26, 13], [26, 14], [26, 16],
  ],
}

/** ISO/IEC 18004 格式信息中的 2-bit 纠错等级编码。 */
const ECC_FORMAT_BITS = { L: 0b01, M: 0b00 }

const MIN_VERSION = 1
const MAX_VERSION = 20

/** 返回指定版本的校正图形（Alignment Pattern）中心坐标列表（ISO/IEC 18004 Annex E）。 */
function alignmentPatternPositions(version) {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const size = version * 4 + 17
  // 间距取偶数使各校正图形在右下角均匀分布，末尾固定在 size - 7
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < count; pos -= step) {
    result.splice(1, 0, pos)
  }
  return result
}

/** 计算指定版本可用于存放数据+纠错码字的总字节数。 */
function totalCodewordsForVersion(version) {
  const size = version * 4 + 17
  let bits = size * size
  bits -= 3 * 64 // 三个 7x7 定位符 + 1 格分隔白边
  bits -= 2 * (size - 16) // 两条时序线（不含定位符内部分）
  bits -= 1 // 固定暗模块 (8, 4*v + 9)
  bits -= 30 // 两份 15-bit 格式信息（固定暗模块已单独减过）
  if (version >= 7) bits -= 36 // 两份 18-bit 版本信息
  const align = alignmentPatternPositions(version)
  if (align.length > 0) {
    const n = align.length
    // n*n - 3 个 5x5 校正图形；其中 2*(n-2) 个与时序线各重叠 5 格
    bits -= 25 * (n * n - 3) - 10 * (n - 2)
  }
  return Math.floor(bits / 8)
}

/** 指定版本与纠错等级的纯数据容量（字节）。 */
function dataCodewordsFor(version, ecc) {
  const [ecPerBlock, numBlocks] = ECC_TABLE[ecc][version]
  return totalCodewordsForVersion(version) - ecPerBlock * numBlocks
}

/** Byte 模式下字符计数字段的位数（ISO/IEC 18004 Table 3）。 */
function byteCountBits(version) {
  return version <= 9 ? 8 : 16
}

/** 选择能容纳给定 UTF-8 字节长度的最小 QR 版本。 */
function pickMinVersion(byteLength, ecc) {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const dataCapBits = dataCodewordsFor(v, ecc) * 8
    const neededBits = 4 + byteCountBits(v) + byteLength * 8
    if (neededBits <= dataCapBits) return v
  }
  throw new RangeError(`二维码内容过长（${byteLength} 字节），超出 Version ${MAX_VERSION} (${ecc}) 容量上限`)
}

/** GF(256) 乘法（本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11D）。 */
function gfMul(a, b) {
  let x = a
  let y = b
  let result = 0
  for (let i = 0; i < 8; i++) {
    if (y & 1) result ^= x
    const hi = x & 0x80
    x = (x << 1) & 0xff
    if (hi) x ^= 0x1d
    y >>>= 1
  }
  return result
}

/** 构造度数为 degree 的 Reed-Solomon 生成多项式（省略最高次首一系数）。 */
function rsGenerator(degree) {
  let coeffs = new Uint8Array(degree)
  coeffs[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      coeffs[j] = gfMul(coeffs[j], root)
      if (j + 1 < degree) coeffs[j] ^= coeffs[j + 1]
    }
    root = gfMul(root, 2)
  }
  return coeffs
}

/** 计算单个数据块的 Reed-Solomon 纠错码字。 */
function rsRemainder(data, generator) {
  const result = new Uint8Array(generator.length)
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ result[0]
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let j = 0; j < generator.length; j++) {
      result[j] ^= gfMul(generator[j], factor)
    }
  }
  return result
}

/** 将 UTF-8 字节编码为 Byte 模式数据码字（含模式位、长度位、终止符和 0xEC/0x11 填充）。 */
function encodeDataCodewords(bytes, version, ecc) {
  const dataCapBytes = dataCodewordsFor(version, ecc)
  const bits = []
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }

  pushBits(0b0100, 4) // Byte 模式
  pushBits(bytes.length, byteCountBits(version))
  for (let i = 0; i < bytes.length; i++) pushBits(bytes[i], 8)

  // 最多补 4 个终止 0 位，再补 0 对齐到整字节
  const maxBits = dataCapBytes * 8
  const terminator = Math.min(4, maxBits - bits.length)
  for (let i = 0; i < terminator; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const codewords = new Uint8Array(dataCapBytes)
  let byteIdx = 0
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0
    for (let b = 0; b < 8; b++) val = (val << 1) | bits[i + b]
    codewords[byteIdx++] = val
  }

  // ISO 规定的交替填充码字 0xEC / 0x11
  let pad = 0xec
  while (byteIdx < dataCapBytes) {
    codewords[byteIdx++] = pad
    pad = pad === 0xec ? 0x11 : 0xec
  }
  return codewords
}

/** 分块计算 RS 纠错码字并按规范交错排列为最终比特流。 */
function addEccAndInterleave(dataCodewords, version, ecc) {
  const [ecPerBlock, numBlocks] = ECC_TABLE[ecc][version]
  const totalCodewords = totalCodewordsForVersion(version)
  const numLongBlocks = totalCodewords % numBlocks
  const numShortBlocks = numBlocks - numLongBlocks
  const shortBlockLen = Math.floor(totalCodewords / numBlocks)
  const shortDataLen = shortBlockLen - ecPerBlock

  const generator = rsGenerator(ecPerBlock)
  const dataBlocks = []
  const ecBlocks = []
  let offset = 0

  for (let b = 0; b < numBlocks; b++) {
    const dataLen = b < numShortBlocks ? shortDataLen : shortDataLen + 1
    const block = dataCodewords.subarray(offset, offset + dataLen)
    offset += dataLen
    dataBlocks.push(block)
    ecBlocks.push(rsRemainder(block, generator))
  }

  const out = new Uint8Array(totalCodewords)
  let pos = 0
  const maxDataLen = shortDataLen + (numLongBlocks > 0 ? 1 : 0)
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) out[pos++] = dataBlocks[b][i]
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      out[pos++] = ecBlocks[b][i]
    }
  }
  return out
}

/** 计算 15-bit 格式信息（BCH(15,5) + 0x5412 掩码）。 */
function computeFormatBits(ecc, mask) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  }
  return ((data << 10) | rem) ^ 0x5412
}

/** 计算 18-bit 版本信息（BCH(18,6)，Version >= 7 使用）。 */
function computeVersionBits(version) {
  let rem = version
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  }
  return (version << 12) | rem
}

/** 创建矩阵并绘制所有固定功能图形（定位符、分隔符、时序线、校正图形、版本信息、格式占位）。 */
function initMatrix(version) {
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Uint8Array(size))
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size))

  const setFunc = (x, y, dark) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return
    modules[y][x] = dark ? 1 : 0
    isFunc[y][x] = 1
  }

  // 1. 时序线（先画，后续定位符和格式区会按需覆写）
  for (let i = 0; i < size; i++) {
    setFunc(6, i, i % 2 === 0)
    setFunc(i, 6, i % 2 === 0)
  }

  // 2. 三个 7x7 定位符 + 1 格白色分隔边
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const dark = dist !== 2 && dist !== 4
        setFunc(cx + dx, cy + dy, dark)
      }
    }
  }
  drawFinder(3, 3)
  drawFinder(size - 4, 3)
  drawFinder(3, size - 4)

  // 3. 5x5 校正图形（跳过与三个定位符重合的角落）
  const align = alignmentPatternPositions(version)
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const isCorner = (i === 0 && j === 0)
        || (i === 0 && j === align.length - 1)
        || (i === align.length - 1 && j === 0)
      if (isCorner) continue
      const cx = align[i]
      const cy = align[j]
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunc(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }

  // 4. 预留格式信息区 + 固定暗模块 (8, size - 8)
  drawFormatBits(modules, isFunc, 0)
  setFunc(8, size - 8, true)

  // 5. Version >= 7 的两份 18-bit 版本信息
  if (version >= 7) {
    const bits = computeVersionBits(version)
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunc(a, b, dark) // 右上 3x6
      setFunc(b, a, dark) // 左下 6x3
    }
  }

  return { size, modules, isFunc }
}

/** 写入两份 15-bit 格式信息（ISO/IEC 18004 Figure 25）。 */
function drawFormatBits(modules, isFunc, bits) {
  const size = modules.length
  const set = (x, y, bit) => {
    modules[y][x] = bit
    if (isFunc) isFunc[y][x] = 1
  }
  // 副本 1：左上定位符右/下侧
  for (let i = 0; i <= 5; i++) set(8, i, (bits >>> i) & 1)
  set(8, 7, (bits >>> 6) & 1)
  set(8, 8, (bits >>> 7) & 1)
  set(7, 8, (bits >>> 8) & 1)
  for (let i = 9; i < 15; i++) set(14 - i, 8, (bits >>> i) & 1)

  // 副本 2：右上定位符下侧 + 左下定位符右侧
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, (bits >>> i) & 1)
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, (bits >>> i) & 1)
}

/** 按右下到左上蛇形两列条带填充数据+纠错比特（跳过第 6 列垂直时序线）。 */
function placeCodewords(modules, isFunc, codewords) {
  const size = modules.length
  let bitIndex = 0
  const totalBits = codewords.length * 8
  let upward = true

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? (size - 1 - vert) : vert
      for (let j = 0; j < 2; j++) {
        const x = right - j
        if (isFunc[y][x]) continue
        let dark = 0
        if (bitIndex < totalBits) {
          dark = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1
          bitIndex++
        }
        modules[y][x] = dark
      }
    }
    upward = !upward
  }
}

/** 判断坐标 (x, y) 在第 mask 号掩码下是否翻转（ISO/IEC 18004 Table 10）。 */
function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (y + x) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (y + x) % 3 === 0
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5: return ((y * x) % 2) + ((y * x) % 3) === 0
    case 6: return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0
    case 7: return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0
    default: return false
  }
}

/** 原地异或指定掩码（只作用于非功能模块），再异或一次即还原。 */
function applyMask(modules, isFunc, mask) {
  const size = modules.length
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunc[y][x] && maskBit(mask, x, y)) {
        modules[y][x] ^= 1
      }
    }
  }
}

/** 计算 ISO/IEC 18004 四项掩码惩罚分，得分越低越容易被手机摄像头稳定识别。 */
function penaltyScore(modules) {
  const size = modules.length
  let score = 0

  // 规则 1：同色连续 5 格及以上
  for (let y = 0; y < size; y++) {
    let runColor = modules[y][0]
    let runLen = 1
    for (let x = 1; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLen++
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5)
        runColor = modules[y][x]
        runLen = 1
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5)
  }
  for (let x = 0; x < size; x++) {
    let runColor = modules[0][x]
    let runLen = 1
    for (let y = 1; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLen++
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5)
        runColor = modules[y][x]
        runLen = 1
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5)
  }

  // 规则 2：2x2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x]
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        score += 3
      }
    }
  }

  // 规则 3：伪定位符图样 10111010000 或 00001011101（用 11-bit 滑动窗口匹配）
  const PAT_A = 0b10111010000
  const PAT_B = 0b00001011101
  const WIN_MASK = 0x7ff
  for (let y = 0; y < size; y++) {
    let bits = 0
    for (let x = 0; x < size; x++) {
      bits = ((bits << 1) | modules[y][x]) & WIN_MASK
      if (x >= 10 && (bits === PAT_A || bits === PAT_B)) score += 40
    }
  }
  for (let x = 0; x < size; x++) {
    let bits = 0
    for (let y = 0; y < size; y++) {
      bits = ((bits << 1) | modules[y][x]) & WIN_MASK
      if (y >= 10 && (bits === PAT_A || bits === PAT_B)) score += 40
    }
  }

  // 规则 4：暗模块占比偏离 50%
  let dark = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) dark += modules[y][x]
  }
  const total = size * size
  const k = Math.floor(Math.abs(dark * 20 - total * 10) / total)
  score += k * 10

  return score
}

/**
 * 将 UTF-8 文本编码为 QR 矩阵（二维布尔数组，true 表示暗模块）。
 * @param {string} text 待编码文本
 * @param {object} [options]
 * @param {'L' | 'M'} [options.ecc] 纠错等级，默认 'M'
 * @returns {boolean[][]}
 */
export function encodeQrMatrix(text, { ecc = 'M' } = {}) {
  const level = String(ecc || 'M').toUpperCase()
  if (!ECC_TABLE[level]) throw new RangeError(`不支持的 QR 纠错等级：${ecc}（仅支持 L / M）`)

  const bytes = Buffer.from(String(text ?? ''), 'utf8')
  const version = pickMinVersion(bytes.length, level)
  const dataCodewords = encodeDataCodewords(bytes, version, level)
  const finalCodewords = addEccAndInterleave(dataCodewords, version, level)

  const { size, modules, isFunc } = initMatrix(version)
  placeCodewords(modules, isFunc, finalCodewords)

  // 穷举全部 8 个掩码，挑出惩罚分最低的那个
  let bestMask = 0
  let bestPenalty = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, isFunc, mask)
    drawFormatBits(modules, null, computeFormatBits(level, mask))
    const penalty = penaltyScore(modules)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      bestMask = mask
    }
    applyMask(modules, isFunc, mask)
  }

  applyMask(modules, isFunc, bestMask)
  drawFormatBits(modules, null, computeFormatBits(level, bestMask))

  return modules.map((row) => Array.from(row, (v) => v === 1))
}

function safeColor(color, fallback) {
  const s = String(color ?? '').trim()
  return /^#[0-9a-f]{3,8}$/i.test(s) ? s : fallback
}

/**
 * 将文本渲染为可直接内嵌到页面中的干净 SVG 字符串。
 * 同一行相邻的暗模块合并成一条水平矩形路径，避免高分屏缩放时出现白色细缝并减小体积。
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.size] 输出宽高像素，默认 220
 * @param {number} [options.margin] 静区边距（模块数），ISO 建议 >= 4，默认 4
 * @param {'L' | 'M'} [options.ecc] 纠错等级，默认 'M'
 * @param {string} [options.dark] 暗模块颜色，默认 #000000
 * @param {string} [options.light] 亮背景颜色，默认 #ffffff
 * @returns {string}
 */
export function renderQrSvg(text, { size = 220, margin = 4, ecc = 'M', dark = '#000000', light = '#ffffff' } = {}) {
  const matrix = encodeQrMatrix(text, { ecc })
  const count = matrix.length
  const quiet = Number.isInteger(margin) && margin >= 0 ? margin : 4
  const px = Number.isFinite(size) && size > 0 ? Math.round(size) : 220
  const viewSize = count + quiet * 2
  const fg = safeColor(dark, '#000000')
  const bg = safeColor(light, '#ffffff')

  const cmds = []
  for (let y = 0; y < count; y++) {
    const row = matrix[y]
    let x = 0
    while (x < count) {
      if (!row[x]) { x++; continue }
      const start = x
      while (x < count && row[x]) x++
      cmds.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`)
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR Code">`
    + `<rect width="100%" height="100%" fill="${bg}"/>`
    + `<path fill="${fg}" d="${cmds.join('')}"/>`
    + `</svg>`
}
