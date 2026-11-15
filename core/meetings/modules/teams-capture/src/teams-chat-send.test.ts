/**
 * teams-capture L2 (chat send) — the acts.v1 `chat_send` primitives against a DOM fixture of the
 * Teams meeting chat panel, no browser. Drives the real sendTeamsChatMessage / prepareTeamsChatSend /
 * awaitTeamsChatLanded over an in-memory DOM shim and pins:
 *   - a closed panel is opened through the control-bar toggle, and a pressed toggle is not clicked;
 *   - the text goes into the rich-text composer through insertText (never value assignment), and the
 *     send button of the composer's own row is clicked; with no send button, Enter is pressed;
 *   - the send counts only once a message body reading the text shows in the list (not_landed
 *     otherwise), and a line already in the list is told apart from the new one;
 *   - no composer → no_composer; blank text → empty_text, the page untouched;
 *   - the trusted path's marks land on the composer and the send button, and stale marks are cleared.
 * The live Teams DOM is validated live.
 * Run: npx tsx src/teams-chat-send.test.ts   (the package's `npm test` chains it)
 */
import {
  sendTeamsChatMessage,
  prepareTeamsChatSend,
  awaitTeamsChatLanded,
  countTeamsChatLines,
  TEAMS_CHAT_COMPOSER_MARK,
  TEAMS_CHAT_SEND_MARK,
} from './teams-chat.js';

let failed = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failed++;
};

