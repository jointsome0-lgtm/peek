// Fitting a picture into terminal cells, and drawing it as colored half
// blocks for a Raster.

import { toBase64 } from './base64'
import type { Pixels } from './png'

/** A terminal cell is about twice as tall as it is wide (9×18 px in kitty). */
export const CELL_ASPECT = 2

/** The terminal's own color, as a Raster cell spells it. */
export const DEFAULT_COLOR = 0x01000000

/** A Raster paints this many distinct color pairs, the rest as their nearest. */
export const MAX_PAIRS = 1024

const UPPER_HALF = 0x2580 // ▀
const LOWER_HALF = 0x2584 // ▄
const SPACE = 0x20

// How much each channel counts when colors are compared: the eye tells
// greens apart best and blues worst.
const WEIGHTS = [3, 4, 2] as const

export type CellSize = { columns: number; rows: number }

/**
 * The largest box of cells, at most `maxColumns × maxRows`, that shows a
 * `width × height` picture without stretching it.
 */
export function fitCells(width: number, height: number, maxColumns: number, maxRows: number): CellSize {
  const rowsPerColumn = height / width / CELL_ASPECT
  let columns = Math.max(1, Math.floor(maxColumns))
  let rows = Math.max(1, Math.round(columns * rowsPerColumn))
  if (rows > maxRows) {
    rows = Math.max(1, Math.floor(maxRows))
    columns = Math.max(1, Math.min(columns, Math.round(rows / rowsPerColumn)))
  }
  return { columns, rows }
}

/**
 * The picture as `columns × rows` cells of colored half blocks, encoded as
 * a Raster's `cells`: each cell's upper and lower half average the pixels
 * they cover, a mostly transparent half shows the terminal's background,
 * and the colors are cut down to at most `MAX_PAIRS` pairs.
 */
export function rasterCells(pixels: Pixels, columns: number, rows: number): string {
  const half = halves(pixels, columns, rows)
  const count = columns * rows
  const glyph = new Uint32Array(count)
  const fg = new Uint32Array(count)
  const bg = new Uint32Array(count)
  for (let i = 0; i < count; i++) {
    const x = i % columns
    const y = (i - x) / columns
    const top = half[2 * y * columns + x]!
    const bottom = half[(2 * y + 1) * columns + x]!
    if (top !== DEFAULT_COLOR) {
      glyph[i] = UPPER_HALF
      fg[i] = top
      bg[i] = bottom
    } else if (bottom !== DEFAULT_COLOR) {
      glyph[i] = LOWER_HALF
      fg[i] = bottom
      bg[i] = DEFAULT_COLOR
    } else {
      glyph[i] = SPACE
      fg[i] = DEFAULT_COLOR
      bg[i] = DEFAULT_COLOR
    }
  }
  reducePairs(fg, bg, MAX_PAIRS)

  const cells = new DataView(new ArrayBuffer(count * 12))
  for (let i = 0; i < count; i++) {
    cells.setUint32(i * 12, glyph[i]!, true)
    cells.setUint32(i * 12 + 4, fg[i]!, true)
    cells.setUint32(i * 12 + 8, bg[i]!, true)
  }
  return toBase64(new Uint8Array(cells.buffer))
}

// For each of `target` slots, the source pixels it covers: [start, end),
// at least one even where the picture is smaller than the grid.
function spans(source: number, target: number): readonly [Int32Array, Int32Array] {
  const start = new Int32Array(target)
  const end = new Int32Array(target)
  for (let i = 0; i < target; i++) {
    const from = Math.floor((i * source) / target)
    start[i] = from
    end[i] = Math.max(from + 1, Math.floor(((i + 1) * source) / target))
  }
  return [start, end]
}

