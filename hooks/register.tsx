// peek: a picture, or a snapshot of an HTML page, in a row of the chat that
// unfolds with a click. kitty and Ghostty draw its pixels; other terminals
// draw colored half blocks. The person runs /peek <file>; the model calls
// the show tool.

import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, ImageSource, ProcessRunResult, Register, RenderInput } from 'claude-code'

import type { PeekBand, PeekLive, PeekMode, PeekPicture } from '../types'
import { fromBase64 } from './base64'
import { CELL_ASPECT, fitCells, rasterCells } from './picture'
import { decodePng, readPngHeader, type Pixels, type PngHeader } from './png'
import { actLive, closeLive, openLive } from './prototype-live'
import { drawIndex, drawReader, EXTRACT_SCRIPT, openReader, READER_PANE, readExtracted, textOf, type LiveAction } from './prototype-text'

type Engine = EngineInterface

const TOOL = 'mcp__peek__show'
const shownAtom = atom({ plugin: 'peek', key: 'shown' } as const, {})
const isOpenAtom = atom({ plugin: 'peek', key: 'isOpen' } as const, false)
/** PROTOTYPE (reader): the page the reader pane shows; the scan wants it named here too. */
const readerAtom = atom({ plugin: 'peek', key: 'reader' } as const, null)

/** Rows past this many lose their pictures, oldest first, and draw as text. */
const MAX_SHOWN = 30
/** The most `$.fs.read` takes. */
const MAX_READ = 4 * 1024 * 1024
/** The most an Image's `{ png }` source holds. */
const MAX_PNG_SOURCE = 2 * 1024 * 1024
/** Pixels across one terminal cell: a guess, as nothing reports it (kitty here: 9). */
const CELL_PX = 9
/** The widest a page is laid out, in CSS pixels: a wider chat gets a sharper shot. */
const PAGE_WIDTH = 1000
/** The narrowest a page is laid out: a narrower chat shows it smaller. */
const MIN_PAGE_WIDTH = 600
/** The window height a page is measured in. */
const MEASURE_HEIGHT = 600
/** Pages are cut at this height, in CSS pixels. */
const MAX_PAGE_HEIGHT = 12_000
/** The most pixels a snapshot holds: about 100 MB in the terminal. */
const MAX_SHOT_PIXELS = 24_000_000
/** The longest side of a converted picture. */
const MAX_SIDE = 2048
/** The longest side of a picture made for blocks, which show few pixels. */
const BLOCKS_SIDE = 800
/** Pictures with more pixels are shrunk before blocks decode them. */
const MAX_BLOCKS_PIXELS = 4_000_000
const MAX_IMAGE_COLUMNS = 255
const MAX_IMAGE_ROWS = 255
const MAX_RASTER_COLUMNS = 512
const MAX_RASTER_ROWS = 256
const BROWSER_TIMEOUT_MS = 60_000
const TOOL_TIMEOUT_MS = 60_000

const USAGE =
  'Usage: /peek <file> [--text|--live] [--blocks|--image]. Shows a PNG, JPEG, WebP, GIF, SVG or HTML page; --text reads a page as text, --live keeps it open so its buttons and fields work (prototypes).'

const TOOL_DESCRIPTION = [
  'Shows a picture or an HTML page to the person right in the chat, inside their terminal, as a row',
  'they unfold with a click, so they need not open a browser or an image viewer. Takes PNG, JPEG, WebP,',
  'GIF, BMP and SVG files, and HTML pages, which headless Chrome draws as a snapshot (about 1000 px wide;',
  'scripts get 3 seconds). kitty and Ghostty show full color; other terminals show coarse colored blocks.',
  'Use it when a picture or page you made should be seen.',
].join(' ')

// Sets data-peek-size on the root once the page has loaded, and again late
// in the browser's time budget: the page's own width, and its height, which
// is the root's box unless content overflows the window.
const PAGE_MEASURE =
  '<script>(()=>{const m=()=>{const r=document.documentElement;' +
  'const h=Math.max(r.getBoundingClientRect().height,r.scrollHeight>innerHeight+1?r.scrollHeight:0);' +
  "r.setAttribute('data-peek-size',Math.ceil(r.scrollWidth)+'x'+Math.ceil(h))};" +
  "addEventListener('load',m);setTimeout(m,2500)})()</script>"

// The same for one picture: the box it lays out to.
const IMAGE_MEASURE =
  "<script>addEventListener('load',()=>{const b=document.getElementById('peek').getBoundingClientRect();" +
  "document.documentElement.setAttribute('data-peek-size',Math.round(b.width)+'x'+Math.round(b.height))})</script>"

const BROWSERS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
  'brave-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]

type Kind = 'page' | 'svg' | 'png' | 'image'

const KINDS: readonly (readonly [RegExp, Kind])[] = [
  [/\.(html?|xhtml)$/i, 'page'],
  [/\.svgz?$/i, 'svg'],
  [/\.png$/i, 'png'],
  [/\.(jpe?g|jfif|webp|gif|bmp|avif|tiff?|ico|heic|heif)$/i, 'image'],
]

