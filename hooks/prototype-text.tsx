// PROTOTYPE (native-text branch, throwaway). A page shown in the chat as real
// terminal text instead of one big picture: headings, paragraphs, lists,
// tables and code drawn by the engine's Markdown element, figures cut from a
// snapshot of the page.
//
// Question: does a page read well in the chat as text, and which layout feels
// right: Outline (folded sections), Document (all of it) or Tabs (one section
// at a time)?
//
// Run: /peek <page.html> --text, unfold the row, flip layouts with ◂ and ▸.
// This file never merges; the decision lands on main, rewritten with tests.

import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'

import type { PeekFigure, PeekPicture, PeekPiece, PeekText, PeekView } from '../types'
import { fromBase64 } from './base64'
import { fitCells } from './picture'

const VARIANTS = ['Outline', 'Document', 'Tabs'] as const
const viewAtom = atom({ plugin: 'peek', key: 'view' } as const, { variant: 0, open: [0], tab: 0 })
const MAX_IMAGE = 255
const LINKABLE = /^(https?|file):/i

type Run = { x: string; b?: 1; i?: 1; c?: 1; a?: string }
export type FigureBox = { x: number; y: number; w: number; h: number }
type Block =
  | { t: 'p'; r: Run[] }
  | { t: 'h'; l: number; r: Run[] }
  | { t: 'pre'; x: string; lang?: string }
  | { t: 'ul'; items: Block[][] }
  | { t: 'ol'; start: number; items: Block[][] }
  | { t: 'table'; head: number; rows: Run[][][] }
  | { t: 'hr' }
  | { t: 'quote'; b: Block[] }
  | { t: 'details'; s: Run[]; b: Block[]; open: boolean }
  | ({ t: 'fig'; alt: string } & FigureBox)
type Extracted = { title: string; size: [number, number]; blocks: Block[] }

