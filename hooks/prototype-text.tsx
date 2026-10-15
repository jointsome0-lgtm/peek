// PROTOTYPE (native-text branch, throwaway). A page shown in the chat as real
// terminal text instead of one big picture: headings, paragraphs, lists,
// tables and code drawn by the engine's Markdown element, figures cut from a
// snapshot of the page; with --live, the page's own controls drawn as the
// terminal's buttons, fields and lists, working in a page kept open.
//
// Question: does a page read well in the chat as text, and which layout feels
// right: Outline (folded sections, a bar to travel between them), Document
// (all of it) or Tabs (one section at a time)? Centered or at the left? With
// --live: does using the page from the chat feel right?
//
// Run: /peek <page.html> --text (or --live), unfold the row, flip layouts with
// ◂ and ▸, and the column with center and left.
// This file never merges; the decision lands on main, rewritten with tests.

import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'

import type { PeekControl, PeekFigure, PeekPicture, PeekPiece, PeekRowItem, PeekRun, PeekText, PeekView } from '../types'
import { fromBase64 } from './base64'
import { fitCells } from './picture'

const VARIANTS = ['Outline', 'Document', 'Tabs'] as const
const viewAtom = atom({ plugin: 'peek', key: 'view' } as const, { variant: 0, open: [0], tab: 0 })
const MAX_IMAGE = 255
/** The widest the text runs, in columns: a column to read, centered or at the left. */
const READ_COLUMNS = 100
const LINKABLE = /^(https?|file):/i

type Run = PeekRun
type RowItem = { r: Run[] } | { k: number }
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
  | { t: 'row'; items: RowItem[] }
  | ({ t: 'fig'; alt: string } & FigureBox)
/** The page as the reader read it. */
export type Extracted = { title: string; size: [number, number]; blocks: Block[]; controls?: PeekControl[] }
/** PROTOTYPE (live text): what a press in the chat asks of the live page. */
export type LiveAction =
  | { kind: 'read' }
  | { kind: 'click' | 'text' | 'select' | 'range'; control: string; value?: string }