// The `columns × 2·rows` grid of half cells, each 0x00RRGGBB or, when most
// of what it covers is transparent, DEFAULT_COLOR.
function halves({ width, height, rgba }: Pixels, columns: number, rows: number): Uint32Array {
  const [xStart, xEnd] = spans(width, columns)
  const [yStart, yEnd] = spans(height, rows * 2)
  const out = new Uint32Array(columns * rows * 2)
  for (let y = 0; y < rows * 2; y++) {
    const y0 = yStart[y]!
    const y1 = yEnd[y]!
    for (let x = 0; x < columns; x++) {
      const x0 = xStart[x]!
      const x1 = xEnd[x]!
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let at = (sy * width + x0) * 4, stop = (sy * width + x1) * 4; at < stop; at += 4) {
          const alpha = rgba[at + 3]!
          r += rgba[at]! * alpha
          g += rgba[at + 1]! * alpha
          b += rgba[at + 2]! * alpha
          a += alpha
        }
      }
      const isClear = a * 2 < (y1 - y0) * (x1 - x0) * 255
      out[y * columns + x] = isClear
        ? DEFAULT_COLOR
        : (Math.round(r / a) << 16) | (Math.round(g / a) << 8) | Math.round(b / a)
    }
  }
  return out
}

// Cuts the distinct (fg, bg) pairs down to `limit`, in place. Pairs of two
// colors and pairs of one color over the terminal's background are cut
// apart, each by a median cut, so neither turns into the other.
function reducePairs(fg: Uint32Array, bg: Uint32Array, limit: number): void {
  const two = new Map<number, number>() // fg·2^24 + bg → cells
  const one = new Map<number, number>() // fg → cells
  let hasBlank = false
  for (let i = 0; i < fg.length; i++) {
    const f = fg[i]!
    const b = bg[i]!
    if (f === DEFAULT_COLOR) hasBlank = true
    else if (b === DEFAULT_COLOR) one.set(f, (one.get(f) ?? 0) + 1)
    else {
      const key = f * 0x1000000 + b
      two.set(key, (two.get(key) ?? 0) + 1)
    }
  }
  const room = limit - (hasBlank ? 1 : 0)
  if (two.size + one.size <= room) return

  const t = two.size
  const o = one.size
  let twoRoom = t === 0 ? 0 : o === 0 ? room : Math.min(room - 1, Math.max(1, Math.round((room * t) / (t + o))))
  twoRoom = Math.min(twoRoom, t)
  const oneRoom = Math.min(o, room - twoRoom)
  twoRoom = Math.min(t, room - oneRoom)

  const twoNew = cutColors([...two], 2, twoRoom)
  const oneNew = cutColors([...one], 1, oneRoom)
  for (let i = 0; i < fg.length; i++) {
    const f = fg[i]!
    const b = bg[i]!
    if (f === DEFAULT_COLOR) continue
    if (b === DEFAULT_COLOR) {
      fg[i] = oneNew.get(f)![0]!
    } else {
      const pair = twoNew.get(f * 0x1000000 + b)!
      fg[i] = pair[0]!
      bg[i] = pair[1]!
    }
  }
}

// Median cut over keys of `colors` colors each (a key holds them 24 bits
// apiece, the first highest), weighted by how many cells use each: maps
// every key to the mean colors of its box, `limit` boxes at most.
function cutColors(entries: readonly (readonly [number, number])[], colors: number, limit: number): Map<number, number[]> {
  const dims = colors * 3
  const n = entries.length
  const points = new Uint8Array(n * dims)
  const weights = new Float64Array(n)
  for (let p = 0; p < n; p++) {
    let key = entries[p]![0]
    for (let c = colors - 1; c >= 0; c--) {
      const color = key % 0x1000000
      key = (key - color) / 0x1000000
      points[p * dims + c * 3] = color >> 16
      points[p * dims + c * 3 + 1] = (color >> 8) & 0xff
      points[p * dims + c * 3 + 2] = color & 0xff
    }
    weights[p] = entries[p]![1]
  }

  const means = medianCut(points, dims, weights, Math.max(1, limit))
  const out = new Map<number, number[]>()
  for (let p = 0; p < n; p++) {
    const pair: number[] = []
    for (let c = 0; c < colors; c++) {
      const at = p * dims + c * 3
      pair.push((means[at]! << 16) | (means[at + 1]! << 8) | means[at + 2]!)
    }
    out.set(entries[p]![0], pair)
  }
  return out
}

