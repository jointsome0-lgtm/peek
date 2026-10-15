
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
}

declare module 'claude-code' {
  interface PluginState {
    peek: {
      /** The pictures of the latest rows, by row: `cmd:<args>` for /peek, `tool:<tool_use_id>` for the tool. */
      shown: Record<string, PeekPicture>
      /** Whether a row's picture is unfolded. */
      isOpen: StateFamily<boolean>
    }
  }
}