type Found = { path: string; size: number }
type Made = Pick<PeekPicture, 'kind' | 'file' | 'size' | 'width' | 'height' | 'small' | 'bands' | 'note' | 'text' | 'live'>
type ShowRequest = { row: string; path: string; title?: string; mode?: PeekMode; view?: ViewKind; columns: number }
/** PROTOTYPE: a page read as text, or kept open live. */
type ViewKind = 'text' | 'live'
type Shown = { text: string; forModel: string; title: string; isText: boolean }

// What the module learns as it goes; a reload starts it over.
let detectedMode: PeekMode | undefined
let isRemote: boolean | undefined
let cacheDir: string | undefined
let browser: string | null | undefined
let magick: readonly string[] | null | undefined
let lastColumns: number | undefined
let decoded: { key: string; pixels: Pixels } | undefined
let pngSource: { key: string; base64: string } | undefined
const cellCache = new Map<string, string>()

export const register: Register = (on, options) => {
  const configured: PeekMode | undefined =
    options.mode === 'image' || options.mode === 'blocks' ? options.mode : undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'peek',
      description: 'Show a picture or an HTML page in the chat',
      argumentHint: '<file> [--text|--live] [--blocks|--image]',
    })
    await $.tool.register({
      name: 'show',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The file: absolute, or relative to the working directory' },
          title: { type: 'string', description: "A short caption for the picture; the file's name when left out" },
        },
        required: ['path'],
        additionalProperties: false,
      },
      isDeferred: false,
    })
    // PROTOTYPE (reader): a reader closed while the module was away leaves no page behind.
    const panes = await $.ui.panes().catch(() => [])
    if (!panes.some(pane => pane.id === READER_PANE)) await update($, readerAtom, now => (now === null ? now : null))

    return next(e)
  })

  on('command.run', { command: 'peek' }, async ($, e) => {
    const { path, mode, view } = parseArgs(e.args)
    if (path === '') return { text: USAGE }
    try {
      const row = commandRow(e.args)
      const shown = await show($, configured, { row, path, mode, view, columns: e.presentation.columns })
      // PROTOTYPE (reader): a page as text opens in the reader pane beside the chat.
      if (shown.isText) {
        const opened = await openReader($, row, shown.title)
        if (!opened.isPlaced) {
          return { text: `${shown.text}; the reader waits: ${opened.reason}`, context: [`${shown.forModel} The reader waits: ${opened.reason}.`] }
        }
      }

      return { text: shown.text, context: [shown.forModel] }
    } catch (error) {
      return { text: messageOf(error) }
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { path?: unknown; title?: unknown }
    if (typeof input.path !== 'string' || input.path.trim() === '') {
      return { deny: 'peek: `path` must name a file' }
    }
    const title = typeof input.title === 'string' ? input.title : undefined
    try {
      const shown = await show($, configured, {
        row: `tool:${e.tool_use_id}`,
        path: input.path,
        title,
        columns: lastColumns ?? 100,
      })

      return { result: shown.forModel }
    } catch (error) {
      return { deny: `peek: ${messageOf(error)}` }
    }
  }).catch(($, e, next) => ({ deny: `peek could not show it: ${next.error.message ?? next.error.kind}` }))

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'peek' || e.props.isErrored) return next(e)
    const row = commandRow(e.props.args)
    const picture = (await read($, shownAtom))[row]
    if (picture === undefined) return next(e)

    return drawRow($, e, picture, configured, row)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== TOOL || e.props.isRunning || e.props.isErrored) return next(e)
    const row = `tool:${e.props.tool_use_id}`
    const picture = (await read($, shownAtom))[row]
    if (picture === undefined) return next(e)

    return drawRow($, e, picture, configured, row)
  })

  // PROTOTYPE (reader): the page read beside the chat, whole and never folded.
  on('ui.render', { component: 'Pane', requestId: READER_PANE }, async ($, e) => {
    const reader = await read($, readerAtom)
    const picture = reader === null ? undefined : (await read($, shownAtom))[reader.row]
    const { Text } = $.ui.resolve(e)
    if (reader === null || picture?.text === undefined) {
      return <Text dimColor>Nothing to read: /peek a page with --text or --live.</Text>
    }
    try {
      const mode = picture.mode ?? configured ?? (await terminalMode($))
      const live = picture.live
      return await drawReader($, e, picture, picture.text, {
        columns: e.props.bodyColumns,
        endRows: e.props.placement === 'dock' ? Math.max(0, e.props.scroll.bodyRows - 2) : 0,
        drawsImage: mode === 'image' && !(await remoteSession($)),
        act: live === undefined ? undefined : liveAct($, reader.row, live),
      })
    } catch (error) {
      return <Text color="red">{`Cannot draw ${picture.title}: ${messageOf(error)}`}</Text>
    }
  })

  // PROTOTYPE (reader): the reader closed, its page and the band go too.
  on('ui.close', { id: READER_PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, readerAtom, () => null)
    return closed
  }).catch(($, e, next) => next(e))

  // PROTOTYPE (index): the sections of the page in the reader, in the band
  // above the prompt, while the reader is open.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const reader = await read($, readerAtom)
    if (reader === null) return next(e)
    const picture = (await read($, shownAtom))[reader.row]
    if (picture === undefined) return next(e)
    return (await drawIndex($, e, reader, picture)) ?? next(e)
  })
}