// Peek's page reader, plain JavaScript run inside the page: walks the DOM into
// blocks of styled runs, figures with their boxes, and rows that hold the
// page's controls (buttons, fields, lists, boxes to tick), each marked with a
// data-peek-id so a press in the chat can find it again. `read()` returns
// { title, size, blocks, controls }. No backticks or dollar-braces inside.
const READER = String.raw`
  const PHRASING = new Set('A ABBR B BDI BDO BIG BR BUTTON CITE CODE DATA DEL DFN EM FONT I IMG INPUT INS KBD LABEL MARK METER NOBR OUTPUT PROGRESS Q S SAMP SELECT SMALL SPAN STRIKE STRONG SUB SUP SVG TEXTAREA TIME TT U VAR WBR'.split(' '));
  const SKIP = new Set('SCRIPT STYLE NOSCRIPT TEMPLATE HEAD META LINK TITLE BASE DATALIST'.split(' '));
  const FIGURES = new Set('IMG SVG CANVAS VIDEO PICTURE IFRAME OBJECT EMBED'.split(' '));
  const ROLES = new Set('button checkbox radio switch tab menuitem menuitemcheckbox menuitemradio option'.split(' '));
  const BLOCKS = 'address,article,aside,blockquote,details,dialog,div,dl,fieldset,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,ul';
  const CONTROLS = 'button,input,select,textarea,[role=button],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=option],[role^=menuitem]';
  const MONO = /mono|courier|consol|menlo|monaco/i;
  const MIN_FIGURE = 48;
  const JOINER = ' \u2014 ';
  let controls = [];
  let consumed = new Set();
  const tagOf = n => n.localName.toUpperCase();
  const css = n => getComputedStyle(n);
  const words = text => String(text || '').replace(/\s+/g, ' ').trim();
  const isHidden = (n, s) => s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || s.opacity === '0' || n.getAttribute('aria-hidden') === 'true';
  const isFigure = n => FIGURES.has(tagOf(n)) || n.getAttribute('role') === 'img';
  const isPhrasing = n => PHRASING.has(tagOf(n)) && !n.querySelector(BLOCKS);
  const altOf = n => {
    const title = n.querySelector('title');
    return words(n.getAttribute('aria-label') || n.getAttribute('alt') || n.getAttribute('title') || (title ? title.textContent : ''));
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
  // Click listeners are only visible to DevTools' own functions, which the
  // live view's reader has and a --dump-dom one does not.
  const listens = n => {
    if (typeof getEventListeners !== 'function') return false;
    try {
      const l = getEventListeners(n);
      return !!(l.click || l.mousedown || l.mouseup || l.pointerdown || l.pointerup);
    } catch (error) {
      return false;
    }
  };
  const small = n => {
    const text = words(n.innerText);
    return text.length > 0 && text.length <= 80 && !n.querySelector(BLOCKS) && !n.querySelector(CONTROLS);
  };
  const anchored = href => {
    try {
      return !!document.getElementById(decodeURIComponent(href.slice(1)));
    } catch (error) {
      return false;
    }
  };
  // A control: a form field or button, something with a control's role or an
  // onclick, or a short piece of text that listens for clicks or shows the
  // pointer hand. A link that goes somewhere stays a link; a big figure stays a
  // figure.
  const isControl = (n, s) => {
    const tag = tagOf(n);
    if (tag === 'LABEL' || tag === 'SUMMARY' || tag === 'OPTION' || tag === 'OPTGROUP') return false;
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return n.type !== 'hidden' && n.type !== 'file';
    if (isFigure(n)) {
      const r = n.getBoundingClientRect();
      if (r.width >= MIN_FIGURE && r.height >= MIN_FIGURE) return false;
    }
    if (tag === 'A' && n.hasAttribute('href')) {
      const href = n.getAttribute('href').trim();
      if (!/^(#|javascript:|$)/i.test(href) || (href.length > 1 && href[0] === '#' && anchored(href))) return false;
    }
    if (ROLES.has(n.getAttribute('role') || '') || n.hasAttribute('onclick')) return !n.querySelector(CONTROLS);
    const pointer = s.cursor === 'pointer' && !(n.parentElement && css(n.parentElement).cursor === 'pointer');
    return (pointer || listens(n)) && small(n);
  };
  const labelOf = (n, k) => {
    const aria = n.getAttribute('aria-label') || '';
    const title = n.getAttribute('title') || '';
    const label = n.labels && n.labels.length ? n.labels[0].innerText : '';
    if (k === 'button') {
      const value = tagOf(n) === 'INPUT' ? n.value || (n.type === 'submit' ? 'Submit' : n.type === 'reset' ? 'Reset' : '') : '';
      return words(n.innerText) || aria || value || title || altOf(n) || 'button';
    }
    if (k === 'check' || k === 'radio') return words(label) || aria || title || (n.value && n.value !== 'on' ? n.value : '') || words(n.innerText);
    return aria || words(label) || n.getAttribute('placeholder') || n.getAttribute('name') || title || '';
  };
  const controlOf = n => {
    if (!n.hasAttribute('data-peek-id')) {
      window.__peekSeq = (window.__peekSeq || 0) + 1;
      n.setAttribute('data-peek-id', String(window.__peekSeq));
    }
    const tag = tagOf(n);
    const role = n.getAttribute('role') || '';
    const type = tag === 'INPUT' ? String(n.type || 'text').toLowerCase() : '';
    const c = { id: n.getAttribute('data-peek-id') };
    if (type === 'checkbox' || role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox') {
      c.k = 'check';
      c.on = type === 'checkbox' ? n.checked : n.getAttribute('aria-checked') === 'true';
    } else if (type === 'radio' || role === 'radio' || role === 'menuitemradio') {
      c.k = 'radio';
      c.on = type === 'radio' ? n.checked : n.getAttribute('aria-checked') === 'true';
    } else if (tag === 'SELECT') {
      c.k = 'select';
      c.v = n.value;
      c.opts = [...n.options].filter(o => !o.hidden && !o.disabled).map(o => ({ v: o.value, l: words(o.label || o.text) || o.value }));
    } else if (type === 'range') {
      c.k = 'range';
      c.v = n.value;
      c.min = n.min || '0';
      c.max = n.max || '100';
      c.step = n.step && n.step !== 'any' ? n.step : '1';
    } else if (tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(button|submit|reset|image)$/.test(type))) {
      c.k = 'text';
      c.v = n.value;
      if (n.placeholder) c.ph = n.placeholder;
      if (tag === 'TEXTAREA') c.area = 1;
    } else {
      c.k = 'button';
      const state = role === 'tab' || role === 'option' ? n.getAttribute('aria-selected') : n.getAttribute('aria-pressed');
      if (state === 'true') c.on = true;
    }
    if (n.disabled || n.getAttribute('aria-disabled') === 'true') c.off = 1;
    c.l = labelOf(n, c.k).slice(0, 80);
    controls.push(c);
    return controls.length - 1;
  };
  // A control as plain text, where it cannot be drawn as one: in a heading or a table cell.
  const flatOf = c => {
    if (c.k === 'check') return (c.on ? '\u2611 ' : '\u2610 ') + c.l;
    if (c.k === 'radio') return (c.on ? '\u25c9 ' : '\u25cb ') + c.l;
    if (c.k === 'select') {
      const picked = (c.opts || []).find(o => o.v === c.v);
      return '[' + (picked ? picked.l : c.v) + ' \u25be]';
    }
    if (c.k === 'text') return '[' + (c.v || c.ph || c.l || '\u2026') + ']';
    if (c.k === 'range') return '[' + (c.l ? c.l + ' ' : '') + c.v + ']';
    return '[' + c.l + ']';
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
      // Nothing goes between a figure or a control and what follows: they stand apart anyway.
      let k = list.length - 1;
      while (k >= 0 && list[k].x !== undefined && !list[k].x.trim()) k--;
      const last = list[list.length - 1];
      if (k >= 0 && list[k].x !== undefined) {
        if (sep === 'joiner') {
          last.x = last.x.replace(/\s+$/, '');
          list.push({ x: runs.joiner });
          text = text.replace(/^\s+/, '');
        } else if (!/\s$/.test(last.x) && !/^\s/.test(text)) {
          list.push({ x: ' ' });
        }
      }
    }
    const last = list[list.length - 1];
    if (last && last.x !== undefined && sameFormat(last, f)) last.x += text;
    else list.push(Object.assign({ x: text }, f));
  };
  // A box to tick or a choice owns its labels: they become its text, not the page's.
  const pushControl = (runs, n) => {
    const index = controlOf(n);
    const k = controls[index].k;
    consumed.add(n);
    if ((k === 'check' || k === 'radio') && n.labels) for (const l of n.labels) consumed.add(l);
    runs.sep = '';
    runs.list.push({ ctl: index });
  };
  const checkOf = n => {
    if (tagOf(n) !== 'LABEL') return null;
    const c = n.control;
    return c && (c.type === 'checkbox' || c.type === 'radio') && !consumed.has(c) ? c : null;
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
      if (SKIP.has(tag) || consumed.has(n)) continue;
      const s = css(n);
      if (s.display === 'contents') { inlineNodes(n.childNodes, runs, formatOf(n, s, base, f), base); continue; }
      if (isHidden(n, s)) continue;
      if (tag === 'BR') { pushText(runs, '\n', f); continue; }
      const check = checkOf(n);
      if (check) { consumed.add(n); pushControl(runs, check); continue; }
      if (isControl(n, s)) { pushControl(runs, n); continue; }
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
  // Text runs become a paragraph; with a control among them, a row of text
  // pieces and controls in page order.
  const emit = (runs, out) => {
    let segment = [];
    const flush = () => {
      if (segment.some(r => r.ctl !== undefined)) {
        const items = [];
        let text = [];
        const done = () => {
          const r = tidy(text);
          if (r.length) items.push({ r });
          text = [];
        };
        for (const r of segment) {
          if (r.ctl === undefined) text.push(r);
          else { done(); items.push({ k: r.ctl }); }
        }
        done();
        out.push({ t: 'row', items });
      } else {
        const r = tidy(segment);
        if (r.length) out.push({ t: 'p', r });
      }
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
      if (r.fig) { if (r.fig.alt) flat.push({ x: ' ' + r.fig.alt + ' ' }); }
      else if (r.ctl !== undefined) flat.push({ x: ' ' + flatOf(controls[r.ctl]) + ' ' });
      else flat.push(r);
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
    const kids = [...nodes].filter(n => n.nodeType === 3 || (n.nodeType === 1 && !SKIP.has(tagOf(n)) && !consumed.has(n)));
    let runs = Runs(JOINER);
    const flush = () => { emit(runs, out); runs = Runs(JOINER); };
    // The items of a flex row stand side by side: controls among them share a row.
    const flows = /flex$/.test(base.display) && !/^column/.test(base.flexDirection);
    if (kids.every(n => n.nodeType === 3 || isPhrasing(n))) {
      inlineNodes(kids, runs, {}, base);
      flush();
      return;
    }
    for (const n of kids) {
      if (n.nodeType === 3) { pushText(runs, n.data.replace(/\s+/g, ' '), {}); continue; }
      if (consumed.has(n)) continue;
      const s = css(n);
      if (s.display === 'contents') { flush(); blocksOf(n.childNodes, out, base); continue; }
      if (isHidden(n, s)) continue;
      if (checkOf(n) || isControl(n, s)) {
        const inline = flows || s.display.startsWith('inline');
        if (!inline) flush();
        inlineNodes([n], runs, {}, base);
        if (!inline) flush();
        continue;
      }
      if (isFigure(n)) {
        const fig = figureOf(n);
        if (fig.w >= MIN_FIGURE && fig.h >= MIN_FIGURE) { flush(); out.push(fig); } else if (fig.alt) pushText(runs, fig.alt, {});
        continue;
      }
      // A fieldset's legend names the choices after it, on their row.
      if (tagOf(n) === 'LEGEND') { inlineNodes([n], runs, {}, base); continue; }
      if (isPhrasing(n)) {
        if (s.display.startsWith('inline') || (flows && n.querySelector(CONTROLS))) inlineNodes([n], runs, {}, base);
        else {
          flush();
          const own = Runs(JOINER);
          inlineNodes([n], own, {}, base);
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
        if (isControl(li, ls)) {
          const runs = Runs(JOINER);
          pushControl(runs, li);
          emit(runs, b);
        } else blocksOf(li.childNodes, b, ls);
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
  // Closed <details> are opened to be read, and marked so they draw closed.
  const read = () => {
    controls = [];
    consumed = new Set();
    document.querySelectorAll('details:not([open])').forEach(d => { d.setAttribute('data-peek-closed', ''); d.open = true; });
    const out = [];
    if (document.body) blocksOf(document.body.childNodes, out, css(document.body));
    const root = document.documentElement;
    const height = Math.max(root.getBoundingClientRect().height, root.scrollHeight > innerHeight + 1 ? root.scrollHeight : 0);
    return { title: words(document.title), size: [Math.ceil(root.scrollWidth), Math.ceil(height)], blocks: out, controls };
  };
`