// Runs in the page once it has loaded, and again late in the browser's time
// budget: walks the DOM into blocks of styled runs and puts them, as base64
// of ASCII JSON, in data-peek-text on the root, which --dump-dom prints first.
export const EXTRACT_SCRIPT =
  '<script>' +
  String.raw`(() => {
  const PHRASING = new Set('A ABBR B BDI BDO BIG BR BUTTON CITE CODE DATA DEL DFN EM FONT I IMG INPUT INS KBD LABEL MARK METER NOBR OUTPUT PROGRESS Q S SAMP SELECT SMALL SPAN STRIKE STRONG SUB SUP SVG TEXTAREA TIME TT U VAR WBR'.split(' '));
  const SKIP = new Set('SCRIPT STYLE NOSCRIPT TEMPLATE HEAD META LINK TITLE BASE DATALIST'.split(' '));
  const FIGURES = new Set('IMG SVG CANVAS VIDEO PICTURE IFRAME OBJECT EMBED'.split(' '));
  const BLOCKS = 'address,article,aside,blockquote,details,dialog,div,dl,fieldset,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,ul';
  const MONO = /mono|courier|consol|menlo|monaco/i;
  const MIN_FIGURE = 48;
  const tagOf = n => n.localName.toUpperCase();
  const css = n => getComputedStyle(n);
  const isHidden = (n, s) => s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || s.opacity === '0' || n.getAttribute('aria-hidden') === 'true';
  const isFigure = n => FIGURES.has(tagOf(n)) || n.getAttribute('role') === 'img';
  const isPhrasing = n => PHRASING.has(tagOf(n)) && !n.querySelector(BLOCKS);
  const altOf = n => {
    const title = n.querySelector('title');
    return (n.getAttribute('aria-label') || n.getAttribute('alt') || n.getAttribute('title') || (title ? title.textContent : '') || '').replace(/\s+/g, ' ').trim();
  };
  const figureOf = n => {
    const r = n.getBoundingClientRect();
    return { t: 'fig', alt: altOf(n), x: Math.max(0, Math.floor(r.left + scrollX)), y: Math.max(0, Math.floor(r.top + scrollY)), w: Math.ceil(r.width), h: Math.ceil(r.height) };
  };
  const formatOf = (n, s, base, f) => {
    const tag = tagOf(n);
    const g = Object.assign({}, f);
    const weight = parseInt(s.fontWeight, 10) || 400;
    const baseWeight = parseInt(base.fontWeight, 10) || 400;
    if (tag === 'B' || tag === 'STRONG' || (weight >= 600 && baseWeight < 600)) g.b = 1;
    if (tag === 'I' || tag === 'EM' || tag === 'CITE' || tag === 'DFN' || (s.fontStyle === 'italic' && base.fontStyle !== 'italic')) g.i = 1;
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT' || (MONO.test(s.fontFamily) && !MONO.test(base.fontFamily))) g.c = 1;
    if (tag === 'A') {
      const href = n.getAttribute('href');
      if (href && href[0] !== '#' && typeof n.href === 'string') g.a = n.href;
    }
    return g;
  };
  const Runs = joiner => ({ list: [], sep: '', joiner });
  const sameFormat = (a, f) => a.b === f.b && a.i === f.i && a.c === f.c && a.a === f.a;
  const pushText = (runs, text, f) => {
    if (!text) return;
    const list = runs.list;
    if (runs.sep) {
      if (!text.trim()) return;
      const sep = runs.sep;
      runs.sep = '';
      if (list.some(r => r.x !== undefined && r.x.trim())) {
        const last = list[list.length - 1];
        if (sep === 'joiner') {
          if (last.x !== undefined) last.x = last.x.replace(/\s+$/, '');
          list.push({ x: runs.joiner });
          text = text.replace(/^\s+/, '');
        } else if (last.x !== undefined && !/\s$/.test(last.x) && !/^\s/.test(text)) {
          list.push({ x: ' ' });
        }
      }
    }
    const last = list[list.length - 1];
    if (last && last.x !== undefined && sameFormat(last, f)) last.x += text;
    else list.push(Object.assign({ x: text }, f));
  };
  const inlineNodes = (nodes, runs, f, base) => {
    for (const n of nodes) {
      if (n.nodeType === 3) {
        const ws = n.parentElement ? css(n.parentElement).whiteSpace : 'normal';
        const keep = /^pre/.test(ws) || ws === 'break-spaces';
        pushText(runs, keep ? n.data.replace(/\t/g, '    ') : n.data.replace(/\s+/g, ' '), f);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = tagOf(n);
      if (SKIP.has(tag)) continue;
      const s = css(n);
      if (s.display === 'contents') { inlineNodes(n.childNodes, runs, formatOf(n, s, base, f), base); continue; }
      if (isHidden(n, s)) continue;
      if (tag === 'BR') { pushText(runs, '\n', f); continue; }
      if (isFigure(n)) {
        const fig = figureOf(n);
        if (fig.w >= MIN_FIGURE && fig.h >= MIN_FIGURE) runs.list.push({ fig });
        else if (fig.alt) pushText(runs, fig.alt, f);
        continue;
      }
      // A laid-out item (a grid or flex cell) is set apart: a long one, a
      // description, by the joiner; a short one, a label, by a space.
      const isInline = s.display.startsWith('inline') || s.display === 'ruby';
      if (!isInline) runs.sep = n.textContent.trim().split(/\s+/).length >= 4 ? 'joiner' : 'space';
      inlineNodes(n.childNodes, runs, formatOf(n, s, base, f), base);
      if (!isInline && !runs.sep) runs.sep = 'space';
    }
  };
  const tidy = list => {
    const out = [];
    for (const r of list) {
      const last = out[out.length - 1];
      if (last && sameFormat(last, r)) last.x += r.x;
      else out.push(Object.assign({}, r));
    }
    for (let k = 1; k < out.length; k++) {
      if (/\s$/.test(out[k - 1].x) && /^ /.test(out[k].x)) out[k].x = out[k].x.replace(/^ +/, '');
    }
    for (const r of out) r.x = r.x.replace(/ *\n */g, '\n');
    while (out.length && !out[0].x.trim()) out.shift();
    while (out.length && !out[out.length - 1].x.trim()) out.pop();
    if (out.length) {
      out[0].x = out[0].x.replace(/^\s+/, '');
      const last = out[out.length - 1];
      last.x = last.x.replace(/\s+$/, '');
    }
    return out;
  };
  const emit = (runs, out) => {
    let segment = [];
    const flush = () => {
      const r = tidy(segment);
      if (r.length) out.push({ t: 'p', r });
      segment = [];
    };
    for (const r of runs.list) {
      if (r.fig) { flush(); out.push(r.fig); } else segment.push(r);
    }
    flush();
  };
  const runsOf = (n, joiner) => {
    const runs = Runs(joiner);
    inlineNodes(n.childNodes, runs, {}, css(n));
    const flat = [];
    for (const r of runs.list) {
      if (!r.fig) flat.push(r);
      else if (r.fig.alt) flat.push({ x: ' ' + r.fig.alt + ' ' });
    }
    return tidy(flat);
  };
  const clear = c => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const backgroundOf = n => {
    for (let e = n; e; e = e.parentElement) {
      const c = css(e).backgroundColor;
      if (!clear(c)) return c;
    }
    return '';
  };
  const isCallout = (n, s) => {
    if (n.querySelector('h1,h2,h3,h4,section,article,table') || !n.textContent.trim()) return false;
    const border = parseFloat(s.borderLeftWidth) >= 2 && s.borderLeftStyle !== 'none' && !clear(s.borderLeftColor);
    const filled = !clear(s.backgroundColor) && s.backgroundColor !== backgroundOf(n.parentElement);
    return border || filled;
  };
  const blocksOf = (nodes, out, base) => {
    const kids = [...nodes].filter(n => n.nodeType === 3 || (n.nodeType === 1 && !SKIP.has(tagOf(n))));
    let runs = Runs(' — ');
    const flush = () => { emit(runs, out); runs = Runs(' — '); };
    if (kids.every(n => n.nodeType === 3 || isPhrasing(n))) {
      inlineNodes(kids, runs, {}, base);
      flush();
      return;
    }
    for (const n of kids) {
      if (n.nodeType === 3) { pushText(runs, n.data.replace(/\s+/g, ' '), {}); continue; }
      const s = css(n);
      if (s.display === 'contents') { flush(); blocksOf(n.childNodes, out, base); continue; }
      if (isHidden(n, s)) continue;
      if (isFigure(n)) {
        const fig = figureOf(n);
        if (fig.w >= MIN_FIGURE && fig.h >= MIN_FIGURE) { flush(); out.push(fig); } else if (fig.alt) pushText(runs, fig.alt, {});
        continue;
      }
      if (isPhrasing(n)) {
        if (s.display.startsWith('inline')) inlineNodes([n], runs, {}, base);
        else {
          flush();
          const own = Runs(' — ');
          inlineNodes(n.childNodes, own, {}, s);
          emit(own, out);
        }
        continue;
      }
      flush();
      blockOf(n, s, out);
    }
    flush();
  };
  const blockOf = (n, s, out) => {
    const tag = tagOf(n);
    if (/^H[1-6]$/.test(tag) || n.getAttribute('role') === 'heading') {
      const l = /^H[1-6]$/.test(tag) ? Number(tag[1]) : Number(n.getAttribute('aria-level')) || 2;
      const r = runsOf(n, ' ');
      if (r.length) out.push({ t: 'h', l, r });
      return;
    }
    if (tag === 'PRE') {
      const code = n.querySelector('code');
      const lang = /(?:^|\s)lang(?:uage)?-([\w+#-]+)/.exec(n.className + ' ' + (code ? code.className : ''));
      const x = n.textContent.replace(/^\n/, '').replace(/\s+$/, '');
      if (x.trim()) out.push(lang ? { t: 'pre', x, lang: lang[1] } : { t: 'pre', x });
      return;
    }
    if (tag === 'UL' || tag === 'OL' || tag === 'MENU') {
      const items = [];
      for (const li of n.children) {
        const ls = css(li);
        if (tagOf(li) !== 'LI' || isHidden(li, ls)) continue;
        const b = [];
        blocksOf(li.childNodes, b, ls);
        if (b.length) items.push(b);
      }
      if (items.length) out.push(tag === 'OL' ? { t: 'ol', start: n.start || 1, items } : { t: 'ul', items });
      return;
    }
    if (tag === 'TABLE') {
      const rows = [];
      let head = 0;
      let inHead = true;
      for (const tr of n.rows) {
        if (isHidden(tr, css(tr))) continue;
        const cells = [...tr.cells].map(c => runsOf(c, ' '));
        const isHead = tagOf(tr.parentElement) === 'THEAD' || [...tr.cells].every(c => tagOf(c) === 'TH');
        if (inHead && isHead) head++;
        else inHead = false;
        rows.push(cells);
      }
      if (rows.length) out.push({ t: 'table', head, rows });
      return;
    }
    if (tag === 'HR') { out.push({ t: 'hr' }); return; }
    if (tag === 'DETAILS') {
      const summary = [...n.children].find(c => tagOf(c) === 'SUMMARY');
      const b = [];
      blocksOf([...n.childNodes].filter(c => c !== summary), b, s);
      out.push({ t: 'details', s: summary ? runsOf(summary, ' ') : [{ x: 'Details' }], b, open: !n.hasAttribute('data-peek-closed') });
      return;
    }
    if (tag === 'DL') {
      for (const c of n.children) {
        if (isHidden(c, css(c))) continue;
        const r = runsOf(c, ' ');
        if (!r.length) continue;
        if (tagOf(c) === 'DT') r.forEach(x => { x.b = 1; });
        out.push({ t: 'p', r });
      }
      return;
    }
    if (tag === 'FIGCAPTION') {
      const r = runsOf(n, ' ');
      r.forEach(x => { x.i = 1; });
      if (r.length) out.push({ t: 'p', r });
      return;
    }
    if (tag === 'BLOCKQUOTE' || tag === 'ASIDE' || isCallout(n, s)) {
      const b = [];
      blocksOf(n.childNodes, b, s);
      if (b.length) out.push({ t: 'quote', b });
      return;
    }
    blocksOf(n.childNodes, out, s);
  };
  const extract = () => {
    const root = document.documentElement;
    try {
      document.querySelectorAll('details:not([open])').forEach(d => { d.setAttribute('data-peek-closed', ''); d.open = true; });
      const out = [];
      if (document.body) blocksOf(document.body.childNodes, out, css(document.body));
      const height = Math.max(root.getBoundingClientRect().height, root.scrollHeight > innerHeight + 1 ? root.scrollHeight : 0);
      const page = { title: (document.title || '').trim(), size: [Math.ceil(root.scrollWidth), Math.ceil(height)], blocks: out };
      const json = JSON.stringify(page).replace(/[\u007f-\uffff]/g, c => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
      root.setAttribute('data-peek-text', btoa(json));
    } catch (error) {
      root.setAttribute('data-peek-error', String((error && error.stack) || error).replace(/[^\x20-\x7e]/g, '?').slice(0, 300));
    }
  };
  addEventListener('load', extract);
  setTimeout(extract, 2500);
})()` +
  '</script>'