// ── Minimal in-memory DOM shim: tag, #id, [attr], [attr="v"], [attr*="v" i], [attr^="v"],
//    compound selectors, comma lists; click/focus/dispatchEvent recorded ──
type Cond = (el: FakeEl) => boolean;
function simple(sel: string): Cond {
  const attr = sel.match(/^\[([a-zA-Z0-9_-]+)(?:([*^]?=)"([^"]*)"(\s+i)?)?\]$/);
  if (attr) {
    const [, name, op, raw, ci] = attr;
    return (el) => {
      const got = el.getAttribute(name);
      if (got == null) return false;
      if (!op) return true;
      const v = ci ? got.toLowerCase() : got;
      const want = ci ? raw.toLowerCase() : raw;
      if (op === '=') return v === want;
      if (op === '*=') return v.includes(want);
      if (op === '^=') return v.startsWith(want);
      return false;
    };
  }
  if (sel.startsWith('#')) { const id = sel.slice(1); return (el) => el.getAttribute('id') === id; }
  if (sel === '*') return () => true;
  const tag = sel.toLowerCase();
  return (el) => el.tag === tag;
}
function compile(selector: string): Cond {
  const groups = selector.split(/,(?![^[]*\])/).map((s) => {
    const parts = s.trim().match(/(\[[^\]]*\]|[#]?[a-zA-Z0-9_*-]+)/g) || [s];
    const cs = parts.map(simple);
    return (el: FakeEl) => cs.every((c) => c(el));
  });
  return (el) => groups.some((g) => g(el));
}

class FakeEl {
  tag: string;
  attrs: Record<string, string>;
  ownText: string;
  kids: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  clicks = 0;
  focused = false;
  events: Array<{ type: string; key?: string }> = [];
  onclick: (() => void) | null = null;
  constructor(tag: string, attrs: Record<string, string> = {}, kids: FakeEl[] = [], ownText = '') {
    this.tag = tag; this.attrs = attrs; this.ownText = ownText;
    kids.forEach((k) => this.append(k));
  }
  append(k: FakeEl): FakeEl { k.parentElement = this; this.kids.push(k); return k; }
  get childElementCount(): number { return this.kids.length; }
  get textContent(): string { return this.ownText + this.kids.map((k) => k.textContent).join(''); }
  set textContent(v: string) { this.ownText = v; this.kids = []; }
  getAttribute(n: string): string | null { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n: string, v: string): void { this.attrs[n] = v; }
  removeAttribute(n: string): void { delete this.attrs[n]; }
  hasAttribute(n: string): boolean { return n in this.attrs; }
  all(): FakeEl[] { const out: FakeEl[] = []; const w = (e: FakeEl) => e.kids.forEach((k) => { out.push(k); w(k); }); w(this); return out; }
  querySelector(sel: string): FakeEl | null { return this.all().find(compile(sel)) || null; }
  querySelectorAll(sel: string): FakeEl[] { return this.all().filter(compile(sel)); }
  click(): void { this.clicks++; this.onclick?.(); }
  focus(): void { this.focused = true; doc.active = this; }
  dispatchEvent(e: { type: string; key?: string }): boolean { this.events.push({ type: e.type, key: e.key }); return true; }
}

const doc = {
  root: new FakeEl('html'),
  active: null as FakeEl | null,
  inserted: [] as string[],
  execCommandWorks: true,
  querySelector(sel: string) { return this.root.querySelector(sel); },
  querySelectorAll(sel: string) { return this.root.querySelectorAll(sel); },
  execCommand(cmd: string, _ui?: boolean, value?: string): boolean {
    if (cmd !== 'insertText' || !this.execCommandWorks || !this.active) return false;
    this.inserted.push(value ?? '');
    this.active.textContent = value ?? '';
    return true;
  },
};
(globalThis as any).document = doc;
class FakeEvent { type: string; key?: string; constructor(type: string, init: { key?: string } = {}) { this.type = type; this.key = init.key; } }
(globalThis as any).Event = FakeEvent;
(globalThis as any).InputEvent = FakeEvent;
(globalThis as any).KeyboardEvent = FakeEvent;

const body = (text: string) => new FakeEl('div', { 'data-tid': 'messageBodyContent' }, [], text);
const message = (sender: string, text: string) =>
  new FakeEl('div', { 'data-tid': 'chat-pane-message' }, [new FakeEl('span', { 'data-tid': 'message-author-name' }, [], sender), body(text)]);

/** Build the fixture: a control bar with the chat toggle, and (when open) the panel with the list
 *  and the composer row. `renders` says whether a sent line shows in the list. */
function fixture(opts: { open: boolean; sendButton?: boolean; renders?: boolean; history?: string[]; pressed?: boolean }) {
  doc.root = new FakeEl('html');
  doc.active = null;
  doc.inserted = [];
  const toggle = new FakeEl('button', { id: 'chat-button', 'aria-label': 'Chat', ...(opts.pressed ? { 'aria-pressed': 'true' } : {}) });
  const bar = new FakeEl('div', { role: 'toolbar' }, [toggle, new FakeEl('button', { id: 'microphone-button', 'aria-label': 'Mic' })]);
  doc.root.append(bar);
  const list = new FakeEl('div', { 'data-tid': 'message-pane-list-runway' }, (opts.history || []).map((t) => message('Anna Schmidt', t)));
  const composer = new FakeEl('div', { 'data-tid': 'ckeditor', contenteditable: 'true', role: 'textbox', 'aria-label': 'Type a message' });
  const row = new FakeEl('div', { 'data-tid': 'compose-row' }, [new FakeEl('div', {}, [composer])]);
  const send = new FakeEl('button', { 'data-tid': 'newMessageCommands-send', 'aria-label': 'Send' });
  if (opts.sendButton !== false) row.append(send);
  const panel = new FakeEl('div', { 'data-tid': 'chat-pane' }, [list, row]);
  const post = () => { if (opts.renders !== false) list.append(message('Vexa Bot', composer.textContent)); };
  send.onclick = post;
  const origDispatch = composer.dispatchEvent.bind(composer);
  composer.dispatchEvent = (e) => { const r = origDispatch(e); if (e.type === 'keydown' && e.key === 'Enter') post(); return r; };
  if (opts.open) doc.root.append(panel);
  toggle.onclick = () => { if (!panel.parentElement) doc.root.append(panel); };
  return { toggle, composer, send, list, panel };
}

const log: string[] = [];
const logFn = (m: string) => log.push(m);

// 1. Open panel, send button present: insertText + click, landed.
{
  const f = fixture({ open: true });
  const r = await sendTeamsChatMessage('Quorum is taking notes', { log: logFn, landWaitMs: 50 });
  check('send: ok once the line shows in the list', r.ok === true, JSON.stringify(r));
  check('send: text went in through insertText on the focused composer',
    f.composer.focused && JSON.stringify(doc.inserted) === '["Quorum is taking notes"]', JSON.stringify(doc.inserted));
  check('send: the row\'s send button was clicked once', f.send.clicks === 1, String(f.send.clicks));
  check('send: the control-bar toggle was not touched when the panel was open', f.toggle.clicks === 0);
}

// 2. Closed panel: the toggle opens it, then the send goes out.
{
  const f = fixture({ open: false });
  const r = await sendTeamsChatMessage('opened first', { landWaitMs: 50, waitMs: 300 });
  check('closed panel: the toggle is clicked to open it', f.toggle.clicks === 1, String(f.toggle.clicks));
  check('closed panel: the send then lands', r.ok === true, JSON.stringify(r));
}

// 3. A pressed toggle (panel still mounting) is not clicked.
{
  const f = fixture({ open: false, pressed: true });
  const r = await sendTeamsChatMessage('mounting', { landWaitMs: 50, waitMs: 150 });
  check('pressed toggle: not clicked (it would close the panel)', f.toggle.clicks === 0, String(f.toggle.clicks));
  check('pressed toggle with no composer yet: no_composer', !r.ok && r.reason === 'no_composer', JSON.stringify(r));
}

// 4. No send button in the row: Enter on the composer.
{
  const f = fixture({ open: true, sendButton: false });
  const r = await sendTeamsChatMessage('enter path', { landWaitMs: 50 });
  check('no send button: Enter is pressed on the composer',
    f.composer.events.some((e) => e.type === 'keydown' && e.key === 'Enter'), JSON.stringify(f.composer.events));
  check('no send button: the line lands', r.ok === true, JSON.stringify(r));
}

// 5. A line that never shows is not_landed, never ok.
{
  fixture({ open: true, renders: false });
  const r = await sendTeamsChatMessage('lost line', { landWaitMs: 50 });
  check('never rendered: not_landed', !r.ok && r.reason === 'not_landed', JSON.stringify(r));
}

// 6. The same words already in the list are not mistaken for the new line.
{
  fixture({ open: true, renders: false, history: ['hello'] });
  check('baseline: one existing line reads "hello"', countTeamsChatLines('hello') === 1);
  const r = await sendTeamsChatMessage('hello', { landWaitMs: 50 });
  check('repeat of an earlier line that never rendered: not_landed', !r.ok && r.reason === 'not_landed', JSON.stringify(r));
}

// 7. No composer at all, no toggle: no_composer. Blank text: empty_text with the page untouched.
{
  doc.root = new FakeEl('html');
  const r = await sendTeamsChatMessage('nowhere', { waitMs: 50, landWaitMs: 50 });
  check('no composer and no toggle: no_composer', !r.ok && r.reason === 'no_composer', JSON.stringify(r));
  const f = fixture({ open: true });
  const blank = await sendTeamsChatMessage('   ', { landWaitMs: 50 });
  check('blank text: empty_text', !blank.ok && blank.reason === 'empty_text', JSON.stringify(blank));
  check('blank text: the composer was not touched', !f.composer.focused && f.send.clicks === 0);
}

// 8. Fallback when execCommand refuses: the text still reaches the composer.
{
  const f = fixture({ open: true });
  doc.execCommandWorks = false;
  const r = await sendTeamsChatMessage('no execCommand', { landWaitMs: 50 });
  doc.execCommandWorks = true;
  check('execCommand refused: input events fired and the text set', r.ok === true
    && f.composer.events.some((e) => e.type === 'beforeinput') && f.composer.events.some((e) => e.type === 'input'),
  JSON.stringify(f.composer.events));
}

// 9. Trusted path: marks on composer + send, stale marks cleared, landing check by baseline.
{
  const f = fixture({ open: true });
  const stale = new FakeEl('div', { [TEAMS_CHAT_COMPOSER_MARK]: '1' });
  doc.root.append(stale);
  const p = await prepareTeamsChatSend('trusted line', { log: logFn });
  check('prepare: composer found by data-tid', p.composer === '[data-tid="ckeditor"][contenteditable="true"]', JSON.stringify(p));
  check('prepare: send button found in the composer\'s row', p.send === '[data-tid="newMessageCommands-send"]', JSON.stringify(p));
  check('prepare: composer and send carry the marks',
    f.composer.hasAttribute(TEAMS_CHAT_COMPOSER_MARK) && f.send.hasAttribute(TEAMS_CHAT_SEND_MARK));
  check('prepare: a stale mark elsewhere is cleared', !stale.hasAttribute(TEAMS_CHAT_COMPOSER_MARK));
  check('landed: false before the line shows', !(await awaitTeamsChatLanded('trusted line', p.before, 30)));
  f.composer.textContent = 'trusted line';
  f.send.click();
  check('landed: true once it shows', await awaitTeamsChatLanded('trusted line', p.before, 30));
}

console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ teams-chat-send: all checks passed');
process.exit(failed ? 1 : 0);