/** PROTOTYPE (live text): a press works in the page, then the reader shows it anew. */
function liveAct($: Engine, row: string, live: PeekLive) {
  return async (action: LiveAction) => {
    const done = await actLive($, live, action)
    await update($, shownAtom, shown => {
      const old = shown[row]
      if (old === undefined) return shown
      const generation = Math.max(0, ...Object.values(shown).map(each => each.generation)) + 1
      const [width, height] = done.size
      return { ...shown, [row]: { ...old, text: done.text, live: done.live, width, height, generation } }
    })
    return done.notice
  }
}

function commandRow(args: string): string {
  return `cmd:${args.trim()}`
}

/**
 * A row of the chat holding a picture: a toggle naming it, and under it,
 * once unfolded, the picture as wide as the chat (a picture is not stretched
 * past twice its size, nor taller than the screen; a page is as tall as it is).
 */
async function drawRow($: Engine, e: RenderInput, picture: PeekPicture, configured: PeekMode | undefined, row: string) {
  if (e.surface !== 'terminal') {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${picture.title}: peek draws its pictures in the terminal.`}</Text>
  }
  const { Box, Text, Button, Image, Raster } = $.ui.resolve(e)

  const columns = Math.max(10, (e.viewport?.columns ?? lastColumns ?? 100) - 2)
  lastColumns = columns
  const screenRows = Math.max(8, (e.viewport?.rows ?? 40) - 6)
  const isOpen = memberOf(isOpenAtom, e)
  const open = await read($, isOpen)
  const mode = picture.mode ?? configured ?? (await terminalMode($))
  const remote = await remoteSession($)
  const drawsImage = mode === 'image' && (!remote || picture.size <= MAX_PNG_SOURCE)
  const isPage = picture.kind === 'page'
  const text = picture.text // PROTOTYPE (native-text)

  const facts =
    text === undefined
      ? [`${picture.width}×${picture.height}`, isPage ? 'page' : 'picture', drawsImage ? 'full color' : 'blocks']
      : picture.live !== undefined
        ? ['live page', `${text.sections.length} sections`, `${text.controls?.length ?? 0} controls`, 'prototype']
        : ['page as text', `${text.sections.length} sections`, `${text.figures.length} figures`, 'prototype']
  if (picture.note !== undefined) facts.push(picture.note)
  if (text === undefined && mode === 'image' && !drawsImage) facts.push('too big to send over ssh')
  if (text === undefined && drawsImage && picture.madeFor === 'blocks') facts.push('few pixels: /peek it again')
  // PROTOTYPE (reader): a page as text is read in the pane beside the chat;
  // its row is one line that opens it there.
  if (text !== undefined) {
    const reader = await read($, readerAtom)
    const isRead = reader !== null && reader.row === row
    return (
      <Button
        key="reader"
        plain
        label={`${isRead ? '▸' : '▹'} ${picture.title} · ${facts.join(' · ')} · ${isRead ? 'in the reader beside the chat' : 'click to read it beside the chat'}`}
        onPress={() => void openReader($, row, picture.title)}
      />
    )
  }
  const toggle = (
    <Button
      key="toggle"
      plain
      label={`${open ? '▾' : '▸'} ${picture.title} · ${facts.join(' · ')}${open ? '' : ' · click to unfold'}`}
      onPress={() => void update($, isOpen, value => !value)}
    />
  )
  if (!open) return toggle

  let body: JSX.Element
  try {
    const bands = drawsImage && !remote ? picture.bands : undefined
    if (bands !== undefined) {
      const wide = Math.min(columns, MAX_IMAGE_COLUMNS)
      body = (
        <Box flexDirection="column">
          {bands.map((band, at) => {
            const size = fitCells(band.width, band.height, wide, MAX_IMAGE_ROWS)
            return (
              <Image
                key={`picture-${at}`}
                source={{ file: band.file, format: 'png', generation: picture.generation }}
                columns={size.columns}
                rows={size.rows}
                alt={at === 0 ? `${picture.title}: this terminal shows no pictures; set peek's mode to blocks in /config` : ' '}
              />
            )
          })}
        </Box>
      )
    } else if (drawsImage) {
      const most = isPage ? MAX_IMAGE_COLUMNS : Math.ceil((picture.width * 2) / CELL_PX)
      const size = fitCells(
        picture.width,
        picture.height,
        Math.min(columns, MAX_IMAGE_COLUMNS, most),
        isPage ? MAX_IMAGE_ROWS : Math.min(screenRows, MAX_IMAGE_ROWS),
      )
      const source: ImageSource = remote
        ? { png: await pngBase64($, picture) }
        : { file: picture.file, format: 'png', generation: picture.generation }
      body = (
        <Image
          key="picture"
          source={source}
          columns={size.columns}
          rows={size.rows}
          alt={`${picture.title}: this terminal shows no pictures; set peek's mode to blocks in /config`}
        />
      )
    } else {
      const size = fitCells(
        picture.width,
        picture.height,
        Math.min(columns, MAX_RASTER_COLUMNS, picture.width),
        isPage ? MAX_RASTER_ROWS : Math.min(screenRows, MAX_RASTER_ROWS),
      )
      const cells = await cellsFor($, picture, size.columns, size.rows)
      body = <Raster key="picture" columns={size.columns} rows={size.rows} cells={cells} />
    }
  } catch (error) {
    body = <Text color="red">{`Cannot draw ${picture.title}: ${messageOf(error)}`}</Text>
  }

  return (
    <Box flexDirection="column">
      {toggle}
      <Box flexDirection="column" alignItems="center" width="100%">
        {body}
      </Box>
    </Box>
  )
}