/** The page as the script read it, from what --dump-dom printed. */
export function readExtracted(dumped: string): Extracted {
  const encoded = /data-peek-text="([A-Za-z0-9+/=]*)"/.exec(dumped)
  if (encoded === null) {
    const error = /data-peek-error="([^"]*)"/.exec(dumped)
    throw new Error(`Chrome could not read the page${error === null ? '' : `: ${error[1]}`}`)
  }
  const bytes = fromBase64(encoded[1] ?? '')
  let json = ''
  for (let at = 0; at < bytes.length; at += 8192) json += String.fromCharCode(...bytes.subarray(at, at + 8192))
  return JSON.parse(json) as Extracted
}

/**
 * The page cut into an intro and sections at its second-level headings (third
 * when it has none), each a list of markdown pieces and figures; `boxes` holds
 * each figure's place on the page, in CSS pixels, for cutting it out.
 */
export function textOf(page: Extracted, layoutWidth: number): { text: PeekText; boxes: FigureBox[] } {
  const level = [2, 3].find(l => page.blocks.some(block => block.t === 'h' && block.l === l))
  const figures: PeekFigure[] = []
  const boxes: FigureBox[] = []
  const piecesOf = (blocks: readonly Block[]): PeekPiece[] => {
    const pieces: PeekPiece[] = []
    let pending: Block[] = []
    const flush = () => {
      const markdown = blocksMarkdown(pending)
      if (markdown.trim() !== '') pieces.push({ markdown })
      pending = []
    }
    for (const block of blocks) {
      if (block.t !== 'fig') {
        pending.push(block)
        continue
      }
      flush()
      figures.push({ alt: block.alt, share: Math.min(1, block.w / layoutWidth) })
      boxes.push({ x: block.x, y: block.y, w: block.w, h: block.h })
      pieces.push({ figure: figures.length - 1 })
    }
    flush()
    return pieces
  }

  const intro: Block[] = []
  const parts: { title: string; blocks: Block[] }[] = []
  for (const block of page.blocks) {
    if (block.t === 'h' && block.l === level) parts.push({ title: plainOf(block.r), blocks: [] })
    else (parts.at(-1)?.blocks ?? intro).push(block)
  }
  const introPieces = piecesOf(intro)
  const sections = parts.map(part => ({ title: part.title, pieces: piecesOf(part.blocks) }))
  return { text: { intro: introPieces, sections, figures }, boxes }
}

