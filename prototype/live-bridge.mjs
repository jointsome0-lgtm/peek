// PROTOTYPE (native-text branch, throwaway): the helper behind peek's live
// text view. It keeps pages open in one headless Chrome and answers peek over
// a Unix socket, so a press in the chat reaches the page and its scripts run.
//
//   node live-bridge.mjs <socket> <browser>
//
//   POST /open  {file, width, scale, read, dir} -> {page, data}
//   POST /act   {page, control, kind, value?}   -> {data}
//   POST /read  {page}                          -> {data}
//   POST /close {page}                          -> {}
//
// `read` is peek's page reader, an expression evaluated in the page; `data` is
// what it returns plus `shots`, each figure cut out as a PNG in `dir`, keyed by
// its box. Prints "ready" once it listens; ends its Chrome when it ends.

import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [socketPath, browser] = process.argv.slice(2)
if (!socketPath || !browser) {
  console.error('usage: node live-bridge.mjs <socket> <browser>')
  process.exit(2)
}

const VIEW_HEIGHT = 900
const MAX_HEIGHT = 8000
const LOAD_MS = 15_000
const START_MS = 20_000
const CALL_MS = 45_000
const pidFile = `${socketPath}.pids`

/** The running browser: its process, its DevTools socket and what waits on it. */
let chrome
let starting
const pages = new Map()
let opened = 0

// Resolves once the page has been quiet for 150 ms (1.5 s at most), then
// two frames, so what its scripts do in answer to a press is drawn.
const SETTLE = String.raw`new Promise(done => {
  const start = performance.now();
  let timer = 0;
  const frame = f => { let ran = false; const once = () => { if (!ran) { ran = true; f(); } }; requestAnimationFrame(once); setTimeout(once, 50); };
  const finish = () => { observer.disconnect(); frame(() => frame(() => done(true))); };
  const quiet = () => { clearTimeout(timer); timer = setTimeout(finish, performance.now() - start > 1500 ? 0 : 150); };
  const observer = new MutationObserver(quiet);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  quiet();
})`

function fail(message, status = 500) {
  return Object.assign(new Error(message), { status })
}

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A helper killed outright leaves its Chrome behind: end those first.
function endStale(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (!name.endsWith('.sock.pids') || path === pidFile) continue
    try {
      const [helper, browserPid] = readFileSync(path, 'utf8').trim().split(' ').map(Number)
      if (alive(helper)) continue
      if (browserPid && alive(browserPid) && readFileSync(`/proc/${browserPid}/cmdline`, 'utf8').includes('peek-live-')) {
        process.kill(browserPid, 'SIGTERM')
      }
      rmSync(path, { force: true })
    } catch {}
  }
}

async function startChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'peek-live-'))
  const proc = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--disable-extensions',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const url = await new Promise((resolve, reject) => {
    let said = ''
    const timer = setTimeout(() => reject(fail('Chrome did not start in 20 s')), START_MS)
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', chunk => {
      said += chunk
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(said)
      if (found) {
        clearTimeout(timer)
        resolve(found[1])
      }
    })
    proc.once('error', error => {
      clearTimeout(timer)
      reject(fail(`cannot start ${browser}: ${error.message}`))
    })
    proc.once('exit', code => {
      clearTimeout(timer)
      reject(fail(`Chrome stopped (${code}): ${said.trim().slice(-300)}`))
    })
  })
  writeFileSync(pidFile, `${process.pid} ${proc.pid}\n`)

  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(fail('cannot reach Chrome')), { once: true })
  })
  const state = { proc, ws, profile, nextId: 0, pending: new Map(), listeners: new Set() }
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id === undefined) {
      for (const listener of state.listeners) listener(message)
      return
    }
    const waiting = state.pending.get(message.id)
    if (waiting === undefined) return
    state.pending.delete(message.id)
    if (message.error) waiting.reject(fail(`${waiting.method}: ${message.error.message}`))
    else waiting.resolve(message.result)
  })
  const gone = () => {
    for (const waiting of state.pending.values()) waiting.reject(fail('Chrome went away', 410))
    state.pending.clear()
    if (chrome === state) {
      chrome = undefined
      pages.clear()
    }
  }
  ws.addEventListener('close', gone)
  proc.once('exit', () => {
    gone()
    rmSync(profile, { recursive: true, force: true })
  })
  return state
}

async function browserReady() {
  if (chrome) return chrome
  starting ??= startChrome().finally(() => {
    starting = undefined
  })
  chrome = await starting
  return chrome
}

