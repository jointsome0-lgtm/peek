
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
  /** PROTOTYPE (native-text): the page read as terminal text, for `/peek <page> --text`. */
  text?: PeekText
}

/** PROTOTYPE (native-text): one piece of a page shown as text: markdown, or a figure by its index. */
export type PeekPiece = { markdown: string } | { figure: number }

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

/** PROTOTYPE (native-text): the part of a page under one of its headings. */
export type PeekSection = { title: string; pieces: PeekPiece[] }

/** PROTOTYPE (native-text): a page as text: what comes before its first heading, then its sections. */
export type PeekText = { intro: PeekPiece[]; sections: PeekSection[]; figures: PeekFigure[] }

/** PROTOTYPE (native-text): how a row shows its text: the layout picked, open sections, the tab shown. */
export type PeekView = { variant: number; open: number[]; tab: number }

declare module 'claude-code' {
  interface PluginState {
    peek: {
      /** The pictures of the latest rows, by row: `cmd:<args>` for /peek, `tool:<tool_use_id>` for the tool. */
      shown: Record<string, PeekPicture>
      /** Whether a row's picture is unfolded. */
      isOpen: StateFamily<boolean>
      /** PROTOTYPE (native-text): how each row shows a page as text. */
      view: StateFamily<PeekView>
    }
  }
}