/** Loads the file, keeps it for its row, and says so. */
async function show($: Engine, configured: PeekMode | undefined, request: ShowRequest): Promise<Shown> {
  const found = await resolvePath($, request.path)
  const name = found.path.slice(found.path.lastIndexOf('/') + 1)
  const title = request.title?.trim() || name
  const mode = request.mode ?? configured ?? (await terminalMode($))
  const made = await load($, found, mode, Math.max(10, request.columns - 2), request.view)

  let replaced: PeekPicture | undefined
  await update($, shownAtom, shown => {
    replaced = shown[request.row]
    const generation = Math.max(0, ...Object.values(shown).map(picture => picture.generation)) + 1
    const picture: PeekPicture = { ...made, path: request.path, title, madeFor: mode, generation }
    if (request.mode !== undefined) picture.mode = request.mode
    const kept = Object.entries(shown).filter(([row]) => row !== request.row)
    return Object.fromEntries([...kept.slice(-(MAX_SHOWN - 1)), [request.row, picture]])
  })
  if (replaced?.live !== undefined && replaced.live.page !== made.live?.page) closeLive($, replaced.live)

  const what =
    made.live !== undefined && made.text !== undefined
      ? `the page live: ${made.text.sections.length} sections, ${made.text.controls?.length ?? 0} controls`
      : made.text !== undefined
      ? `the page as text: ${made.text.sections.length} sections, ${made.text.figures.length} figures`
      : made.kind === 'page'
        ? `a ${made.width}×${made.height} snapshot of the page`
        : `${made.width}×${made.height}`
  const how = made.live !== undefined ? 'as text whose buttons and fields work' : mode === 'image' ? 'in full color' : 'as colored blocks'
  const note = made.note === undefined ? '' : ` (${made.note})`

  return {
    text: `${title}, ${what}${note}`,
    forModel:
      made.text !== undefined
        ? `The person reads ${title} in a reader pane beside the chat, ${what}${made.live !== undefined ? `, ${how}` : ''}${note}; the band above the prompt scrolls it to a section.`
        : `The person sees ${title} in the chat, ${what}, ${how}${note}, folded: they unfold it with a click.`,
    title,
    isText: made.text !== undefined,
  }
}

async function load($: Engine, found: Found, mode: PeekMode, columns: number, view?: ViewKind): Promise<Made> {
  let kind = KINDS.find(([pattern]) => pattern.test(found.path))?.[1]
  if (kind === undefined) {
    const header = await pngHeaderOf($, found).catch(() => undefined)
    kind = header === undefined ? 'image' : 'png'
  }
  switch (kind) {
    case 'page':
      if (view === 'live') return livePage($, found, mode, columns)
      return view === 'text' ? textPage($, found, mode, columns) : snapshotPage($, found, mode, columns)
    case 'svg':
      return pictureViaBrowser($, found, mode, { vectorColumns: columns })
    case 'png':
      return pngFile($, found, mode)
    case 'image':
      return convertPicture($, found, mode)
  }
}

async function pngFile($: Engine, found: Found, mode: PeekMode): Promise<Made> {
  const { width, height } = await pngHeaderOf($, found)
  const made: Made = { kind: 'picture', file: found.path, size: found.size, width, height }
  if (mode === 'blocks' && (found.size > MAX_READ || width * height > MAX_BLOCKS_PIXELS)) {
    const small = await shrink($, found, { width, height })
    made.small = { file: small.path, size: small.size }
  }
  return made
}