export type TextHow = { columns: number; drawsImage: boolean }

/** The unfolded row: the prototype's layout switcher, then the page in the layout picked. */
export async function drawText(
  $: EngineInterface,
  e: RenderInput,
  picture: PeekPicture,
  text: PeekText,
  how: TextHow,
): Promise<JSX.Element> {
  if (e.surface !== 'terminal') {
    const { Text } = $.ui.resolve(e)
    return <Text>{`${picture.title}: peek draws its pages in the terminal.`}</Text>
  }
  const { Box, Text, Button, Markdown, Image } = $.ui.resolve(e)
  const view = memberOf(viewAtom, e)
  const state = await read($, view)
  const change = (next: (view: PeekView) => PeekView) => () => void update($, view, next)
  const count = VARIANTS.length
  const variant = ((state.variant % count) + count) % count
  const sections = text.sections

  const figure = (index: number, key: string): JSX.Element => {
    const shown = text.figures[index]
    if (how.drawsImage && shown?.file !== undefined && shown.width !== undefined && shown.height !== undefined) {
      const wide = Math.max(10, Math.min(how.columns, MAX_IMAGE, Math.round(shown.share * how.columns)))
      const size = fitCells(shown.width, shown.height, wide, MAX_IMAGE)
      return (
        <Image
          key={key}
          source={{ file: shown.file, format: 'png', generation: picture.generation }}
          columns={size.columns}
          rows={size.rows}
          alt={`[figure] ${shown.alt}`}
        />
      )
    }
    return (
      <Text dimColor italic>
        {`[figure] ${shown?.alt || 'no description'}`}
      </Text>
    )
  }
  const pieces = (list: readonly PeekPiece[], key: string): JSX.Element[] =>
    list.map((piece, at) =>
      'markdown' in piece ? (
        <Markdown key={`${key}-${at}`} text={piece.markdown} />
      ) : (
        figure(piece.figure, `${key}-${at}`)
      ),
    )
  const heading = (title: string, key: string) => <Markdown key={key} text={`## ${escapeMarkdown(title)}`} />

  // Outline: the intro, then one folding row per section; the first starts open.
  const outline = () => (
    <Box flexDirection="column">
      <Box flexDirection="column" gap={1} marginBottom={1}>
        {pieces(text.intro, 'intro')}
      </Box>
      {sections.map((section, at) => {
        const isOpen = state.open.includes(at)
        const toggle = (
          <Button
            key={`fold-${at}`}
            plain
            onPress={change(v => ({ ...v, open: v.open.includes(at) ? v.open.filter(k => k !== at) : [...v.open, at] }))}
          >
            {isOpen ? '▾ ' : '▸ '}
            <Text weight="bold">{section.title}</Text>
          </Button>
        )
        if (!isOpen) return toggle
        return (
          <Box flexDirection="column">
            {toggle}
            <Box flexDirection="column" gap={1} paddingLeft={2} marginTop={1} marginBottom={1}>
              {pieces(section.pieces, `s${at}`)}
            </Box>
          </Box>
        )
      })}
      <Box flexDirection="row" gap={3} marginTop={1}>
        <Button key="unfold-all" plain dimColor label="unfold all" onPress={change(v => ({ ...v, open: sections.map((_, k) => k) }))} />
        <Button key="fold-all" plain dimColor label="fold all" onPress={change(v => ({ ...v, open: [] }))} />
      </Box>
    </Box>
  )

  // Document: everything at once, as a reply of Claude's reads.
  const linear = () => (
    <Box flexDirection="column" gap={1}>
      {pieces(text.intro, 'intro')}
      {sections.flatMap((section, at) => [heading(section.title, `title-${at}`), ...pieces(section.pieces, `s${at}`)])}
    </Box>
  )

  // Tabs: a bar of numbered sections and one section at a time.
  const tabs = () => {
    const last = sections.length - 1
    if (last < 0) return linear()
    const tab = Math.min(Math.max(state.tab, 0), last)
    const section = sections[tab]!
    const go = (to: number) => change(v => ({ ...v, tab: to }))
    const before = sections[tab - 1]
    const after = sections[tab + 1]
    return (
      <Box flexDirection="column" gap={1}>
        {pieces(text.intro, 'intro')}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {sections.map((s, at) =>
            at === tab ? (
              <Button key={`tab-${at}`} variant="primary" label={`${at + 1} ${short(s.title)}`} onPress={go(at)} />
            ) : (
              <Button key={`tab-${at}`} dimColor label={`${at + 1} ${short(s.title)}`} onPress={go(at)} />
            ),
          )}
        </Box>
        {heading(section.title, 'tab-title')}
        {pieces(section.pieces, `t${tab}`)}
        <Box flexDirection="row" gap={3}>
          {before === undefined ? [] : [<Button key="tab-back" plain label={`◂ ${short(before.title)}`} onPress={go(tab - 1)} />]}
          <Text dimColor>{`${tab + 1} of ${last + 1}`}</Text>
          {after === undefined ? [] : [<Button key="tab-next" plain label={`${short(after.title)} ▸`} onPress={go(tab + 1)} />]}
        </Box>
      </Box>
    )
  }

  const name = VARIANTS[variant] ?? 'Outline'
  const switcher = (
    <Box flexDirection="row" gap={1}>
      <Button key="layout-back" plain label="◂" onPress={change(v => ({ ...v, variant: (variant + count - 1) % count }))} />
      <Text inverse>{` layout ${variant + 1}/${count}: ${name} `}</Text>
      <Button key="layout-next" plain label="▸" onPress={change(v => ({ ...v, variant: (variant + 1) % count }))} />
      <Text dimColor>prototype switcher</Text>
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1}>
      {switcher}
      {name === 'Outline' ? outline() : name === 'Document' ? linear() : tabs()}
    </Box>
  )
}