function send(method, params = {}, sessionId) {
  const state = chrome
  if (!state) return Promise.reject(fail('Chrome is not running', 410))
  const id = ++state.nextId
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject, method })
    state.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
  })
}

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true, includeCommandLineAPI: true },
    page.session,
  )
  if (exceptionDetails) {
    const said = exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'an error'
    throw fail(`the page threw: ${String(said).split('\n')[0]}`)
  }
  return result?.value
}

async function waitUntil(test, ms) {
  for (let waited = 0; waited < ms && !test(); waited += 50) await sleep(50)
}

// The page as tall as the window, up to MAX_HEIGHT, so every box the reader
// reports is in the window and the figures can be cut without scrolling.
async function fit(page) {
  const height = await evaluate(
    page,
    'Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))',
  )
  const want = Math.min(MAX_HEIGHT, Math.max(VIEW_HEIGHT, Number(height) || VIEW_HEIGHT))
  if (want === page.height) return
  page.height = want
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width: page.width, height: want, deviceScaleFactor: page.scale, mobile: false },
    page.session,
  )
  await evaluate(page, SETTLE)
}

function figuresOf(blocks, out = []) {
  for (const block of blocks ?? []) {
    if (block.t === 'fig') out.push(block)
    else if (block.t === 'ul' || block.t === 'ol') for (const item of block.items) figuresOf(item, out)
    else if (block.t === 'quote' || block.t === 'details') figuresOf(block.b, out)
  }
  return out
}

async function readOnce(page) {
  await fit(page)
  await evaluate(page, 'window.scrollTo(0, 0)')
  const data = await evaluate(page, page.read)
  if (!data || !Array.isArray(data.blocks)) throw fail('the page reader returned nothing')
  return data
}

async function readPage(page) {
  let data = await readOnce(page)
  // Reading opens closed <details>, which can make the page taller than the window.
  if (page.height < MAX_HEIGHT && Array.isArray(data.size) && data.size[1] > page.height + 1) data = await readOnce(page)
  const read = ++page.reads
  const shots = {}
  const made = []
  for (const box of figuresOf(data.blocks)) {
    const key = `${box.x},${box.y},${box.w},${box.h}`
    if (key in shots || box.w < 1 || box.h < 1 || box.y + box.h > page.height) continue
    const { data: png } = await send(
      'Page.captureScreenshot',
      { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } },
      page.session,
    )
    const bytes = Buffer.from(png, 'base64')
    const file = join(page.dir, `live-${process.pid}-${page.id}-${read}-${made.length}.png`)
    writeFileSync(file, bytes)
    made.push(file)
    shots[key] = { file, size: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  // The files of this read and the one before stay: a row may still show those.
  page.files.push(made)
  while (page.files.length > 2) for (const file of page.files.shift()) rmSync(file, { force: true })
  data.shots = shots
  return data
}

async function open({ file, width, scale, read, dir }) {
  if (typeof file !== 'string' || typeof read !== 'string' || typeof dir !== 'string') throw fail('open takes file, read and dir', 400)
  await browserReady()
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const page = {
    id: String(++opened),
    target: targetId,
    session: sessionId,
    width: Math.round(Number(width) || 1000),
    scale: Number(scale) || 1,
    height: VIEW_HEIGHT,
    read,
    dir,
    reads: 0,
    files: [],
    queue: Promise.resolve(),
  }
  await send('Page.enable', {}, sessionId)
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width: page.width, height: VIEW_HEIGHT, deviceScaleFactor: page.scale, mobile: false },
    sessionId,
  )
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
  let loaded = false
  const listener = message => {
    if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') loaded = true
  }
  chrome.listeners.add(listener)
  try {
    const { errorText } = await send('Page.navigate', { url: pathToFileURL(file).href }, sessionId)
    if (errorText) throw fail(`Chrome could not open the page: ${errorText}`)
    await waitUntil(() => loaded, LOAD_MS)
  } finally {
    chrome?.listeners.delete(listener)
  }
  await evaluate(page, SETTLE)
  pages.set(page.id, page)
  return { page: page.id, data: await readPage(page) }
}

async function mouse(page, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, page.session)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, page.session)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, page.session)
}

async function enter(page) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r', unmodifiedText: '\r' }, page.session)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, page.session)
}

