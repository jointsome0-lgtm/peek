
/** How a picture is drawn: its pixels (kitty, Ghostty) or colored half blocks (any terminal). */
export type PeekMode = 'image' | 'blocks'

/** One band of a tall page: a PNG of its own. */
export type PeekBand = { file: string; size: number; width: number; height: number }

/** A picture shown in a row of the chat. */
export type PeekPicture = {
  /** The file as it was asked for. */
  path: string
  /** Shown on the row's toggle: the title asked for, else the file's name. */
  title: string
  /** A page is drawn as wide as the chat and as tall as it is; a picture fits the screen. */
  kind: 'page' | 'picture'
  /** The PNG drawn: the file itself, or a snapshot or a conversion of it. */
  file: string
  /** Bytes in `file`. */
  size: number
  width: number
  height: number
  /** The mode `file` was made for: a snapshot made for blocks has few pixels. */
  madeFor: PeekMode
  /** A mode asked for with this picture, over the configured one. */
  mode?: PeekMode
  /** A smaller copy of `file` for blocks to decode, when `file` is too big. */
  small?: { file: string; size: number }
  /**
   * A tall page cut into bands of `file`, top to bottom, each short enough
   * for an Image to show at the chat's full width; absent without ImageMagick.
   */
  bands?: PeekBand[]
  /** What the picture leaves out, shown beside the title. */
  note?: string
  /** Counts up with every picture shown, so a redraw never reuses an old one. */
  generation: number
  /** PROTOTYPE (native-text): the page read as terminal text, for `/peek <page> --text` or `--live`. */
  text?: PeekText
  /** PROTOTYPE (live text): the page kept open in a headless Chrome, for `/peek <page> --live`. */
  live?: PeekLive
}

/** PROTOTYPE (native-text): one piece of a page shown as text: markdown, a figure by its index, or a row of text and controls. */
export type PeekPiece = { markdown: string } | { figure: number } | { row: PeekRowItem[] }

/** PROTOTYPE (native-text): a run of text: bold, italic, code, a link. */
export type PeekRun = { x: string; b?: 1; i?: 1; c?: 1; a?: string }

/** PROTOTYPE (live text): one item of a row: text, or a control by its index. */
export type PeekRowItem = { text: PeekRun[] } | { control: number }

/** PROTOTYPE (live text): a control of the page, drawn as the terminal's own. */
export type PeekControl = {
  /** The page's address for it: its data-peek-id. */
  id: string
  k: 'button' | 'check' | 'radio' | 'text' | 'select' | 'range'
  /** What it says. */
  l: string
  /** A field's text, the option picked, a slider's number. */
  v?: string
  /** Checked, selected or pressed. */
  on?: boolean
  /** Disabled. */
  off?: 1
  /** A select's options. */
  opts?: { v: string; l: string }[]
  /** A field's placeholder. */
  ph?: string
  min?: string
  max?: string
  step?: string
  /** A field of several lines, which Enter does not submit. */
  area?: 1
}

/** PROTOTYPE (live text): where a live page is open, and how to open it again. */
export type PeekLive = {
  /** The page's number in the helper, and the helper's socket: a reload starts a new helper. */
  page: string
  socket: string
  file: string
  width: number
  scale: number
  dir: string
  browser: string
}

/**
 * PROTOTYPE (index): the row whose page the band above the prompt indexes:
 * its key in `shown`, its render instance, and what the last press came to.
 */
export type PeekNav = { row: string; requestId: string; note?: string }

/** PROTOTYPE (native-text): a figure of the page, cut from a snapshot of it where that worked. */
export type PeekFigure = {
  /** What the page says the figure shows; drawn where the figure cannot be. */
  alt: string
  /** The figure's width over the page's: how much of the chat's width it takes. */
  share: number
  file?: string
  size?: number
  width?: number
  height?: number
}

/** PROTOTYPE (index): a heading under a section's own: its text, its level, the piece of the section it starts. */
export type PeekSub = { title: string; level: number; piece: number }

/** PROTOTYPE (native-text): the part of a page under one of its headings, and the headings under that one. */
export type PeekSection = { title: string; pieces: PeekPiece[]; subs?: PeekSub[] }

/** PROTOTYPE (index): a place in a page: a section, and a piece of it. */
export type PeekPlace = { section: number; piece: number }

/** PROTOTYPE (native-text): a page as text: what comes before its first heading, then its sections. */
export type PeekText = { intro: PeekPiece[]; sections: PeekSection[]; figures: PeekFigure[]; controls?: PeekControl[] }

/**
 * PROTOTYPE (native-text): how a row shows its text: the layout picked, open
 * sections, the tab shown, whether the text sits at the chat's left rather
 * than in its middle, where travel made the row start (what comes before
 * folds into one line); whether a press is under way and what the last one said.
 */
export type PeekView = {
  variant: number
  open: number[]
  tab: number
  left?: boolean
  start?: PeekPlace
  busy?: boolean
  error?: string
  notice?: string
}

declare module 'claude-code' {
  interface PluginState {
    peek: {
      /** The pictures of the latest rows, by row: `cmd:<args>` for /peek, `tool:<tool_use_id>` for the tool. */
      shown: Record<string, PeekPicture>
      /** Whether a row's picture is unfolded. */
      isOpen: StateFamily<boolean>
      /** PROTOTYPE (native-text): how each row shows a page as text. */
      view: StateFamily<PeekView>
      /** PROTOTYPE (index): the row whose page the band above the prompt indexes, while it is unfolded. */
      nav: PeekNav | null
    }
  }
}