function blocksMarkdown(blocks: readonly Block[]): string {
  return blocks
    .map(blockMarkdown)
    .filter(markdown => markdown.trim() !== '')
    .join('\n\n')
}

function blockMarkdown(block: Block): string {
  switch (block.t) {
    case 'p':
      return lineSafe(inlineMarkdown(block.r, false, false))
    case 'h':
      return `${'#'.repeat(Math.min(6, Math.max(1, block.l)))} ${inlineMarkdown(block.r, true, false)}`
    case 'pre':
      return fenced(block.x, block.lang)
    case 'ul':
    case 'ol': {
      const first = block.t === 'ol' ? block.start : 0
      const ordered = block.t === 'ol'
      return block.items
        .map((item, at) => {
          const marker = ordered ? `${first + at}. ` : '- '
          const pad = ' '.repeat(marker.length)
          const lines = blocksMarkdown(item).split('\n')
          return marker + lines.map((line, k) => (k === 0 || line === '' ? line : pad + line)).join('\n')
        })
        .join('\n')
    }
    case 'table':
      return tableMarkdown(block.rows)
    case 'hr':
      return '---'
    case 'quote':
      return blocksMarkdown(block.b)
        .split('\n')
        .map(line => (line === '' ? '>' : `> ${line}`))
        .join('\n')
    case 'details':
      return [`**${inlineMarkdown(block.s, true, false)}**`, blocksMarkdown(block.b)].filter(part => part !== '').join('\n\n')
    case 'fig':
      return `*[figure] ${escapeMarkdown(block.alt || 'no description')}*`
  }
}