type Box = { start: number; end: number; error: number; axis: number }

// Splits the points into at most `limit` boxes, each time the box whose
// weighted squared error is largest, along its widest channel, where the
// error along it drops most; returns every point's box mean.
function medianCut(points: Uint8Array, dims: number, weights: Float64Array, limit: number): Uint8Array {
  const n = weights.length
  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) order[i] = i

  const measure = (start: number, end: number): Box => {
    const sum = new Float64Array(dims)
    const squares = new Float64Array(dims)
    let total = 0
    for (let k = start; k < end; k++) {
      const p = order[k]!
      const w = weights[p]!
      total += w
      for (let d = 0; d < dims; d++) {
        const v = points[p * dims + d]!
        sum[d] = sum[d]! + w * v
        squares[d] = squares[d]! + w * v * v
      }
    }
    let error = 0
    let axis = 0
    let widest = -1
    for (let d = 0; d < dims; d++) {
      const spread = (squares[d]! - (sum[d]! * sum[d]!) / total) * WEIGHTS[d % 3]!
      error += spread
      if (spread > widest) {
        widest = spread
        axis = d
      }
    }
    return { start, end, error: end - start > 1 ? error : 0, axis }
  }

  const boxes = [measure(0, n)]
  while (boxes.length < limit) {
    let pick = -1
    for (let b = 0; b < boxes.length; b++) {
      if (boxes[b]!.error > 0 && (pick < 0 || boxes[b]!.error > boxes[pick]!.error)) pick = b
    }
    if (pick < 0) break
    const box = boxes[pick]!
    const at = splitPoint(points, dims, weights, order, box)
    boxes[pick] = measure(box.start, at)
    boxes.push(measure(at, box.end))
  }

  const out = new Uint8Array(n * dims)
  const sum = new Float64Array(dims)
  for (const { start, end } of boxes) {
    sum.fill(0)
    let total = 0
    for (let k = start; k < end; k++) {
      const p = order[k]!
      total += weights[p]!
      for (let d = 0; d < dims; d++) sum[d] = sum[d]! + weights[p]! * points[p * dims + d]!
    }
    for (let k = start; k < end; k++) {
      for (let d = 0; d < dims; d++) out[order[k]! * dims + d] = Math.round(sum[d]! / total)
    }
  }
  return out
}

// Sorts the box's points along its axis (a counting sort: channels are
// bytes) and returns where to split it so the two halves' squared error
// along that axis is least; both halves keep at least one point.
function splitPoint(points: Uint8Array, dims: number, weights: Float64Array, order: Int32Array, box: Box): number {
  const { start, end, axis } = box
  const counts = new Int32Array(257)
  for (let k = start; k < end; k++) counts[points[order[k]! * dims + axis]! + 1]!++
  for (let v = 1; v < 257; v++) counts[v]! += counts[v - 1]!
  const sorted = new Int32Array(end - start)
  for (let k = start; k < end; k++) {
    const p = order[k]!
    sorted[counts[points[p * dims + axis]!]!++] = p
  }
  order.set(sorted, start)

  let total = 0
  let sum = 0
  for (let k = start; k < end; k++) {
    const p = order[k]!
    total += weights[p]!
    sum += weights[p]! * points[p * dims + axis]!
  }
  // Least error on both sides is most of (Σwx)²/Σw summed over them.
  let best = start + 1
  let bestScore = -1
  let leftWeight = 0
  let leftSum = 0
  for (let k = start; k < end - 1; k++) {
    const p = order[k]!
    leftWeight += weights[p]!
    leftSum += weights[p]! * points[p * dims + axis]!
    const rightWeight = total - leftWeight
    const rightSum = sum - leftSum
    const score = (leftSum * leftSum) / leftWeight + (rightSum * rightSum) / rightWeight
    if (score > bestScore) {
      bestScore = score
      best = k + 1
    }
  }
  return best
}
