// PROTOTYPE (native-text branch, throwaway): peek's side of the live text
// view. A helper, prototype/live-bridge.mjs, keeps pages open in one headless
// Chrome; peek starts it the first time a page goes live and talks to it over
// a Unix socket in its cache folder. A reload of the mod ends the helper and
// its pages: a press on an older row opens that page again, from the start.

import type { EngineInterface } from 'claude-code'

import type { PeekLive, PeekText } from '../types'
import { LIVE_READ, textOf, type Extracted, type LiveAction } from './prototype-text'

type Engine = EngineInterface
type Shot = { file: string; size: number; width: number; height: number }
type Read = Extracted & { shots?: Record<string, Shot> }
type Bridge = { socket: string; ready: Promise<void>; alive: boolean }

/** A live page as the row keeps it: its text, its size, where it is open. */
export type LivePage = { text: PeekText; size: [number, number]; live: PeekLive }
/** What opening a page takes. */
export type LiveOpen = Omit<PeekLive, 'page' | 'socket'>

// The helper of this module load; a reload starts over without one.
let bridge: Bridge | undefined

class BridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** The running helper, started when there is none. */
async function helperFor($: Engine, browser: string, dir: string): Promise<Bridge> {
  const running = bridge
  if (running?.alive === true) {
    await running.ready
    return running
  }
  const node = await $.process.run(['node', '-e', 'process.exit(typeof WebSocket === "function" ? 0 : 3)']).catch(() => undefined)
  if (node?.exitCode !== 0) throw new Error('the live view takes Node 22 or newer, as `node` on the PATH')

  const socket = `${dir}/live-${Math.random().toString(36).slice(2, 10)}.sock`
  let started = () => {}
  let failed = (_: Error) => {}
  const ready = new Promise<void>((resolve, reject) => {
    started = resolve
    failed = reject
  })
  const state: Bridge = { socket, ready, alive: true }
  bridge = state
  // The loop is the helper's life: it runs on after this hook returns.
  void (async () => {
    let said = ''
    let how = ''
    try {
      const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/prototype/live-bridge.mjs`, socket, browser] })
      for (;;) {
        const step = await child.next()
        if (step.done === true) {
          how = step.value.signal ?? `code ${step.value.code}`
          break
        }
        if (step.value.stream === 'stdout' && step.value.text.includes('ready')) started()
        else if (step.value.stream === 'stderr') said = (said + step.value.text).slice(-600)
      }
    } catch (error) {
      how = error instanceof Error ? error.message : String(error)
    } finally {
      state.alive = false
      if (bridge === state) bridge = undefined
      failed(new Error(`the live helper stopped (${how})${said.trim() === '' ? '' : `: ${said.trim()}`}`))
    }
  })()
  await ready
  return state
}

async function call<T>($: Engine, socket: string, path: string, body: unknown): Promise<T> {
  const response = await $.http.fetch(`http://peek${path}`, {
    method: 'POST',
    socketPath: socket,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let out: unknown
  try {
    out = JSON.parse(response.text)
  } catch {
    throw new BridgeError(`the live helper answered ${response.status}: ${response.text.slice(0, 200)}`, response.status)
  }
  if (!response.ok) {
    const error = (out as { error?: unknown } | null)?.error
    throw new BridgeError(typeof error === 'string' ? error : `the live helper answered ${response.status}`, response.status)
  }
  return out as T
}

/** The page as text, each figure given the PNG the helper cut for its box. */
function pageOf(data: Read, width: number): { text: PeekText; size: [number, number] } {
  const { text, boxes } = textOf(data, width)
  for (const [at, box] of boxes.entries()) {
    const shot = data.shots?.[`${box.x},${box.y},${box.w},${box.h}`]
    const figure = text.figures[at]
    if (shot !== undefined && figure !== undefined) Object.assign(figure, shot)
  }
  return { text, size: data.size }
}

/** Opens the page in the helper's Chrome, starting the helper if need be, and reads it. */
export async function openLive($: Engine, open: LiveOpen): Promise<LivePage> {
  const helper = await helperFor($, open.browser, open.dir)
  const out = await call<{ page: string; data: Read }>($, helper.socket, '/open', {
    file: open.file,
    width: open.width,
    scale: open.scale,
    read: LIVE_READ,
    dir: open.dir,
  })
  return { ...pageOf(out.data, open.width), live: { ...open, page: out.page, socket: helper.socket } }
}

/**
 * Does in the live page what a press asks and reads the page again. A page
 * whose helper is gone (peek reloaded, Chrome stopped) is opened again from
 * the start and the press is not repeated; the note says so.
 */
export async function actLive($: Engine, live: PeekLive, action: LiveAction): Promise<LivePage & { notice?: string }> {
  const helper = bridge
  if (helper?.alive === true && helper.socket === live.socket) {
    try {
      const out = await call<{ data: Read }>($, helper.socket, action.kind === 'read' ? '/read' : '/act', { page: live.page, ...action })
      return { ...pageOf(out.data, live.width), live }
    } catch (error) {
      if (error instanceof BridgeError && error.status === 409) {
        const out = await call<{ data: Read }>($, helper.socket, '/read', { page: live.page })
        return { ...pageOf(out.data, live.width), live, notice: 'That control was gone: the page had changed. Here it is again.' }
      }
      if (error instanceof BridgeError && error.status !== 410) throw error
    }
  }
  const { page: _page, socket: _socket, ...open } = live
  const opened = await openLive($, open)
  return { ...opened, notice: 'The page was opened again from the start, as its helper had stopped: press again.' }
}

/** Closes a live page no row shows any more; nothing to do once its helper is gone. */
export function closeLive($: Engine, live: PeekLive): void {
  const helper = bridge
  if (helper?.alive !== true || helper.socket !== live.socket) return
  call($, helper.socket, '/close', { page: live.page }).catch(() => {})
}
