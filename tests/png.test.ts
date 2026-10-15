import { describe, expect, test } from 'claude-code/testing'

import { fromBase64, toBase64 } from '../hooks/base64'
import { decodePng, isPng, readPngHeader } from '../hooks/png'
import { VECTORS } from './vectors'

describe('decodePng', () => {
  for (const vector of VECTORS) {
    test(vector.name, () => {
      const pixels = decodePng(fromBase64(vector.png))
      expect(pixels.width).toBe(vector.width)
      expect(pixels.height).toBe(vector.height)
      expect(toBase64(pixels.rgba)).toBe(vector.rgba)
    })
  }

  test('a cut file throws instead of returning pixels', () => {
    const bytes = fromBase64(VECTORS[VECTORS.length - 1]!.png)
    for (const cut of [10, 30, 40, bytes.length - 13]) {
      expect(() => decodePng(bytes.subarray(0, cut))).toThrow()
    }
  })
})

describe('readPngHeader', () => {
  test('reads the size from the first 33 bytes', () => {
    const header = readPngHeader(fromBase64(VECTORS[0]!.png).subarray(0, 33))
    expect(header).toEqual({ width: 13, height: 7, bitDepth: 1, colorType: 0, isInterlaced: false })
  })

  test('refuses what is not a PNG', () => {
    const gif = new TextEncoder().encode('GIF89a and more bytes than a header needs')
    expect(isPng(gif)).toBe(false)
    expect(() => readPngHeader(gif)).toThrow('not a PNG file')
  })
})
