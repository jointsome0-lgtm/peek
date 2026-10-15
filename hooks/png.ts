// PNG to 8-bit RGBA in plain TypeScript. The hooks environment has no
// DecompressionStream, so the zlib inflater is written out here as well.

export type Pixels = {
  width: number
  height: number
  /** Row-major RGBA, 4 bytes a pixel, straight (not premultiplied) alpha. */
  rgba: Uint8Array
}

export type PngHeader = {
  width: number
  height: number
  bitDepth: number
  colorType: number
  isInterlaced: boolean
}

/** Decoding stops above this many pixels: 32 MP is 128 MB of RGBA. */
export const MAX_PIXELS = 32_000_000

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IHDR = 0x49484452
const PLTE = 0x504c5445
const IDAT = 0x49444154
const IEND = 0x49454e44
const TRNS = 0x74524e53

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}

// Each pass as [x0, y0, dx, dy]: Adam7's seven, or the whole image once.
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const
const WHOLE = [[0, 0, 1, 1]] as const

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((byte, i) => bytes[i] === byte)
}

/** Reads the IHDR chunk, which the first 33 bytes of the file hold. */
export function readPngHeader(bytes: Uint8Array): PngHeader {
  if (!isPng(bytes)) throw new Error('not a PNG file')
  if (bytes.length < 33 || u32(bytes, 12) !== IHDR) throw new Error('PNG header missing')

  const width = u32(bytes, 16)
  const height = u32(bytes, 20)
  const bitDepth = bytes[24]!
  const colorType = bytes[25]!
  const interlace = bytes[28]!

  if (width === 0 || height === 0) throw new Error('PNG with no pixels')
  if (!DEPTHS[colorType]?.includes(bitDepth)) {
    throw new Error(`PNG color type ${colorType} at bit depth ${bitDepth} is not valid`)
  }
  if (bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) {
    throw new Error('PNG uses an unknown compression, filter or interlace method')
  }

  return { width, height, bitDepth, colorType, isInterlaced: interlace === 1 }
}

export function decodePng(bytes: Uint8Array): Pixels {
  const { width, height, bitDepth, colorType, isInterlaced } = readPngHeader(bytes)
  if (width * height > MAX_PIXELS) throw new Error(`PNG too large to decode: ${width}×${height}`)

  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  const parts: Uint8Array[] = []
  let size = 0
  for (let at = 8; ; ) {
    if (at + 12 > bytes.length) {
      if (parts.length > 0) break
      throw new Error('PNG cut short')
    }
    const length = u32(bytes, at)
    const type = u32(bytes, at + 4)
    const start = at + 8
    const end = start + length
    if (end + 4 > bytes.length) throw new Error('PNG cut short')
    if (type === IEND) break
    if (type === IDAT) {
      parts.push(bytes.subarray(start, end))
      size += length
    } else if (type === PLTE) {
      palette = bytes.subarray(start, end)
    } else if (type === TRNS) {
      transparency = bytes.subarray(start, end)
    }
    at = end + 4
  }
  if (parts.length === 0) throw new Error('PNG without image data')
  if (colorType === 3 && palette === undefined) throw new Error('PNG palette missing')

  const bitsPerPixel = CHANNELS[colorType]! * bitDepth
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3)
  const passes = isInterlaced ? ADAM7 : WHOLE
  const rowBytesOf = (passWidth: number) => Math.ceil((passWidth * bitsPerPixel) / 8)

  let expected = 0
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = Math.ceil((width - x0) / dx)
    const passHeight = Math.ceil((height - y0) / dy)
    if (passWidth > 0 && passHeight > 0) expected += passHeight * (1 + rowBytesOf(passWidth))
  }
  const raw = inflateZlib(joined(parts, size), expected)

  const rgba = new Uint8Array(width * height * 4)
  const expand = expander(colorType, bitDepth, palette, transparency)
  let at = 0
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = Math.ceil((width - x0) / dx)
    const passHeight = Math.ceil((height - y0) / dy)
    if (passWidth <= 0 || passHeight <= 0) continue
    const rowBytes = rowBytesOf(passWidth)
    for (let y = 0; y < passHeight; y++) {
      const row = at + 1
      const prior = y === 0 ? -1 : row - rowBytes - 1
      unfilter(raw, raw[at]!, row, prior, rowBytes, bytesPerPixel)
      expand(raw, row, passWidth, rgba, ((y0 + y * dy) * width + x0) * 4, dx * 4)
      at = row + rowBytes
    }
  }

  return { width, height, rgba }
}