/** A PNG of any picture format ImageMagick reads, else the browser. */
async function convertPicture($: Engine, found: Found, mode: PeekMode): Promise<Made> {
  const side = mode === 'blocks' ? BLOCKS_SIDE : MAX_SIDE
  const out = `${await cacheOf($)}/picture-${hashOf(found.path)}.png`
  if (await magickConvert($, found.path, out, side)) return madeFrom($, out, 'picture')
  if ((await findBrowser($)) !== null) return pictureViaBrowser($, found, mode, {})
  throw new Error('showing this kind of picture takes ImageMagick or Chrome; neither was found')
}

/** A small copy for blocks to decode. */
async function shrink($: Engine, found: Found, size: { width: number; height: number }): Promise<Found> {
  const out = `${await cacheOf($)}/small-${hashOf(found.path)}.png`
  if (await magickConvert($, found.path, out, BLOCKS_SIDE)) return statOf($, out)
  if ((await findBrowser($)) !== null) {
    const made = await pictureViaBrowser($, found, 'blocks', { size, out })
    return { path: made.file, size: made.size }
  }
  throw new Error('this PNG is too big for blocks: shrinking it takes ImageMagick or Chrome')
}

async function magickConvert($: Engine, from: string, out: string, side: number): Promise<boolean> {
  const tool = await findMagick($)
  if (tool === null) return false
  await removeFile($, out)
  try {
    const ran = await $.process.run(
      [...tool, `${from}[0]`, '-auto-orient', '-resize', `${side}x${side}>`, `PNG32:${out}`],
      { timeoutMs: TOOL_TIMEOUT_MS },
    )
    return ran.exitCode === 0 && (await $.fs.exists(out))
  } catch {
    return false
  }
}

/**
 * The page as headless Chrome draws it: laid out about as wide as the pane
 * in pixels, measured in a copy that reports its height, then shot whole.
 */
async function snapshotPage($: Engine, found: Found, mode: PeekMode, columns: number): Promise<Made> {
  const chrome = await needBrowser($)
  const dir = await cacheOf($)
  const id = hashOf(found.path)
  const panePx = columns * CELL_PX
  let width = clamp(Math.round(panePx), MIN_PAGE_WIDTH, PAGE_WIDTH)
  let height = MAX_PAGE_HEIGHT
  let note: string | undefined

  if (found.size <= MAX_READ) {
    const measure = `${dir}/measure-${id}.html`
    await $.fs.write(measure, withBase(await $.fs.read(found.path), directoryUrl(found.path)) + PAGE_MEASURE)
    const ran = await runBrowser($, chrome, [`--window-size=${width},${MEASURE_HEIGHT}`, '--dump-dom', fileUrl(measure)])
    const size = /data-peek-size="(\d+)x(\d+)"/.exec(ran.stdout)
    if (size === null) throw new Error(`Chrome could not lay the page out${whyFrom(ran)}`)
    width = clamp(Number(size[1]), width, 2 * PAGE_WIDTH)
    height = Number(size[2])
  } else {
    note = 'over 4 MiB, so not measured'
  }
  if (height > MAX_PAGE_HEIGHT) {
    note = `cut at ${MAX_PAGE_HEIGHT} of ${height} px`
    height = MAX_PAGE_HEIGHT
  }
  height = Math.max(height, 50)

  const shot = `${dir}/page-${id}.png`
  const scale = shotScale(mode, panePx, width, height)
  await shoot($, chrome, shot, [`--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`], fileUrl(found.path), false)
  const made = await madeFrom($, shot, 'page')
  if (note !== undefined) made.note = note
  const bands = mode === 'image' ? await cutBands($, made, `${dir}/band-${id}`) : undefined
  if (bands !== undefined) made.bands = bands
  return made
}

/**
 * PROTOTYPE (native-text): the page read as text by Chrome, laid out as wide
 * as for a snapshot; in image mode its figures are cut from a snapshot of
 * the same copy at the same width, so their boxes line up.
 */