// Runs in the page copy once it has loaded, and again late in the browser's
// time budget: puts what the reader read, as base64 of ASCII JSON, in
// data-peek-text on the root, which --dump-dom prints first.
export const EXTRACT_SCRIPT =
  '<script>(() => {' +
  READER +
  String.raw`
  const extract = () => {
    const root = document.documentElement;
    try {
      const json = JSON.stringify(read()).replace(/[\u007f-\uffff]/g, c => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
      root.setAttribute('data-peek-text', btoa(json));
    } catch (error) {
      root.setAttribute('data-peek-error', String((error && error.stack) || error).replace(/[^\x20-\x7e]/g, '?').slice(0, 300));
    }
  };
  addEventListener('load', extract);
  setTimeout(extract, 2500);
})()` +
  '</script>'

/** PROTOTYPE (live text): the reader as an expression the live helper evaluates in the open page. */
export const LIVE_READ = `(() => {${READER}\n  return read();\n})()`

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
 * when it has none), each a list of markdown pieces, rows and figures; `boxes`
 * holds each figure's place on the page, in CSS pixels, for cutting it out.
 */
export function textOf(page: Extracted, layoutWidth: number): { text: PeekText; boxes: FigureBox[] } {
  const blocks = lift(page.blocks)
  const level = [2, 3].find(l => blocks.some(block => block.t === 'h' && block.l === l))
  const figures: PeekFigure[] = []
  const boxes: FigureBox[] = []
  const piecesOf = (list: readonly Block[]): PeekPiece[] => {
    const pieces: PeekPiece[] = []
    let pending: Block[] = []
    const flush = () => {
      const markdown = blocksMarkdown(pending)
      if (markdown.trim() !== '') pieces.push({ markdown })
      pending = []
    }
    for (const block of list) {
      if (block.t === 'row') {
        flush()
        pieces.push({ row: block.items.map(item => ('k' in item ? { control: item.k } : { text: item.r })) })
      } else if (block.t === 'fig') {
        flush()
        figures.push({ alt: block.alt, share: Math.min(1, block.w / layoutWidth) })
        boxes.push({ x: block.x, y: block.y, w: block.w, h: block.h })
        pieces.push({ figure: figures.length - 1 })
      } else {
        pending.push(block)
      }
    }
    flush()
    return pieces
  }

  const intro: Block[] = []
  const parts: { title: string; blocks: Block[] }[] = []
  for (const block of blocks) {
    if (block.t === 'h' && block.l === level) parts.push({ title: plainOf(block.r), blocks: [] })
    else (parts.at(-1)?.blocks ?? intro).push(block)
  }
  const introPieces = piecesOf(intro)
  const sections = parts.map(part => ({ title: part.title, pieces: piecesOf(part.blocks) }))
  return { text: { intro: introPieces, sections, figures, controls: page.controls ?? [] }, boxes }
}