function inlineMarkdown(runs: readonly Run[], oneLine: boolean, inTable: boolean): string {
  let out = ''
  for (const run of runs) {
    const text = oneLine ? run.x.replace(/\n/g, ' ') : run.x
    let markdown =
      run.c === 1 ? codeSpan(inTable ? text.replace(/\|/g, '\\|') : text) : escapeMarkdown(text, inTable).replace(/\n/g, '  \n')
    if (run.a !== undefined && LINKABLE.test(run.a)) {
      markdown = `[${markdown}](${run.a.replace(/[ ()]/g, c => (c === ' ' ? '%20' : c === '(' ? '%28' : '%29'))})`
    }
    if (run.b === 1) markdown = around(markdown, '**')
    if (run.i === 1) markdown = around(markdown, '*')
    out += markdown
  }
  return out
}

function tableMarkdown(rows: readonly (readonly (readonly Run[])[])[]): string {
  const width = Math.max(1, ...rows.map(row => row.length))
  const line = (row: readonly (readonly Run[])[]) =>
    `| ${Array.from({ length: width }, (_, k) => inlineMarkdown(row[k] ?? [], true, true) || ' ').join(' | ')} |`
  const [first = [], ...rest] = rows
  return [line(first), `|${' --- |'.repeat(width)}`, ...rest.map(line)].join('\n')
}