async function textPage($: Engine, found: Found, mode: PeekMode, columns: number): Promise<Made> {
  if (found.size > MAX_READ) throw new Error('reading a page as text takes a page under 4 MiB')
  const chrome = await needBrowser($)
  const dir = await cacheOf($)
  const id = hashOf(found.path)
  const panePx = columns * CELL_PX
  const width = clamp(Math.round(panePx), MIN_PAGE_WIDTH, PAGE_WIDTH)
  const copy = `${dir}/text-${id}.html`
  await $.fs.write(copy, withBase(await $.fs.read(found.path), directoryUrl(found.path)) + EXTRACT_SCRIPT)
  const ran = await runBrowser($, chrome, [`--window-size=${width},${MEASURE_HEIGHT}`, '--dump-dom', fileUrl(copy)])
  const page = readExtracted(ran.stdout)
  const { text, boxes } = textOf(page, width)
  const [pageWidth, pageHeight] = page.size

  const tool = boxes.length > 0 && mode === 'image' ? await findMagick($) : null
  if (tool !== null) {
    const height = clamp(pageHeight, 50, MAX_PAGE_HEIGHT)
    const scale = shotScale(mode, panePx, width, height)
    const shot = `${dir}/text-${id}.png`
    await shoot($, chrome, shot, [`--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`], fileUrl(copy), false)
    for (const [at, box] of boxes.entries()) {
      const figure = text.figures[at]
      if (figure === undefined || box.w < 1 || box.h < 1 || box.y + box.h > height) continue
      const out = `${dir}/text-${id}-${at}.png`
      const crop = `${Math.ceil(box.w * scale)}x${Math.ceil(box.h * scale)}+${Math.floor(box.x * scale)}+${Math.floor(box.y * scale)}`
      try {
        const cut = await $.process.run([...tool, shot, '-crop', crop, '+repage', `PNG32:${out}`], { timeoutMs: TOOL_TIMEOUT_MS })
        if (cut.exitCode !== 0) continue
        const made = await statOf($, out)
        const header = await pngHeaderOf($, made)
        Object.assign(figure, { file: out, size: made.size, width: header.width, height: header.height })
      } catch {
        continue
      }
    }
  }
  return { kind: 'page', file: found.path, size: found.size, width: pageWidth, height: pageHeight, text }
}

/**
 * PROTOTYPE (live text): the page opened in the live helper's Chrome, laid out
 * as wide as for a snapshot and kept open, so its controls work from the row.
 */
async function livePage($: Engine, found: Found, mode: PeekMode, columns: number): Promise<Made> {
  const browser = await needBrowser($)
  const dir = await cacheOf($)
  const panePx = columns * CELL_PX
  const width = clamp(Math.round(panePx), MIN_PAGE_WIDTH, PAGE_WIDTH)
  const scale = shotScale(mode, panePx, width, 2000)
  const opened = await openLive($, { file: found.path, width, scale, dir, browser })
  const [pageWidth, pageHeight] = opened.size
  return { kind: 'page', file: found.path, size: found.size, width: pageWidth, height: pageHeight, text: opened.text, live: opened.live }
}

/**
 * A page too tall for one Image at full width, cut into bands that each
 * fit one: an Image is at most 255 rows, so a band is at most
 * `CELL_ASPECT` times as tall as it is wide. Undefined when it needs no
 * cutting or ImageMagick is missing, so the page is drawn narrower whole.
 */
async function cutBands($: Engine, made: Made, prefix: string): Promise<PeekBand[] | undefined> {
  const band = Math.floor(made.width * CELL_ASPECT)
  if (made.height <= band) return undefined
  const tool = await findMagick($)
  if (tool === null) return undefined
  const count = Math.ceil(made.height / band)
  try {
    const ran = await $.process.run(
      [...tool, made.file, '-crop', `${made.width}x${band}`, '+repage', `PNG32:${prefix}-%d.png`],
      { timeoutMs: TOOL_TIMEOUT_MS },
    )
    if (ran.exitCode !== 0) return undefined
    const bands: PeekBand[] = []
    for (let at = 0; at < count; at++) {
      const found = await statOf($, `${prefix}-${at}.png`)
      const height = at < count - 1 ? band : made.height - band * (count - 1)
      bands.push({ file: found.path, size: found.size, width: made.width, height })
    }
    return bands
  } catch {
    return undefined
  }
}

type ViaBrowser = {
  /** The pane's columns, for a vector picture laid out like a page. */
  vectorColumns?: number
  /** The picture's size when known, which skips measuring it. */
  size?: { width: number; height: number }
  /** Where the PNG goes; the cache's picture file when left out. */
  out?: string
}

/** A PNG of a picture Chrome opens (SVG, and raster formats ImageMagick is missing for). */
async function pictureViaBrowser($: Engine, found: Found, mode: PeekMode, via: ViaBrowser): Promise<Made> {
  const chrome = await needBrowser($)
  const dir = await cacheOf($)
  const id = hashOf(found.path)
  const source = fileUrl(found.path)
  const isVector = via.vectorColumns !== undefined

  let size = via.size
  if (size === undefined) {
    const measure = `${dir}/measure-${id}.html`
    await $.fs.write(measure, pictureDocument(source, isVector ? `width:${PAGE_WIDTH}px` : '') + IMAGE_MEASURE)
    const ran = await runBrowser($, chrome, [`--window-size=${PAGE_WIDTH},${MEASURE_HEIGHT}`, '--dump-dom', fileUrl(measure)])
    const measured = /data-peek-size="(\d+)x(\d+)"/.exec(ran.stdout)
    if (measured === null || measured[1] === '0' || measured[2] === '0') {
      throw new Error(`Chrome could not open the picture${whyFrom(ran)}`)
    }
    size = { width: Number(measured[1]), height: Number(measured[2]) }
  }

  const side = mode === 'blocks' ? BLOCKS_SIDE : MAX_SIDE
  const scale = isVector
    ? shotScale(mode, (via.vectorColumns ?? 100) * CELL_PX, size.width, size.height)
    : Math.min(1, side / Math.max(size.width, size.height))
  const document = `${dir}/picture-${id}.html`
  await $.fs.write(document, pictureDocument(source, `width:${size.width}px;height:${size.height}px`))
  const out = via.out ?? `${dir}/picture-${id}.png`
  await shoot(
    $,
    chrome,
    out,
    [`--force-device-scale-factor=${round2(scale)}`, `--window-size=${size.width},${size.height}`],
    fileUrl(document),
    true,
  )
  return madeFrom($, out, 'picture')
}