function hasRow(blocks: readonly Block[]): boolean {
  return blocks.some(
    block =>
      block.t === 'row' ||
      ((block.t === 'quote' || block.t === 'details') && hasRow(block.b)) ||
      ((block.t === 'ul' || block.t === 'ol') && block.items.some(hasRow)),
  )
}

// A row of controls cannot sit inside markdown: a quote, a details or a list
// holding one is opened out around it, its list items marked by hand.
function lift(blocks: readonly Block[]): Block[] {
  const out: Block[] = []
  for (const block of blocks) {
    if (block.t === 'quote' && hasRow(block.b)) {
      out.push(...lift(block.b))
    } else if (block.t === 'details' && hasRow(block.b)) {
      out.push({ t: 'p', r: block.s.map(run => ({ ...run, b: 1 as const })) }, ...lift(block.b))
    } else if ((block.t === 'ul' || block.t === 'ol') && block.items.some(hasRow)) {
      const ordered = block.t === 'ol'
      const first = block.t === 'ol' ? block.start : 1
      let plain: Block[][] = []
      const flushPlain = (next: number) => {
        if (plain.length > 0) out.push(ordered ? { t: 'ol', start: next - plain.length, items: plain } : { t: 'ul', items: plain })
        plain = []
      }
      block.items.forEach((item, at) => {
        if (!hasRow(item)) {
          plain.push(item)
          return
        }
        flushPlain(first + at)
        const marker = ordered ? `${first + at}.` : '•'
        const [head, ...rest] = lift(item)
        if (head?.t === 'row') out.push({ t: 'row', items: [{ r: [{ x: marker }] }, ...head.items] })
        else if (head?.t === 'p') out.push({ t: 'p', r: [{ x: `${marker} ` }, ...head.r] })
        else out.push({ t: 'p', r: [{ x: marker }] }, ...(head === undefined ? [] : [head]))
        out.push(...rest)
      })
      flushPlain(first + block.items.length)
    } else {
      out.push(block)
    }
  }
  return out
}