function fenced(code: string, language: string | undefined): string {
  const fence = '`'.repeat(Math.max(2, ...(code.match(/`+/g) ?? []).map(run => run.length)) + 1)
  return `${fence}${language ?? ''}\n${code}\n${fence}`
}

function codeSpan(text: string): string {
  const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(text.replace(/\n/g, ' '))
  const code = parts?.[2] ?? ''
  if (parts === null || code === '') return text
  const ticks = '`'.repeat(Math.max(0, ...(code.match(/`+/g) ?? []).map(run => run.length)) + 1)
  const pad = ticks.length > 1 ? ' ' : ''
  return `${parts[1]}${ticks}${pad}${code}${pad}${ticks}${parts[3]}`
}

// Bold or italic marks hug the text: whitespace inside them stops them working.
function around(markdown: string, mark: string): string {
  const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(markdown)
  if (parts === null || parts[2] === '') return markdown
  return `${parts[1]}${mark}${parts[2]}${mark}${parts[3]}`
}

// Escapes only what would start markup, so a renderer that skipped escapes
// would still read cleanly: intraword underscores and lone brackets stay.
function escapeMarkdown(text: string, inTable = false): string {
  return text
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    .replace(/[`*~[]/g, '\\$&')
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '\\_')
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/\|/g, inTable ? '\\|' : '|')
}

// A paragraph line must not start what reads as a heading, list or rule.
function lineSafe(markdown: string): string {
  return markdown.replace(/^(\s*)([#>+=-])/gm, '$1\\$2').replace(/^(\s*\d+)([.)])/gm, '$1\\$2')
}

function plainOf(runs: readonly Run[]): string {
  return runs
    .map(run => run.x)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function short(title: string, most = 24): string {
  return title.length <= most ? title : `${title.slice(0, most - 1).trimEnd()}…`
}