/** How many device pixels to each CSS pixel: about the pane's own pixels. */
function shotScale(mode: PeekMode, panePx: number, width: number, height: number): number {
  const wanted = mode === 'blocks' ? Math.min(1, (4 * panePx) / CELL_PX / width) : panePx / width
  const most = Math.sqrt(MAX_SHOT_PIXELS / (width * height))
  return round2(clamp(Math.min(wanted, most), 0.25, 2))
}

async function shoot($: Engine, chrome: string, out: string, args: string[], url: string, isClear: boolean): Promise<void> {
  await removeFile($, out)
  const clear = isClear ? ['--default-background-color=00000000'] : []
  const ran = await runBrowser($, chrome, [...args, ...clear, `--screenshot=${out}`, url])
  if (!(await $.fs.exists(out))) throw new Error(`Chrome made no picture${whyFrom(ran)}`)
}

function runBrowser($: Engine, chrome: string, args: string[]): Promise<ProcessRunResult> {
  return $.process.run(
    [
      chrome,
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--virtual-time-budget=3000',
      ...args,
    ],
    { timeoutMs: BROWSER_TIMEOUT_MS },
  )
}

async function madeFrom($: Engine, file: string, kind: Made['kind']): Promise<Made> {
  const found = await statOf($, file)
  const { width, height } = await pngHeaderOf($, found)
  return { kind, file, size: found.size, width, height }
}

/** The first 33 bytes of a PNG, which hold its header. */
async function pngHeaderOf($: Engine, found: Found): Promise<PngHeader> {
  if (found.size <= 65_536) {
    const { base64 } = await $.fs.read(found.path, { as: 'bytes' })
    return readPngHeader(fromBase64(base64))
  }
  const ran = await $.process.run(['od', '-A', 'n', '-t', 'u1', '-N', '33', found.path])
  if (ran.exitCode !== 0) throw new Error(`cannot read ${found.path}: ${ran.stderr.trim()}`)
  return readPngHeader(Uint8Array.from(ran.stdout.trim().split(/\s+/), Number))
}

// The pixels blocks draw from, and the cells per size, kept for the
// latest picture only.
async function cellsFor($: Engine, picture: PeekPicture, columns: number, rows: number): Promise<string> {
  const source = picture.small ?? { file: picture.file, size: picture.size }
  const key = `${picture.generation}:${source.file}`
  if (decoded?.key !== key) {
    if (source.size > MAX_READ) throw new Error('too big for blocks: /peek it again')
    const { base64 } = await $.fs.read(source.file, { as: 'bytes' })
    decoded = { key, pixels: decodePng(fromBase64(base64)) }
    cellCache.clear()
  }
  const sized = `${columns}x${rows}`
  let cells = cellCache.get(sized)
  if (cells === undefined) {
    cells = rasterCells(decoded.pixels, columns, rows)
    cellCache.set(sized, cells)
  }
  return cells
}

async function pngBase64($: Engine, picture: PeekPicture): Promise<string> {
  const key = `${picture.generation}:${picture.file}`
  if (pngSource?.key !== key) {
    const { base64 } = await $.fs.read(picture.file, { as: 'bytes' })
    pngSource = { key, base64 }
  }
  return pngSource.base64
}

/** `image` where the terminal draws pictures (kitty, Ghostty), else `blocks`. */
async function terminalMode($: Engine): Promise<PeekMode> {
  if (detectedMode === undefined) {
    const [kitty, ghostty, term, program, tmux] = await Promise.all([
      $.env.get('KITTY_WINDOW_ID'),
      $.env.get('GHOSTTY_RESOURCES_DIR'),
      $.env.get('TERM'),
      $.env.get('TERM_PROGRAM'),
      $.env.get('TMUX'),
    ])
    const named = /kitty|ghostty/i.test(`${term ?? ''} ${program ?? ''}`)
    detectedMode = !tmux && (kitty || ghostty || named) ? 'image' : 'blocks'
  }
  return detectedMode
}

/** Over ssh the terminal cannot open the session's files, so pictures travel inline. */
async function remoteSession($: Engine): Promise<boolean> {
  if (isRemote === undefined) {
    const [connection, tty] = await Promise.all([$.env.get('SSH_CONNECTION'), $.env.get('SSH_TTY')])
    isRemote = Boolean(connection || tty)
  }
  return isRemote
}