async function act(page, { control, kind, value }) {
  if (!/^\d+$/.test(String(control))) throw fail('a control is named by its number', 400)
  const element = `document.querySelector('[data-peek-id="${control}"]')`
  const gone = () => fail('that control is gone from the page; it was redrawn', 409)

  // A press may leave the page: wait for the next one to load before reading.
  const seen = { navigated: false, loaded: false }
  const listener = message => {
    if (message.sessionId !== page.session) return
    if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) seen.navigated = true
    if (message.method === 'Page.loadEventFired') seen.loaded = true
  }
  chrome.listeners.add(listener)
  try {
    if (kind === 'click') {
      const at = await evaluate(
        page,
        String.raw`(() => {
          const el = ${element};
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const hit = r.width > 0 && r.height > 0 ? document.elementFromPoint(x, y) : null;
          const labels = el.labels ? [...el.labels] : [];
          const hits = !!hit && (hit === el || el.contains(hit) || labels.some(l => l === hit || l.contains(hit)));
          return { x, y, hits };
        })()`,
      )
      if (at === null || at === undefined) throw gone()
      if (at.hits) await mouse(page, at.x, at.y)
      else await evaluate(page, `${element}.click()`)
    } else if (kind === 'text' || kind === 'select' || kind === 'range') {
      const text = JSON.stringify(String(value ?? ''))
      const tag = await evaluate(
        page,
        String.raw`(() => {
          const el = ${element};
          if (!el) return null;
          el.focus();
          const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
          if (own && own.set) own.set.call(el, ${text}); else el.value = ${text};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return el.localName;
        })()`,
      )
      if (tag === null || tag === undefined) throw gone()
      if (kind === 'text' && tag === 'input') await enter(page)
    } else {
      throw fail(`no such action: ${kind}`, 400)
    }
    await sleep(120)
    if (seen.navigated) await waitUntil(() => seen.loaded, LOAD_MS)
  } finally {
    chrome?.listeners.delete(listener)
  }
  try {
    await evaluate(page, SETTLE)
  } catch {
    await sleep(300)
    await evaluate(page, SETTLE)
  }
  return readPage(page)
}

async function close(page) {
  pages.delete(page.id)
  for (const list of page.files) for (const file of list) rmSync(file, { force: true })
  await send('Target.closeTarget', { targetId: page.target }).catch(() => {})
  return {}
}

// A call that outlasts CALL_MS is answered with an error; a page stuck in its
// own script keeps the calls queued behind it waiting no longer than that.
function timed(work, what) {
  let timer
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(fail(`${what} took over ${CALL_MS / 1000} s`, 504)), CALL_MS)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

function queued(page, work) {
  const run = page.queue.then(() => timed(work(), 'the page'))
  page.queue = run.catch(() => {})
  return run
}

async function route(url, input) {
  if (url === '/ping') return { ok: true }
  if (url === '/open') return timed(open(input), 'opening the page')
  const page = pages.get(String(input.page))
  if (page === undefined) throw fail('that page is no longer open', 410)
  if (url === '/act') return queued(page, async () => ({ data: await act(page, input) }))
  if (url === '/read') return queued(page, async () => ({ data: await readPage(page) }))
  if (url === '/close') return queued(page, () => close(page))
  throw fail(`no such call: ${url}`, 404)
}

const server = createServer((request, response) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => {
    body += chunk
  })
  request.on('end', async () => {
    let status = 200
    let out
    try {
      out = await route(request.url, body ? JSON.parse(body) : {})
    } catch (error) {
      status = error?.status ?? 500
      out = { error: String(error?.message ?? error) }
    }
    const text = JSON.stringify(out)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    response.end(text)
  })
})

let ending = false
async function end() {
  if (ending) return
  ending = true
  server.close()
  for (const page of pages.values()) for (const list of page.files) for (const file of list) rmSync(file, { force: true })
  const running = chrome?.proc
  if (running && running.exitCode === null) {
    running.kill('SIGTERM')
    await Promise.race([new Promise(resolve => running.once('exit', resolve)), sleep(2000)])
  }
  for (const path of [socketPath, pidFile]) {
    try {
      unlinkSync(path)
    } catch {}
  }
  process.exit(0)
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, end)
const parent = process.ppid
setInterval(() => {
  if (process.ppid !== parent) void end()
}, 2000).unref()

try {
  unlinkSync(socketPath)
} catch {}
try {
  endStale(dirname(socketPath))
} catch {}
server.listen(socketPath, () => {
  process.stdout.write('ready\n')
})
