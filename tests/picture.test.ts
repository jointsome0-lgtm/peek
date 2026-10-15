import { describe, expect, test } from 'claude-code/testing'

import { fromBase64 } from '../hooks/base64'
import { DEFAULT_COLOR, MAX_PAIRS, fitCells, rasterCells } from '../hooks/picture'
import type { Pixels } from '../hooks/png'

const UPPER = 0x2580
const LOWER = 0x2584
const SPACE = 0x20

type Cell = readonly [glyph: number, fg: number, bg: number]

function cellsOf(base64: string): Cell[] {
  const bytes = fromBase64(base64)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Cell[] = []
  for (let at = 0; at < bytes.length; at += 12) {
    out.push([view.getUint32(at, true), view.getUint32(at + 4, true), view.getUint32(at + 8, true)])
  }
  return out
}

/** A picture from its pixels, each `[r, g, b, a]`, row by row. */
function pictureOf(width: number, height: number, pixels: readonly (readonly number[])[]): Pixels {
  return { width, height, rgba: Uint8Array.from(pixels.flat()) }
}

// A small fixed sequence of bytes, the same every run.
function bytesFrom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state >>> 24
  }
}

function pairsIn(cells: readonly Cell[]): number {
  return new Set(cells.map(([, fg, bg]) => `${fg}/${bg}`)).size
}

describe('fitCells', () => {
  test('a square picture is half as many rows as columns', () => {
    expect(fitCells(100, 100, 50, 100)).toEqual({ columns: 50, rows: 25 })
  })

  test('a tall picture is narrowed to fit the rows', () => {
    expect(fitCells(100, 1000, 50, 20)).toEqual({ columns: 4, rows: 20 })
  })

  test('a wide strip keeps one row', () => {
    expect(fitCells(1000, 10, 80, 24)).toEqual({ columns: 80, rows: 1 })
  })

  test('never less than one cell', () => {
    expect(fitCells(1, 1, 0.5, 0.5)).toEqual({ columns: 1, rows: 1 })
  })
})

describe('rasterCells', () => {
  const RED = [255, 0, 0, 255]
  const GREEN = [0, 255, 0, 255]
  const BLUE = [0, 0, 255, 255]
  const CLEAR = [0, 0, 0, 0]

  test('the upper half block shows the top pixel over the bottom one', () => {
    const cells = cellsOf(rasterCells(pictureOf(2, 2, [RED, GREEN, BLUE, CLEAR]), 2, 1))
    expect(cells).toEqual([
      [UPPER, 0xff0000, 0x0000ff],
      [UPPER, 0x00ff00, DEFAULT_COLOR],
    ])
  })

  test('a clear top half turns the block over; a clear cell is blank', () => {
    expect(cellsOf(rasterCells(pictureOf(1, 2, [CLEAR, GREEN]), 1, 1))).toEqual([[LOWER, 0x00ff00, DEFAULT_COLOR]])
    expect(cellsOf(rasterCells(pictureOf(1, 2, [CLEAR, CLEAR]), 1, 1))).toEqual([[SPACE, DEFAULT_COLOR, DEFAULT_COLOR]])
  })

  test('each half averages what it covers, clear pixels adding no color', () => {
    const cells = cellsOf(rasterCells(pictureOf(2, 2, [RED, GREEN, BLUE, CLEAR]), 1, 1))
    expect(cells).toEqual([[UPPER, 0x808000, 0x0000ff]])
  })

  test('a half mostly clear shows the terminal behind it', () => {
    const faint = [0, 0, 255, 100]
    const cells = cellsOf(rasterCells(pictureOf(2, 2, [RED, RED, faint, CLEAR]), 1, 1))
    expect(cells).toEqual([[UPPER, 0xff0000, DEFAULT_COLOR]])
  })

  test('noise is cut down to the pairs a Raster paints', () => {
    const next = bytesFrom(7)
    const pixels: number[][] = []
    for (let i = 0; i < 64 * 64; i++) pixels.push([next(), next(), next(), 255])
    const cells = cellsOf(rasterCells(pictureOf(64, 64, pixels), 64, 32))
    expect(cells).toHaveLength(64 * 32)
    expect(pairsIn(cells)).toBeLessThanOrEqual(MAX_PAIRS)
    for (const [glyph, fg, bg] of cells) {
      expect(glyph).toBe(UPPER)
      expect(fg).toBeLessThanOrEqual(0xffffff)
      expect(bg).toBeLessThanOrEqual(0xffffff)
    }
  })

  test('a gradient cut down stays close to itself', () => {
    const pixels: number[][] = []
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels.push([4 * x, 4 * y, 128, 255])
    const cells = cellsOf(rasterCells(pictureOf(64, 64, pixels), 64, 32))
    expect(pairsIn(cells)).toBeLessThanOrEqual(MAX_PAIRS)
    let worst = 0
    cells.forEach(([, fg, bg], i) => {
      const x = i % 64
      const y = (i - x) / 64
      const want = [(4 * x) << 16 | (8 * y) << 8 | 128, (4 * x) << 16 | (8 * y + 4) << 8 | 128]
      ;[fg, bg].forEach((got, half) => {
        for (const shift of [16, 8, 0]) {
          worst = Math.max(worst, Math.abs(((got >> shift) & 0xff) - ((want[half]! >> shift) & 0xff)))
        }
      })
    })
    expect(worst).toBeLessThanOrEqual(8)
  })

  test('cutting keeps cells over the background apart from cells of two colors', () => {
    const next = bytesFrom(11)
    const pixels: number[][] = []
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) pixels.push(y % 2 === 1 && x % 3 === 0 ? CLEAR : [next(), next(), next(), 255])
    }
    const cells = cellsOf(rasterCells(pictureOf(64, 64, pixels), 64, 32))
    expect(pairsIn(cells)).toBeLessThanOrEqual(MAX_PAIRS)
    cells.forEach(([glyph, fg, bg], i) => {
      const overBackground = (i % 64) % 3 === 0
      expect(glyph).toBe(UPPER)
      expect(fg).toBeLessThanOrEqual(0xffffff)
      expect(bg === DEFAULT_COLOR).toBe(overBackground)
    })
  })
})
