# peek

A Claude Code mod that shows pictures and HTML pages right in the chat, so you
don't have to leave the terminal.

Each picture appears as a folded row: `▸ chart.png · 1200×800 · picture`.
Click it to unfold it.

- **kitty, Ghostty:** full color.
- **Other terminals:** colored half blocks, blurry but readable.
- **HTML pages:** drawn by headless Chrome as a snapshot as wide as the chat.

## Install

At the prompt of a Claude Code session:

```
/plugin install peek --marketplace jointsome0-lgtm/peek
```

From a shell:

```
claude plugin install peek --marketplace jointsome0-lgtm/peek
```

## Use

```
/peek path/to/picture.png
/peek page.html
/peek page.html --blocks
```

`--blocks` forces half blocks and `--image` forces full color. The default
mode is set in `/config` (`auto`, `image` or `blocks`).

Claude can show you things too, through the `show` tool.

## Needs

- Chrome or Chromium for HTML and SVG.
- ImageMagick (optional) for other formats and to fit tall pages to the
  chat's full width.

## Licence

MIT. See [LICENSE](LICENSE). Design notes are in [DESIGN.md](DESIGN.md).