export type TextHow = {
  columns: number
  drawsImage: boolean
  /**
   * PROTOTYPE (live text): does in the live page what a press asks and shows
   * the page again; resolves to a note for the row, if any. Absent, the
   * page's controls are drawn as text.
   */
  act?: (action: LiveAction) => Promise<string | undefined>
}

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
  const { Box, Text, Button, Markdown, Image, Input, Select, Link } = $.ui.resolve(e)
  const view = memberOf(viewAtom, e)
  const state = await read($, view)
  const change = (next: (view: PeekView) => PeekView) => () => void update($, view, next)
  const count = VARIANTS.length
  const variant = ((state.variant % count) + count) % count
  const sections = text.sections
  const controls = text.controls ?? []
  const act = how.act
  const left = state.left === true
  const wide = Math.min(how.columns, READ_COLUMNS)
  // Keys the chat scrolls to, the row's own: two rows may show one page.
  const tag = tagOf(e.requestId)
  const headKey = (at: number) => `fold-${at}-${tag}`
  const contentsKey = `go-0-${tag}`

  // A press says the page is working, asks the page, then says what came of it.
  const press = (action: LiveAction) => {
    if (act === undefined) return
    void (async () => {
      await update($, view, v => ({ ...v, busy: true, error: '', notice: '' }))
      let error = ''
      let notice = ''
      try {
        notice = (await act(action)) ?? ''
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
      }
      await update($, view, v => ({ ...v, busy: false, error, notice }))
    })()
  }

  // Travel: brings a heading to the top of the screen, opening its section.
  // The first scroll answers the press at once; the second lands it once open.
  const travel = (key: string, open?: number) => () => {
    const scroll = () =>
      $.ui.scroll({ to: { key }, block: 'start' }).then(
        moved => moved.deny,
        (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
      )
    const first = scroll()
    void (async () => {
      let deny = await first
      if (open !== undefined && !state.open.includes(open)) {
        await update($, view, v => (v.open.includes(open) ? v : { ...v, open: [...v.open, open] }))
        const second = await scroll()
        if (deny !== undefined) deny = second
      }
      const notice = deny === undefined ? '' : `could not scroll there: ${deny}`
      await update($, view, v => (v.notice === notice ? v : { ...v, notice }))
    })()
  }

  const figure = (index: number, key: string): JSX.Element => {
    const shown = text.figures[index]
    if (how.drawsImage && shown?.file !== undefined && shown.width !== undefined && shown.height !== undefined) {
      const most = Math.max(10, Math.min(wide, MAX_IMAGE, Math.round(shown.share * wide)))
      const size = fitCells(shown.width, shown.height, most, MAX_IMAGE)
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
  const styled = (run: PeekRun): JSX.Element => {
    if (run.a !== undefined && LINKABLE.test(run.a)) return <Link href={run.a}>{run.x}</Link>
    const style: { weight?: 'bold'; italic?: boolean; color?: 'permission' } = {}
    if (run.b === 1) style.weight = 'bold'
    if (run.i === 1) style.italic = true
    if (run.c === 1) style.color = 'permission'
    return <Text {...style}>{run.x}</Text>
  }
  // One of the page's controls: the terminal's own when the page is live,
  // else its text, dimmed.
  const control = (index: number): JSX.Element => {
    const c = controls[index]
    if (c === undefined) return <Text dimColor>[?]</Text>
    if (act === undefined || c.off === 1) return <Text dimColor>{flatControl(c)}</Text>
    const key = `control-${c.id}`
    const on = (kind: 'click' | 'text' | 'select' | 'range', value?: string) => press({ kind, control: c.id, value })
    switch (c.k) {
      case 'button':
        return c.on === true ? (
          <Button key={key} variant="primary" label={c.l} onPress={() => on('click')} />
        ) : (
          <Button key={key} label={c.l} onPress={() => on('click')} />
        )
      case 'check':
      case 'radio':
        return <Button key={key} plain label={flatControl(c)} onPress={() => on('click')} />
      case 'text':
        return <Input key={key} placeholder={c.ph || c.l || 'text'} value={c.v ?? ''} onSubmit={value => on('text', value)} />
      case 'select': {
        const options = uniqueOptions(c)
        if (options.length === 0) return <Text dimColor>{flatControl(c)}</Text>
        const value = options.some(option => option.value === c.v) ? c.v : undefined
        return <Select key={key} options={options} value={value} onSelect={value => on('select', value)} />
      }
      case 'range': {
        const step = Number(c.step) || 1
        const digits = (c.step?.split('.')[1] ?? '').length
        const to = (delta: number) =>
          String(Number(Math.min(Number(c.max ?? 100), Math.max(Number(c.min ?? 0), (Number(c.v) || 0) + delta)).toFixed(digits)))
        return (
          <Box flexDirection="row" columnGap={1}>
            <Button key={`${key}-down`} label="−" onPress={() => on('range', to(-step))} />
            <Text weight="bold">{c.v ?? ''}</Text>
            <Button key={`${key}-up`} label="+" onPress={() => on('range', to(step))} />
          </Box>
        )
      }
    }
  }
  const row = (items: readonly PeekRowItem[]): JSX.Element => (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
      {items.map(item => ('control' in item ? control(item.control) : <Text>{item.text.map(styled)}</Text>))}
    </Box>
  )
  const pieces = (list: readonly PeekPiece[], key: string): JSX.Element[] =>
    list.map((piece, at) =>
      'markdown' in piece ? (
        <Markdown key={`${key}-${at}`} text={piece.markdown} />
      ) : 'row' in piece ? (
        row(piece.row)
      ) : (
        figure(piece.figure, `${key}-${at}`)
      ),
    )
  const heading = (title: string, key: string) => <Markdown key={key} text={`## ${escapeMarkdown(title)}`} />

  // Outline: the intro, a bar to travel to any section, then one folding row
  // per section; the first starts open, and each open one ends in a way on.
  const travels = sections.length > 1
  const outline = () => (
    <Box flexDirection="column">
      <Box flexDirection="column" gap={1} marginBottom={1}>
        {pieces(text.intro, 'intro')}
      </Box>
      {!travels
        ? []
        : [
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginBottom={1}>
              <Text dimColor>go to</Text>
              {sections.map((s, at) => (
                <Button
                  key={`go-${at}-${tag}`}
                  dimColor={!state.open.includes(at)}
                  label={`${at + 1} ${short(s.title)}`}
                  onPress={travel(headKey(at), at)}
                />
              ))}
            </Box>,
          ]}
      {sections.map((section, at) => {
        const isOpen = state.open.includes(at)
        const toggle = (
          <Button
            key={headKey(at)}
            plain
            onPress={change(v => ({ ...v, open: v.open.includes(at) ? v.open.filter(k => k !== at) : [...v.open, at] }))}
          >
            {isOpen ? '▾ ' : '▸ '}
            <Text weight="bold">{section.title}</Text>
          </Button>
        )
        if (!isOpen) return toggle
        const before = sections[at - 1]
        const after = sections[at + 1]
        const ways = !travels
          ? []
          : [
              <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
                {before === undefined
                  ? []
                  : [<Button key={`back-${at}-${tag}`} plain dimColor label={`◂ ${short(before.title)}`} onPress={travel(headKey(at - 1), at - 1)} />]}
                <Button key={`up-${at}-${tag}`} plain dimColor label="▴ go to" onPress={travel(contentsKey)} />
                {after === undefined
                  ? []
                  : [<Button key={`next-${at}-${tag}`} plain label={`${short(after.title)} ▸`} onPress={travel(headKey(at + 1), at + 1)} />]}
              </Box>,
            ]
        return (
          <Box flexDirection="column">
            {toggle}
            <Box flexDirection="column" gap={1} paddingLeft={2} marginTop={1} marginBottom={1}>
              {pieces(section.pieces, `s${at}`)}
              {ways}
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
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Button key="layout-back" plain label="◂" onPress={change(v => ({ ...v, variant: (variant + count - 1) % count }))} />
      <Text inverse>{` layout ${variant + 1}/${count}: ${name} `}</Text>
      <Button key="layout-next" plain label="▸" onPress={change(v => ({ ...v, variant: (variant + 1) % count }))} />
      <Text dimColor>· align</Text>
      <Button key="align-center" plain dimColor={left} label="center" onPress={change(v => ({ ...v, left: false }))} />
      <Button key="align-left" plain dimColor={!left} label="left" onPress={change(v => ({ ...v, left: true }))} />
      <Text dimColor>· prototype switcher</Text>
    </Box>
  )
  const status: JSX.Element[] = []
  if (act !== undefined) status.push(<Button key="live-read" plain dimColor label="↻ read the page again" onPress={() => press({ kind: 'read' })} />)
  if (state.busy === true) status.push(<Text color="warning">… the page is working</Text>)
  else if (state.error) status.push(<Text color="error">{`✗ ${state.error}`}</Text>)
  else if (state.notice) status.push(<Text color="warning">{state.notice}</Text>)
  // The page reads as a column at most READ_COLUMNS wide: in the middle of the
  // chat, as its pictures sit, or at its left, as its own text does.
  return (
    <Box flexDirection="column" alignItems={left ? 'flex-start' : 'center'} width="100%">
      <Box flexDirection="column" gap={1} width={wide}>
        {switcher}
        {status.length === 0 ? [] : [<Box flexDirection="row" flexWrap="wrap" columnGap={2}>{status}</Box>]}
        {name === 'Outline' ? outline() : name === 'Document' ? linear() : tabs()}
      </Box>
    </Box>
  )
}

/** A control as text: a box to tick, a choice, a field, a list, a button. */
function flatControl(control: PeekControl): string {
  switch (control.k) {
    case 'check':
      return `${control.on === true ? '☑' : '☐'} ${control.l}`
    case 'radio':
      return `${control.on === true ? '◉' : '○'} ${control.l}`
    case 'select':
      return `[${control.opts?.find(option => option.v === control.v)?.l ?? control.v ?? ''} ▾]`
    case 'text':
      return `[${control.v || control.ph || control.l || '…'}]`
    case 'range':
      return `[${control.l ? `${control.l} ` : ''}${control.v ?? ''}]`
    case 'button':
      return `[${control.l}]`
  }
}

/** A select's options as `Select` takes them: values unique. */
function uniqueOptions(control: PeekControl): { value: string; label: string }[] {
  const seen = new Set<string>()
  const options: { value: string; label: string }[] = []
  for (const option of control.opts ?? []) {
    if (seen.has(option.v)) continue
    seen.add(option.v)
    options.push({ value: option.v, label: option.l || option.v })
  }
  return options
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
    case 'row':
      return lineSafe(block.items.map(item => ('r' in item ? inlineMarkdown(item.r, false, false) : '')).join(' '))
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

/** A short tag of a row's id, for keys that must be the row's own. */
function tagOf(id: string): string {
  let hash = 0
  for (let at = 0; at < id.length; at++) hash = (Math.imul(hash, 31) + id.charCodeAt(at)) | 0
  return (hash >>> 0).toString(36)
}

function short(title: string, most = 24): string {
  return title.length <= most ? title : `${title.slice(0, most - 1).trimEnd()}…`
}
