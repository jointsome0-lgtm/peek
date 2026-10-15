# peek: design notes

The working memory of this project. Read it first on a new machine: decisions,
open questions and what was learned about the engine live here, not in any
one computer's Claude memory.

## Goal

See pictures and HTML pages without leaving the terminal during Claude Code
sessions. End goal: a page in the terminal with everything a page can do,
used interactively.

## Status (2026-10-15, v0.2)

- `/peek <file> [--blocks|--image]` and the `mcp__peek__show` tool the model calls.
- PNG, JPEG, WebP, GIF, BMP, SVG and HTML. HTML is a headless Chrome snapshot,
  laid out as wide as the chat.
- Each picture is a row in the chat, folded: `▸ title · facts`. A click unfolds it.
- kitty and Ghostty draw full color; other terminals draw colored half blocks.
- Tall pages are cut into bands with ImageMagick so they fill the chat's width;
  anything narrower than the chat is centered.
- Not yet tried live: the bands and centering.

## Decisions

- 2026-10-15: inline rows in the chat, not a side pane. The owner wants the
  page to appear in the main flow as a toggle that unfolds (v0.1 was a pane).
- 2026-10-15: public repository, MIT licence.

## Open questions for the owner

1. **Where pictures show.** Later, a setting: `inline` (a row in the chat) or
   `pane` (a separate panel). The pane code is in v0.1's history.
2. **"Dual" artifacts.** A snapshot reads as "one big picture": no text
   selection, no clicks. Three roads:
   - A. Snapshot only (today). Exact look; nothing else.
   - B. Terminal-native view: the same content as HTML for the browser and
     as terminal elements (headings, text, tables, buttons) in the chat;
     charts stay pictures. Real text that reflows and clicks; loses the
     page's visual design. Works best when artifacts have a simple structure.
   - C. Live browser: Chrome in the background streams frames, clicks go to
     it. Exact look and interactive; heaviest, and unproven (see below).

   Recommendation: B first, C later for pages whose look matters. Not yet
   decided by the owner.

## Roadmap

1. Live-check v0.2 (bands, centering, folding) in kitty.
2. Settle the open questions above.
3. Interactivity: B or C.

## What the engine allows (Claude Code 2.1.300)

- `Image` draws pixels only in kitty and Ghostty. It is at most 255 × 255
  cells and cannot crop its source, hence the bands.
- `Raster` (half blocks) paints at most 1024 distinct color pairs at once;
  peek cuts colors with a median cut.
- `$.ui.blit` swaps a keyed Image up to about 60 fps: the base for road C.
- A `Client` region gets pointer events with sub-cell positions (no wheel)
  and keys after a click, but cannot draw an `Image`. Whether a Client laid
  over an Image works is the open question for road C.
- `$.fs.write` writes text only, so new PNGs come from Chrome or ImageMagick.
- A row's own state is a `StateFamily` keyed by the row (`memberOf(atom, e)`).
  The types contract may not `import`; `StateFamily` is used bare inside
  `declare module 'claude-code'`.
- The engine prefixes a command's text with `peek: ` itself.

## Pages

Measure pages in the DOM (`--dump-dom` with an injected script that reports
the size), not by pixels: patterned backgrounds defeat pixel measuring.
Headless Chrome runs fine beside an open Chrome.

## Developing

```
claude --plugin-dir /path/to/peek
```

Saves during a turn reload the mod when the turn ends. If a command stays
unknown after edits (a module that failed its first load is not picked up
again), restart the session with `--plugin-dir`.

Checks:

```
claude plugin validate /path/to/peek
claude plugin test /path/to/peek
tsc -p /path/to/peek    # once the engine has written .claude-plugin/types/
```
