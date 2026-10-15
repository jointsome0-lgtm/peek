import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsStat, On, ProcessRunResult, RenderPropsOf } from 'claude-code'

import { fromBase64, toBase64 } from '../hooks/base64'
import { DEFAULT_COLOR } from '../hooks/picture'
import { fileUrl, parseArgs, withBase } from '../hooks/register'

/** A 2×2 PNG: red, green; blue, clear. */
const DOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwyBNIhgAAA/0gX7yxemzgAAAABJRU5ErkJggg=='
/** The first 33 bytes of a 900×3375 PNG: all a snapshot needs to be measured. */
const SHOT_HEADER = 'iVBORw0KGgoAAAANSUhEUgAAA4QAAA0vCAYAAADaqmVL'
/** The headers of the two bands a 900×3375 snapshot is cut into. */
const BAND_HEADERS = ['iVBORw0KGgoAAAANSUhEUgAAA4QAAAcICAYAAABkcw+L', 'iVBORw0KGgoAAAANSUhEUgAAA4QAAAYnCAYAAAA0/rPc']
const PAGE = '<!doctype html><html><head><title>Spec</title></head><body><img src="chart.png"></body></html>'
const PAGE_SIZE = '<html data-peek-size="1000x3750"><head></head><body></body></html>'

const UPPER = 0x2580
const KITTY = { KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty', XDG_RUNTIME_DIR: '/run/user/1000' }

const VIEWPORT = { columns: 102, rows: 46, isFullscreen: true }
const TOOL = 'mcp__peek__show'

type Fake = { text?: string; base64?: string }
type Files = Record<string, Fake>

function bytesOf(fake: Fake): Uint8Array {
  return fake.base64 === undefined ? new TextEncoder().encode(fake.text ?? '') : fromBase64(fake.base64)
}

// Files the plugin reads and writes, kept in memory.
function fakeFiles(on: On, files: Files): Map<string, string> {
  const written = new Map<string, string>()
  on('fs.stat', ($, e) => {
    const fake = files[e.path]
    if (fake === undefined) return { deny: `ENOENT: ${e.path}` }
    const stat: FsStat = { kind: 'file', size: bytesOf(fake).length, mtimeMs: 0, isLink: false }
    return { value: e.resolve ? { ...stat, realPath: e.path } : stat }
  })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => {
    const fake = files[e.path]
    if (fake === undefined) return { deny: `ENOENT: ${e.path}` }
    return { value: e.as === 'bytes' ? { base64: toBase64(bytesOf(fake)) } : (fake.text ?? '') }
  })
  on('fs.write', ($, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  return written
}

function ran(stdout = ''): ProcessRunResult {
  return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

// Chrome as google-chrome, which reports the page's size and writes a
// screenshot; mkdir and rm, which succeed; ImageMagick as convert, when
// asked for, which cuts a picture into bands; nothing else is installed.
function fakeProcesses(on: On, files: Files, dumped: string, hasMagick = false): string[][] {
  const runs: string[][] = []
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const shot = argv.find(arg => arg.startsWith('--screenshot='))
    if (shot !== undefined) files[shot.slice('--screenshot='.length)] = { base64: SHOT_HEADER }
    if (argv[0] === 'google-chrome') return { value: ran(argv.includes('--dump-dom') ? dumped : 'Google Chrome 151') }
    if (argv[0] === 'mkdir' || argv[0] === 'rm') return { value: ran() }
    if (argv[0] === 'convert' && hasMagick) {
      const out = argv[argv.length - 1]!
      if (argv.includes('-crop')) BAND_HEADERS.forEach((header, at) => {
        files[out.slice('PNG32:'.length).replace('%d', String(at))] = { base64: header }
      })
      return { value: ran(argv.includes('-version') ? 'Version: ImageMagick 6.9' : '') }
    }
    return { value: { ...ran(), exitCode: 127, stderr: `${argv[0]}: not found` } }
  })
  return runs
}

function mountCommandRow($: Engine, args: string) {
  const props: RenderPropsOf['CommandOutput'] = { command: 'peek', args, text: '', isErrored: false }
  return $.ui.mount({ plugin: 'peek', surface: 'terminal', component: 'CommandOutput', props, viewport: VIEWPORT })
}

function mountToolRow($: Engine, id: string, path: string) {
  const props: RenderPropsOf['ToolUse'] = {
    tool_use_id: id,
    tool: TOOL,
    input: { path },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output: '',
  }
  return $.ui.mount({ plugin: 'peek', surface: 'terminal', component: 'ToolUse', requestId: id, props, viewport: VIEWPORT })
}

function peek($: Engine, args: string) {
  return $.command.run({ command: 'peek', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

function cellsOf(base64: string): number[][] {
  const bytes = fromBase64(base64)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: number[][] = []
  for (let at = 0; at < bytes.length; at += 12) {
    out.push([view.getUint32(at, true), view.getUint32(at + 4, true), view.getUint32(at + 8, true)])
  }
  return out
}

describe('arguments', () => {
  test('a path, quoted or not, and a mode flag anywhere', () => {
    expect(parseArgs('pics/a.png')).toEqual({ path: 'pics/a.png' })
    expect(parseArgs('--blocks pics/a.png')).toEqual({ path: 'pics/a.png', mode: 'blocks' })
    expect(parseArgs('"my pics/a b.png" --image')).toEqual({ path: 'my pics/a b.png', mode: 'image' })
    expect(parseArgs('pics/a--blocks.png')).toEqual({ path: 'pics/a--blocks.png' })
    expect(parseArgs('  ')).toEqual({ path: '' })
  })

  test('a copy of a page finds its files beside the original', () => {
    expect(withBase('<!DOCTYPE html>\n<p>hi</p>', 'file:///pages/')).toBe('<!DOCTYPE html><base href="file:///pages/">\n<p>hi</p>')
    expect(withBase('<p>hi</p>', 'file:///a%20b/')).toBe('<base href="file:///a%20b/"><p>hi</p>')
    expect(fileUrl('/a b/c#1.png')).toBe('file:///a%20b/c%231.png')
  })
})

describe('/peek', () => {
  test('alone, says how to use it', async $ => {
    expect((await peek($, '')).text).toContain('Usage: /peek <file>')
  })

  test('puts a folded PNG in the chat that unfolds in full color in kitty', async ($, on) => {
    mock.env(on, KITTY)
    fakeFiles(on, { '/pics/dot.png': { base64: DOT_PNG } })

    const result = await peek($, '/pics/dot.png')
    expect(result.text).toBe('dot.png, 2×2')
    expect(result.context).toEqual([
      'The person sees dot.png in the chat, 2×2, in full color, folded: they unfold it with a click.',
    ])

    const row = await mountCommandRow($, '/pics/dot.png')
    expect((await row.find({ key: 'toggle' }))?.props.label).toBe('▸ dot.png · 2×2 · picture · full color · click to unfold')
    expect(await row.find({ type: 'Image' })).toBeUndefined()

    await row.press({ key: 'toggle' })
    expect((await row.find({ key: 'toggle' }))?.props.label).toBe('▾ dot.png · 2×2 · picture · full color')
    const image = await row.find({ type: 'Image' })
    expect(image?.props).toMatchObject({ source: { file: '/pics/dot.png', format: 'png' }, columns: 1, rows: 1 })

    await row.press({ key: 'toggle' })
    expect(await row.find({ type: 'Image' })).toBeUndefined()
  })

  test('--blocks draws colored half blocks even in kitty', async ($, on) => {
    mock.env(on, KITTY)
    fakeFiles(on, { '/pics/dot.png': { base64: DOT_PNG } })

    await peek($, '/pics/dot.png --blocks')
    const row = await mountCommandRow($, '/pics/dot.png --blocks')
    await row.press({ key: 'toggle' })
    const raster = await row.find({ type: 'Raster' })
    expect(raster?.props).toMatchObject({ columns: 2, rows: 1 })
    expect(cellsOf(String(raster?.props.cells))).toEqual([
      [UPPER, 0xff0000, 0x0000ff],
      [UPPER, 0x00ff00, DEFAULT_COLOR],
    ])
  })

  test('snapshots a page laid out as wide as the chat', async ($, on) => {
    mock.env(on, KITTY)
    const files: Files = { '/pages/spec.html': { text: PAGE } }
    const written = fakeFiles(on, files)
    const runs = fakeProcesses(on, files, PAGE_SIZE)

    const result = await peek($, '/pages/spec.html')
    expect(result.text).toBe('spec.html, a 900×3375 snapshot of the page')

    const [measure, copy] = [...written][0]!
    expect(measure).toMatch(/^\/run\/user\/1000\/peek\/measure-[0-9a-f]{8}\.html$/)
    expect(copy).toStartWith('<!doctype html><base href="file:///pages/"><html>')
    expect(copy).toContain("setAttribute('data-peek-size'")

    const chrome = runs.filter(argv => argv[0] === 'google-chrome' && !argv.includes('--version'))
    expect(chrome).toHaveLength(2)
    const [layout, shot] = chrome as [string[], string[]]
    expect(layout).toContain('--window-size=1000,600')
    expect(layout).toContain('--dump-dom')
    expect(layout[layout.length - 1]).toBe(fileUrl(measure))
    expect(shot).toContain('--force-device-scale-factor=1.06')
    expect(shot).toContain('--window-size=1000,3750')
    expect(shot[shot.length - 1]).toBe('file:///pages/spec.html')

    const row = await mountCommandRow($, '/pages/spec.html')
    await row.press({ key: 'toggle' })
    const image = await row.find({ type: 'Image' })
    expect(image?.props).toMatchObject({ columns: 100, rows: 188, source: { format: 'png' } })
  })

  test('cuts a tall page into bands that each fill the chat, centered', async ($, on) => {
    mock.env(on, KITTY)
    const files: Files = { '/pages/spec.html': { text: PAGE } }
    fakeFiles(on, files)
    const runs = fakeProcesses(on, files, PAGE_SIZE, true)

    await peek($, '/pages/spec.html')
    const crop = runs.find(argv => argv.includes('-crop'))
    expect(crop).toEqual([
      'convert',
      expect.stringMatching(/^\/run\/user\/1000\/peek\/page-[0-9a-f]{8}\.png$/),
      '-crop',
      '900x1800',
      '+repage',
      expect.stringMatching(/^PNG32:\/run\/user\/1000\/peek\/band-[0-9a-f]{8}-%d\.png$/),
    ])

    const row = await mountCommandRow($, '/pages/spec.html')
    await row.press({ key: 'toggle' })
    const first = await row.find({ key: 'picture-0' })
    const second = await row.find({ key: 'picture-1' })
    expect(first?.props).toMatchObject({ columns: 100, rows: 100 })
    expect(second?.props).toMatchObject({ columns: 100, rows: 88 })
    expect(String((first?.props.source as { file: string }).file)).toMatch(/band-[0-9a-f]{8}-0\.png$/)
    const boxes = await row.findAll({ type: 'Box' })
    expect(boxes.some(box => box.props.alignItems === 'center')).toBe(true)
  })

})

describe('the show tool', () => {
  test('puts the picture in its own row and tells the model', { options: { mode: 'blocks' } }, async ($, on) => {
    mock.env(on, {})
    fakeFiles(on, { '/pics/dot.png': { base64: DOT_PNG } })

    const result = await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_1', path: '/pics/dot.png', title: 'Dot' })
    expect(result.result).toBe('The person sees Dot in the chat, 2×2, as colored blocks, folded: they unfold it with a click.')

    const row = await mountToolRow($, 'toolu_1', '/pics/dot.png')
    expect((await row.find({ key: 'toggle' }))?.props.label).toBe('▸ Dot · 2×2 · picture · blocks · click to unfold')
    await row.press({ key: 'toggle' })
    expect(await row.find({ type: 'Raster' })).toBeDefined()
  })

  test('refuses a file that is not there', async ($, on) => {
    mock.env(on, KITTY)
    fakeFiles(on, {})
    const result = await $.tool.call({ tool: TOOL, path: '/pics/gone.png' })
    expect(JSON.stringify(result)).toContain('peek: no file at /pics/gone.png')
  })
})