async function cacheOf($: Engine): Promise<string> {
  if (cacheDir === undefined) {
    const runtime = await $.env.get('XDG_RUNTIME_DIR')
    let dir: string
    if (runtime) {
      dir = `${runtime}/peek`
    } else {
      const temp = (await $.env.get('TMPDIR'))?.replace(/\/+$/, '') || '/tmp'
      dir = `${temp}/peek-${(await $.env.get('USER')) || 'user'}`
    }
    const made = await $.process.run(['mkdir', '-p', '-m', '700', dir])
    if (made.exitCode !== 0) throw new Error(`cannot make ${dir}: ${made.stderr.trim()}`)
    cacheDir = dir
  }
  return cacheDir
}

async function needBrowser($: Engine): Promise<string> {
  const found = await findBrowser($)
  if (found === null) {
    throw new Error('drawing pages takes Chrome, Chromium, Edge or Brave; none was found (set PEEK_BROWSER to one)')
  }
  return found
}

async function findBrowser($: Engine): Promise<string | null> {
  if (browser === undefined) {
    browser = null
    const own = await $.env.get('PEEK_BROWSER')
    for (const name of own ? [own, ...BROWSERS] : BROWSERS) {
      if (await runsWith($, [name, '--version'])) {
        browser = name
        break
      }
    }
  }
  return browser
}

async function findMagick($: Engine): Promise<readonly string[] | null> {
  if (magick === undefined) {
    magick = null
    for (const tool of [['magick'], ['convert']]) {
      if (await runsWith($, [...tool, '-version'], 'ImageMagick')) {
        magick = tool
        break
      }
    }
  }
  return magick
}

async function runsWith($: Engine, argv: string[], saying?: string): Promise<boolean> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: 10_000 })
    return ran.exitCode === 0 && (saying === undefined || ran.stdout.includes(saying))
  } catch {
    return false
  }
}

async function resolvePath($: Engine, asked: string): Promise<Found> {
  let path = asked.trim()
  if (/^file:\/\//i.test(path)) path = decodeURIComponent(path.replace(/^file:\/\/(localhost)?/i, ''))
  if (path === '~' || path.startsWith('~/')) {
    const home = await $.env.get('HOME')
    if (!home) throw new Error('HOME is not set')
    path = home + path.slice(1)
  }
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  if (stat === undefined || stat.kind === 'other') throw new Error(`no file at ${asked}`)
  if (stat.kind === 'dir') throw new Error(`${asked} is a folder`)
  const real = stat.realPath ?? (path.startsWith('/') ? path : undefined)
  if (real === undefined) throw new Error(`cannot tell where ${asked} is`)
  return { path: real, size: stat.size }
}

async function statOf($: Engine, path: string): Promise<Found> {
  const stat = await $.fs.stat(path)
  return { path, size: stat.size }
}

async function removeFile($: Engine, path: string): Promise<void> {
  await $.process.run(['rm', '-f', path])
}

/** `/peek` arguments: a path, quoted or not, and `--blocks`, `--image`, `--text` or `--live` anywhere. */
export function parseArgs(args: string): { path: string; mode?: PeekMode; view?: ViewKind } {
  let mode: PeekMode | undefined
  let view: ViewKind | undefined
  const rest = args.replace(/(^|\s)--(blocks|image|text|live)(?=\s|$)/g, (_, space: string, flag: PeekMode | ViewKind) => {
    if (flag === 'text' || flag === 'live') view = flag
    else mode = flag
    return space
  })
  let path = rest.trim()
  const quote = path[0]
  if (path.length >= 2 && (quote === '"' || quote === "'") && path.endsWith(quote)) path = path.slice(1, -1)
  const parsed: { path: string; mode?: PeekMode; view?: ViewKind } = { path }
  if (mode !== undefined) parsed.mode = mode
  if (view !== undefined) parsed.view = view
  return parsed
}

/** The page with a <base> naming its folder, so a copy elsewhere finds its files. */
export function withBase(html: string, folderUrl: string): string {
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(html)
  const at = doctype === null ? 0 : doctype[0].length
  return `${html.slice(0, at)}<base href="${escapeAttribute(folderUrl)}">${html.slice(at)}`
}

function pictureDocument(source: string, style: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;background:transparent}img{display:block}</style></head>' +
    `<body><img id="peek" alt="" src="${escapeAttribute(source)}" style="${style}"></body></html>`
  )
}

export function fileUrl(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

function directoryUrl(path: string): string {
  return fileUrl(path.slice(0, path.lastIndexOf('/') + 1))
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** FNV-1a: a short stable name for a path's cache files. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// The browser's last words, which say why it failed when it did.
function whyFrom(ran: ProcessRunResult): string {
  const last = ran.stderr.trim().split('\n').pop()?.trim()
  return last ? `: ${last.slice(0, 200)}` : ran.exitCode === 0 ? '' : ` (exit ${ran.exitCode})`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