function joined(parts: readonly Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0]!
  const all = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}

// Undoes one row's filter in place; `prior` is the row above (-1: none).
// A Uint8Array keeps each sum modulo 256, as the filters want.
function unfilter(
  raw: Uint8Array,
  filter: number,
  row: number,
  prior: number,
  length: number,
  bpp: number,
): void {
  switch (filter) {
    case 0:
      return
    case 1:
      for (let i = bpp; i < length; i++) raw[row + i] = raw[row + i]! + raw[row + i - bpp]!
      return
    case 2:
      if (prior < 0) return
      for (let i = 0; i < length; i++) raw[row + i] = raw[row + i]! + raw[prior + i]!
      return
    case 3:
      for (let i = 0; i < length; i++) {
        const left = i >= bpp ? raw[row + i - bpp]! : 0
        const up = prior >= 0 ? raw[prior + i]! : 0
        raw[row + i] = raw[row + i]! + ((left + up) >> 1)
      }
      return
    case 4:
      for (let i = 0; i < length; i++) {
        const a = i >= bpp ? raw[row + i - bpp]! : 0
        const b = prior >= 0 ? raw[prior + i]! : 0
        const c = i >= bpp && prior >= 0 ? raw[prior + i - bpp]! : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        raw[row + i] = raw[row + i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      return
    default:
      throw new Error(`PNG row filter ${filter} is not valid`)
  }
}

// Writes `count` pixels of one unfiltered row as RGBA: the first at
// out[to], each next `step` bytes on (Adam7 passes skip columns).
type Expand = (
  raw: Uint8Array,
  from: number,
  count: number,
  out: Uint8Array,
  to: number,
  step: number,
) => void

function sample(raw: Uint8Array, from: number, index: number, depth: number): number {
  const bit = index * depth
  return (raw[from + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
}

function expander(
  colorType: number,
  bitDepth: number,
  palette: Uint8Array | undefined,
  transparency: Uint8Array | undefined,
): Expand {
  const t = transparency
  switch (colorType) {
    case 6:
      if (bitDepth === 8) {
        return (raw, from, count, out, to, step) => {
          for (let i = 0; i < count; i++, from += 4, to += step) {
            out[to] = raw[from]!
            out[to + 1] = raw[from + 1]!
            out[to + 2] = raw[from + 2]!
            out[to + 3] = raw[from + 3]!
          }
        }
      }
      return (raw, from, count, out, to, step) => {
        for (let i = 0; i < count; i++, from += 8, to += step) {
          out[to] = raw[from]!
          out[to + 1] = raw[from + 2]!
          out[to + 2] = raw[from + 4]!
          out[to + 3] = raw[from + 6]!
        }
      }
    case 4: {
      const stride = bitDepth === 8 ? 2 : 4
      return (raw, from, count, out, to, step) => {
        for (let i = 0; i < count; i++, from += stride, to += step) {
          const gray = raw[from]!
          out[to] = gray
          out[to + 1] = gray
          out[to + 2] = gray
          out[to + 3] = raw[from + stride / 2]!
        }
      }
    }
    case 2: {
      const key = t !== undefined && t.length >= 6 ? [u16(t, 0), u16(t, 2), u16(t, 4)] : undefined
      if (bitDepth === 8) {
        return (raw, from, count, out, to, step) => {
          for (let i = 0; i < count; i++, from += 3, to += step) {
            const r = raw[from]!
            const g = raw[from + 1]!
            const b = raw[from + 2]!
            out[to] = r
            out[to + 1] = g
            out[to + 2] = b
            out[to + 3] = key && r === key[0] && g === key[1] && b === key[2] ? 0 : 255
          }
        }
      }
      return (raw, from, count, out, to, step) => {
        for (let i = 0; i < count; i++, from += 6, to += step) {
          out[to] = raw[from]!
          out[to + 1] = raw[from + 2]!
          out[to + 2] = raw[from + 4]!
          const isKey =
            key !== undefined &&
            u16(raw, from) === key[0] &&
            u16(raw, from + 2) === key[1] &&
            u16(raw, from + 4) === key[2]
          out[to + 3] = isKey ? 0 : 255
        }
      }
    }
    case 0: {
      const key = t !== undefined && t.length >= 2 ? u16(t, 0) : -1
      if (bitDepth === 16) {
        return (raw, from, count, out, to, step) => {
          for (let i = 0; i < count; i++, from += 2, to += step) {
            const gray = raw[from]!
            out[to] = gray
            out[to + 1] = gray
            out[to + 2] = gray
            out[to + 3] = u16(raw, from) === key ? 0 : 255
          }
        }
      }
      const scale = 255 / ((1 << bitDepth) - 1)
      return (raw, from, count, out, to, step) => {
        for (let i = 0; i < count; i++, to += step) {
          const value = bitDepth === 8 ? raw[from + i]! : sample(raw, from, i, bitDepth)
          const gray = value * scale
          out[to] = gray
          out[to + 1] = gray
          out[to + 2] = gray
          out[to + 3] = value === key ? 0 : 255
        }
      }
    }
    default: {
      // Color type 3: indices into the palette; an index past it is opaque black.
      const pal = palette!
      const table = new Uint8Array(256 * 4)
      for (let i = 0; i < 256; i++) {
        if (i * 3 + 2 < pal.length) {
          table[i * 4] = pal[i * 3]!
          table[i * 4 + 1] = pal[i * 3 + 1]!
          table[i * 4 + 2] = pal[i * 3 + 2]!
        }
        table[i * 4 + 3] = t !== undefined && i < t.length ? t[i]! : 255
      }
      return (raw, from, count, out, to, step) => {
        for (let i = 0; i < count; i++, to += step) {
          const index = (bitDepth === 8 ? raw[from + i]! : sample(raw, from, i, bitDepth)) * 4
          out[to] = table[index]!
          out[to + 1] = table[index + 1]!
          out[to + 2] = table[index + 2]!
          out[to + 3] = table[index + 3]!
        }
      }
    }
  }
}

// Inflate (RFC 1950 and 1951).

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

// A canonical Huffman code as a lookup table over the next `bits` input
// bits: each entry is `symbol << 4 | length`, 0 where no code lands.
type Huffman = { table: Uint16Array; bits: number }

function huffman(lengths: Uint8Array): Huffman {
  const counts = new Uint16Array(16)
  let bits = 1
  for (const length of lengths) {
    counts[length] = counts[length]! + 1
    if (length > bits) bits = length
  }
  counts[0] = 0

  const next = new Uint16Array(16)
  for (let length = 1, code = 0; length <= 15; length++) {
    code = (code + counts[length - 1]!) << 1
    next[length] = code
  }

  const table = new Uint16Array(1 << bits)
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!
    if (length === 0) continue
    const code = next[length]!
    if (code >= 1 << length) throw new Error('deflate code lengths are not valid')
    next[length] = code + 1
    let reversed = 0
    for (let i = 0; i < length; i++) reversed |= ((code >> i) & 1) << (length - 1 - i)
    for (let i = reversed; i < table.length; i += 1 << length) table[i] = (symbol << 4) | length
  }

  return { table, bits }
}

let fixed: readonly [Huffman, Huffman] | undefined

function fixedCodes(): readonly [Huffman, Huffman] {
  if (fixed === undefined) {
    const literals = new Uint8Array(288)
    literals.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288)
    fixed = [huffman(literals), huffman(new Uint8Array(30).fill(5))]
  }
  return fixed
}

class Inflater {
  readonly src: Uint8Array
  readonly out: Uint8Array
  length = 0
  private at = 0
  private buffer = 0
  private count = 0

  constructor(src: Uint8Array, size: number) {
    this.src = src
    this.out = new Uint8Array(size)
  }

  // Past the end the input reads as zero bytes, for a last code shorter
  // than its table's lookup; a few of them, then it is cut short.
  private need(bits: number): void {
    while (this.count < bits) {
      if (this.at >= this.src.length + 4) throw new Error('deflate data cut short')
      this.buffer |= (this.src[this.at++] ?? 0) << this.count
      this.count += 8
    }
  }

  bits(n: number): number {
    if (n === 0) return 0
    this.need(n)
    const value = this.buffer & ((1 << n) - 1)
    this.buffer >>>= n
    this.count -= n
    return value
  }

  symbol(code: Huffman): number {
    this.need(code.bits)
    const entry = code.table[this.buffer & ((1 << code.bits) - 1)]!
    const length = entry & 15
    if (length === 0) throw new Error('deflate code is not valid')
    this.buffer >>>= length
    this.count -= length
    return entry >> 4
  }

  stored(): void {
    // To the byte boundary; the whole bytes still buffered go back.
    this.at -= this.count >> 3
    this.buffer = 0
    this.count = 0
    const at = this.at
    if (at + 4 > this.src.length) throw new Error('deflate data cut short')
    const length = this.src[at]! | (this.src[at + 1]! << 8)
    const check = this.src[at + 2]! | (this.src[at + 3]! << 8)
    if ((length ^ 0xffff) !== check) throw new Error('deflate stored block is not valid')
    if (at + 4 + length > this.src.length) throw new Error('deflate data cut short')
    if (this.length + length > this.out.length) throw new Error('image data longer than its size')
    this.out.set(this.src.subarray(at + 4, at + 4 + length), this.length)
    this.length += length
    this.at = at + 4 + length
  }

  dynamic(): readonly [Huffman, Huffman] {
    const literalCount = this.bits(5) + 257
    const distanceCount = this.bits(5) + 1
    const codeCount = this.bits(4) + 4
    const codeLengths = new Uint8Array(19)
    for (let i = 0; i < codeCount; i++) codeLengths[CODE_LENGTH_ORDER[i]!] = this.bits(3)
    const lengthCode = huffman(codeLengths)

    const lengths = new Uint8Array(literalCount + distanceCount)
    for (let i = 0; i < lengths.length; ) {
      const symbol = this.symbol(lengthCode)
      if (symbol < 16) {
        lengths[i++] = symbol
        continue
      }
      let value = 0
      let repeat: number
      if (symbol === 16) {
        if (i === 0) throw new Error('deflate code lengths are not valid')
        value = lengths[i - 1]!
        repeat = 3 + this.bits(2)
      } else if (symbol === 17) {
        repeat = 3 + this.bits(3)
      } else {
        repeat = 11 + this.bits(7)
      }
      if (i + repeat > lengths.length) throw new Error('deflate code lengths are not valid')
      lengths.fill(value, i, i + repeat)
      i += repeat
    }

    return [huffman(lengths.subarray(0, literalCount)), huffman(lengths.subarray(literalCount))]
  }

  codes(literals: Huffman, distances: Huffman): void {
    const out = this.out
    let o = this.length
    for (;;) {
      const symbol = this.symbol(literals)
      if (symbol < 256) {
        if (o >= out.length) throw new Error('image data longer than its size')
        out[o++] = symbol
        continue
      }
      if (symbol === 256) break
      const index = symbol - 257
      if (index >= 29) throw new Error('deflate length code is not valid')
      const length = LENGTH_BASE[index]! + this.bits(LENGTH_EXTRA[index]!)
      const code = this.symbol(distances)
      if (code >= 30) throw new Error('deflate distance code is not valid')
      const distance = DISTANCE_BASE[code]! + this.bits(DISTANCE_EXTRA[code]!)
      if (distance > o) throw new Error('deflate distance reaches before the start')
      if (o + length > out.length) throw new Error('image data longer than its size')
      for (let end = o + length; o < end; o++) out[o] = out[o - distance]!
    }
    this.length = o
  }
}

/** Inflates a raw deflate stream that must come to exactly `size` bytes. */
export function inflate(src: Uint8Array, size: number): Uint8Array {
  const inflater = new Inflater(src, size)
  for (let isLast = 0; isLast === 0; ) {
    isLast = inflater.bits(1)
    const type = inflater.bits(2)
    if (type === 0) inflater.stored()
    else if (type === 1) inflater.codes(...fixedCodes())
    else if (type === 2) inflater.codes(...inflater.dynamic())
    else throw new Error('deflate block type is not valid')
  }
  if (inflater.length !== size) {
    throw new Error(`image data is ${inflater.length} bytes, its size says ${size}`)
  }
  return inflater.out
}

/** Inflates a zlib stream (a two-byte header, deflate, a checksum left unread). */
export function inflateZlib(src: Uint8Array, size: number): Uint8Array {
  const cmf = src[0] ?? 0
  const flg = src[1] ?? 0
  if ((cmf & 15) !== 8 || (cmf * 256 + flg) % 31 !== 0 || (flg & 32) !== 0) {
    throw new Error('zlib header is not valid')
  }
  return inflate(src.subarray(2), size)
}
