/**
 * MS Teams chat reader — SHARED browser module (bot + extension), mirror of
 * zoom-chat.ts. Watches the Teams chat / meeting-chat panel and emits each new
 * message as { sender, text }. The extension wraps these into capture.v1 `chat`
 * MeetingEvents (kind:'chat', speaker:sender, text). Pure DOM observation — no
 * audio, no network.
 *
 * Teams' DOM is data-tid-driven but changes across builds, so extraction is
 * defensive: candidate container/message/sender/body selectors, plus a heuristic
 * fallback (largest leaf text = body, short text = sender). The chat panel must
 * be OPEN for messages to be in the DOM. getState() surfaces what matched + a
 * structural dump so selectors can be tuned from live telemetry.
 */

export interface TeamsChatMessage { sender: string; text: string }

export interface TeamsChatOptions {
  log?: (m: string) => void;
  onMessage: (msg: TeamsChatMessage) => void;
  /** The bot's display name: lines Teams attributes to it are its own and are not emitted. */
  selfName?: string;
  /** Open the chat panel when no message list is mounted, and re-open it if it closes (the bot's
   *  reader; the extension leaves the user's UI alone). */
  keepOpen?: boolean;
}

/** How often the reader looks for the message list (and, with keepOpen, re-opens the panel). */
export const TEAMS_CHAT_READER_POLL_MS = 2000;
/** Least time between two panel-open clicks by the reader, so a slow mount is not toggled shut. */
export const TEAMS_CHAT_REOPEN_MS = 10000;
/** Characters of a message body the reader's log line shows. */
const TEAMS_CHAT_LOG_CHARS = 40;
/** How long a line the bot sent is recognised as its own when it shows in the list. */
const TEAMS_RECENT_SENT_TTL_MS = 120000;

const recentSent = new Map<string, number>();
const sentKey = (t: string): string => t.replace(/\s+/g, ' ').trim();
/** Remember a line the bot is sending, so the reader does not deliver it back as a participant's. */
export function rememberTeamsChatSent(text: string): void {
  const now = Date.now();
  for (const [t, at] of recentSent) if (now - at > TEAMS_RECENT_SENT_TTL_MS) recentSent.delete(t);
  recentSent.set(sentKey(text), now);
}
/** True (once) when `text` is a line the bot sent within the TTL. */
function takeTeamsChatSent(text: string): boolean {
  const k = sentKey(text);
  const at = recentSent.get(k);
  if (at === undefined) return false;
  recentSent.delete(k);
  return Date.now() - at <= TEAMS_RECENT_SENT_TTL_MS;
}

export interface TeamsChat {
  destroy(): void;
  getState(): {
    matchedContainer: string | null;
    seen: number;
    recent: TeamsChatMessage[];
    candidates: Array<{ sel: string; count: number }>;
    sample: { sel: string; structure: string[] } | null;
  };
}

// Candidate selectors, most-specific first. Teams has used several over builds.
const CONTAINER_SELECTORS = [
  '[data-tid="chat-pane-list"]',
  '[data-tid="message-pane-list-runway"]',
  '[data-tid="chatPaneMessageList"]',
  '[role="log"]',
  '[aria-label*="Chat messages"]',
  '[class*="chat-pane-list"]',
  '[class*="messageList"]',
];
const MESSAGE_SELECTORS = [
  '[data-tid="chat-pane-message"]',
  'div[data-tid^="chat-pane-message"]',
  'div[data-mid]',
  '[data-tid="message"]',
  '[class*="chat-message"]',
  '[role="listitem"]',
];
const SENDER_SELECTORS = [
  '[data-tid="message-author-name"]',
  '[data-tid*="author"]',
  '[class*="author-name"]',
  '[class*="authorName"]',
  '[class*="sender"]',
  '[class*="display-name"]',
];
const TEXT_SELECTORS = [
  '[data-tid="messageBodyContent"]',
  '[id^="content-"]',
  '[class*="messageBody"]',
  '[class*="message-body"]',
  '[class*="messageText"]',
  'div[dir="auto"]',
];

export function createTeamsChat(opts: TeamsChatOptions): TeamsChat {
  const log = opts.log || (() => {});
  const selfName = (opts.selfName || '').trim().toLowerCase();
  let lastOpen = 0;
  const seenNodes = new WeakSet<Element>();
  const seenHashes = new Set<string>();
  const recent: TeamsChatMessage[] = [];
  let matchedContainer: string | null = null;
  let container: Element | null = null;

  const firstText = (root: Element, selectors: string[]): string => {
    for (const s of selectors) {
      const el = root.querySelector(s);
      const t = el?.textContent?.trim();
      if (t) return t;
    }
    return '';
  };

  const senderFromAria = (node: Element): string => {
    // Teams labels message rows like "Barbara W, 10:42 AM, Hi there".
    let cur: Element | null = node;
    for (let i = 0; i < 4 && cur; i++, cur = cur.parentElement) {
      const al = cur.getAttribute?.('aria-label') || '';
      const m = al.match(/^(.+?)\s*,\s*\d{1,2}:\d{2}/);
      if (m && m[1].trim()) return m[1].trim();
    }
    return '';
  };

  const extract = (node: Element): TeamsChatMessage | null => {
    let text = firstText(node, TEXT_SELECTORS);
    let sender = firstText(node, SENDER_SELECTORS);

    // Sender is grouped: Teams shows one header for a run of messages from the
    // same person. Climb ancestors (the group wrapper carries the header), then
    // fall back to the row's aria-label.
    if (!sender) {
      let cur: Element | null = node.parentElement;
      for (let i = 0; i < 4 && cur && !sender; i++, cur = cur.parentElement) sender = firstText(cur, SENDER_SELECTORS);
    }
    if (!sender) sender = senderFromAria(node);

    // Body fallback: largest leaf text in the node.
    if (!text) {
      const frags = Array.from(node.querySelectorAll('*'))
        .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
        .filter((t) => t.length > 0);
      if (!frags.length) return null;
      const longest = frags.reduce((a, b) => (b.length > a.length ? b : a), '');
      text = longest;
      if (!sender) {
        const shortName = frags.find((f) => f !== longest && f.length <= 40 && !/^\d{1,2}:\d{2}/.test(f));
        if (shortName) sender = shortName;
      }
    }
    // Strip a trailing timestamp Teams appends to the sender row ("Name 10:42 AM").
    sender = sender.replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*$/i, '').trim() || 'Unknown';
    if (!text) return null;
    return { sender, text };
  };

  // Structural dump of one message node so selectors can be tuned against the
  // real (changing) Teams DOM.
  const dumpNode = (node: Element): string[] =>
    Array.from(node.querySelectorAll('*')).slice(0, 25).map((e) => {
      const cls = (e.getAttribute('class') || '').slice(0, 40);
      const tid = e.getAttribute('data-tid');
      const aria = e.getAttribute('aria-label');
      const t = e.childElementCount === 0 ? (e.textContent || '').trim().slice(0, 30) : '';
      return `${e.tagName.toLowerCase()}${tid ? '[tid=' + tid + ']' : ''}${cls ? '.' + cls : ''}${aria ? '[al=' + aria.slice(0, 30) + ']' : ''}${t ? ' »' + t : ''}`;
    });

  const emit = (node: Element) => {
    if (seenNodes.has(node)) return;
    seenNodes.add(node);
    const msg = extract(node);
    if (!msg) return;
    const hash = `${msg.sender} ${msg.text}`;
    if (seenHashes.has(hash)) return; // virtualized list re-renders the same item on scroll
    seenHashes.add(hash);
    if (takeTeamsChatSent(msg.text) || (selfName && msg.sender.trim().toLowerCase() === selfName)) {
      log(`chat (own line, not delivered): ${msg.text.slice(0, TEAMS_CHAT_LOG_CHARS)}`);
      return;
    }
    recent.push(msg);
    if (recent.length > 30) recent.shift();
    log(`chat ${msg.sender}: ${msg.text.slice(0, TEAMS_CHAT_LOG_CHARS)}`);
    try { opts.onMessage(msg); } catch { /* never break capture */ }
  };

  const scanMessages = (root: ParentNode) => {
    for (const sel of MESSAGE_SELECTORS) {
      const nodes = root.querySelectorAll(sel);
      if (nodes.length) { nodes.forEach((n) => emit(n)); return; }
    }
  };

  const findContainer = (): Element | null => {
    for (const sel of CONTAINER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) { matchedContainer = sel; return el; }
    }
    return null;
  };

  // The chat panel mounts/unmounts as the user toggles it — poll for the
  // container, (re)attach the observer, rescan existing messages.
  const observer = new MutationObserver(() => { if (container) scanMessages(container); });
  const attach = () => {
    const found = findContainer();
    if (!found && opts.keepOpen && Date.now() - lastOpen >= TEAMS_CHAT_REOPEN_MS && !findTeamsChatComposer()) {
      const toggle = findTeamsChatToggle();
      if (toggle && toggle.el.getAttribute('aria-pressed') !== 'true' && clickTeamsChatToggle(toggle.el, TEAMS_CHAT_TOGGLE_RECLICK_MS)) {
        lastOpen = Date.now();
        log(`chat panel ${container ? 're-opened' : 'opened'} via ${toggle.via}`);
      }
    }
    if (found && found !== container) {
      container = found;
      observer.disconnect();
      observer.observe(container, { childList: true, subtree: true });
      scanMessages(container);
      log(`chat container matched: ${matchedContainer}`);
    } else if (found) {
      scanMessages(container!);
    }
  };
  attach();
  const poll = window.setInterval(attach, TEAMS_CHAT_READER_POLL_MS);

  return {
    destroy() { window.clearInterval(poll); observer.disconnect(); },
    getState() {
      let sample: { sel: string; structure: string[] } | null = null;
      if (container) {
        for (const sel of MESSAGE_SELECTORS) {
          const n = container.querySelector(sel);
          if (n) { sample = { sel, structure: dumpNode(n) }; break; }
        }
      }
      return {
        matchedContainer,
        seen: seenHashes.size,
        recent: recent.slice(-10),
        candidates: CONTAINER_SELECTORS.map((sel) => ({ sel, count: document.querySelectorAll(sel).length })),
        sample,
      };
    },
  };
}

// ── Chat SEND (acts.v1 `chat_send` on teams) ──────────────────────────────────────────────────
//
// The bot writes a line into the meeting chat the way a participant does: open the chat panel when
// it is closed, find the composer (Teams' rich-text editor, a contenteditable — never an <input>),
// put the text in, press the send button of the composer's own row (or Enter), and count the send
// only once a message body reading exactly that text shows in the message list. Two drivers share
// these primitives: the bot's TRUSTED path (prepareTeamsChatSend marks the composer and the send
// button, Playwright fills and clicks them, awaitTeamsChatLanded checks the landing) and the
// page-side fallback (sendTeamsChatMessage: insertText + click / synthetic Enter).

/** The chat panel toggle in the meeting's control bar, most-specific first. */
export const teamsChatToggleSelectors: string[] = [
  '#chat-button',
  '[data-tid="chat-button"]',
  'button[data-inp="chat-button"]',
  '[data-tid="toggle-chat"]',
  // Guest / anonymous (light-meetings) control bars carry no stable id: match the button's label.
  'button[aria-label="Chat" i]',
  'button[aria-label^="Show conversation" i]',
  'button[aria-label^="Open chat" i]',
];

/** The chat composer: Teams' editor, most-specific first. Only shown, editable fields count. */
export const teamsChatComposerSelectors: string[] = [
  '[data-tid="ckeditor"][contenteditable="true"]',
  '[data-tid="ckeditor-replyConversation"][contenteditable="true"]',
  // Other editor variants (guest join, new compose box) keep the ckeditor prefix.
  '[data-tid^="ckeditor"][contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][aria-label*="message" i]',
];

/** The send button, looked for in the composer's own row, most-specific first. */
export const teamsChatSendSelectors: string[] = [
  '[data-tid="newMessageCommands-send"]',
  'button[name="send"]',
  'button[data-tid*="send" i]',
  'button[aria-label*="send" i]',
];

/** Attributes the bot's trusted-input path addresses the composer and the send button by (the same
 *  names the Meet sender marks, so one Playwright driver serves both). */
export const TEAMS_CHAT_COMPOSER_MARK = 'data-vexa-chat-composer';
export const TEAMS_CHAT_SEND_MARK = 'data-vexa-chat-send';

export type TeamsChatSendFailure = 'no_composer' | 'not_landed' | 'empty_text';
export type TeamsChatSendResult =
  | { ok: true; composer: string; send: string }
  | { ok: false; reason: TeamsChatSendFailure };

interface TeamsChatHit { el: HTMLElement; via: string }

const normalizeLine = (t: string): string => t.replace(/\s+/g, ' ').trim();

const teamsIsShown = (el: Element): boolean => {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur.hasAttribute('hidden') || cur.getAttribute('aria-hidden') === 'true') return false;
  }
  return true;
};

const teamsIsDisabled = (el: Element): boolean =>
  el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';

/** The visible chat composer, or null when the panel is closed. */
export function findTeamsChatComposer(): TeamsChatHit | null {
  for (const sel of teamsChatComposerSelectors) {
    const el = Array.from(document.querySelectorAll(sel)).find((e) => teamsIsShown(e) && !teamsIsDisabled(e));
    if (el) return { el: el as HTMLElement, via: sel };
  }
  return null;
}

/** The send button of `composer`'s own row: climb from the composer to the nearest ancestor holding
 *  a matching button. Searching outward from the composer keeps the meeting toolbar out of reach.
 *  null means "press Enter". */
export function findTeamsChatSendButton(composer: Element): TeamsChatHit | null {
  for (let cur: Element | null = composer.parentElement, i = 0; cur && i < 6; cur = cur.parentElement, i++) {
    for (const sel of teamsChatSendSelectors) {
      const el = cur.querySelector(sel);
      if (el && teamsIsShown(el)) return { el: el as HTMLElement, via: sel };
    }
  }
  return null;
}

/** The chat panel toggle, or null. */
export function findTeamsChatToggle(): TeamsChatHit | null {
  for (const sel of teamsChatToggleSelectors) {
    const el = document.querySelector(sel);
    if (el) return { el: el as HTMLElement, via: sel };
  }
  return null;
}

/** Open the chat panel when it is closed. True when the composer is already there or a toggle was
 *  clicked; false when neither is in the DOM. A toggle that says it is pressed is not clicked (that
 *  would close a panel that is still mounting). */
export function openTeamsChatPanel(): boolean {
  if (findTeamsChatComposer()) return true;
  const toggle = findTeamsChatToggle();
  if (!toggle) return false;
  if (toggle.el.getAttribute('aria-pressed') === 'true') return true;
  toggle.el.click();
  return true;
}

/** How long a send waits for the composer by default. Right after admission Teams is still
 *  rendering the meeting shell: the control bar (and its chat toggle) can take several seconds to
 *  mount, and the panel a moment more once opened. */
export const TEAMS_CHAT_COMPOSER_WAIT_MS = 10000;
/** When each toggle element was last clicked by the reader or a send, so the two never click the
 *  same toggle within `gapMs` of each other (a second click would close the panel the first one
 *  is opening). */
const toggleClickedAt = new WeakMap<Element, number>();
function clickTeamsChatToggle(el: HTMLElement, gapMs: number): boolean {
  const now = Date.now();
  const last = toggleClickedAt.get(el);
  if (last !== undefined && now - last < gapMs) return false;
  toggleClickedAt.set(el, now);
  el.click();
  return true;
}

/** How often the wait re-reads the DOM. */
const TEAMS_CHAT_POLL_MS = 100;
/** Most times one wait clicks a chat toggle (a re-rendered toggle may swallow the first click). */
const TEAMS_CHAT_MAX_TOGGLE_CLICKS = 2;
/** Least time between two toggle clicks, so a panel that is still mounting is not closed again. */
const TEAMS_CHAT_TOGGLE_RECLICK_MS = 3000;

const teamsSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait (bounded by `waitMs`) for a visible, editable composer. The panel is opened when a toggle
 *  shows up, even one that mounts late (the control bar right after admission); a pressed toggle is
 *  never clicked; a toggle is clicked again only once, after TEAMS_CHAT_TOGGLE_RECLICK_MS, when the
 *  first click did not bring the composer (the bar re-rendered under it). */
async function awaitTeamsComposer(waitMs: number, log: (m: string) => void = () => {}): Promise<TeamsChatHit | null> {
  const start = Date.now();
  const deadline = start + waitMs;
  let clicks = 0;
  let lastClick = 0;
  for (;;) {
    const composer = findTeamsChatComposer();
    if (composer) {
      if (clicks || Date.now() - start >= TEAMS_CHAT_POLL_MS) log(`chat send: composer ready after ${Date.now() - start} ms (${clicks} toggle click(s))`);
      return composer;
    }
    const toggle = findTeamsChatToggle();
    const now = Date.now();
    if (toggle && toggle.el.getAttribute('aria-pressed') !== 'true' && clicks < TEAMS_CHAT_MAX_TOGGLE_CLICKS
      && (clicks === 0 || now - lastClick >= TEAMS_CHAT_TOGGLE_RECLICK_MS)
      && clickTeamsChatToggle(toggle.el, TEAMS_CHAT_TOGGLE_RECLICK_MS)) {
      clicks += 1;
      lastClick = now;
    }
    if (now >= deadline) {
      log(`chat send: no composer after ${now - start} ms (toggle ${toggle ? `via ${toggle.via}` : 'absent'}, ${clicks} click(s))`);
      return null;
    }
    await teamsSleep(Math.min(TEAMS_CHAT_POLL_MS, Math.max(1, deadline - now)));
  }
}

/** The texts of the message bodies in the chat list (the matched list, else the whole page). */
function teamsChatLines(): string[] {
  let root: ParentNode = document;
  for (const sel of CONTAINER_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) { root = el; break; }
  }
  for (const sel of TEXT_SELECTORS) {
    const nodes = Array.from(root.querySelectorAll(sel));
    if (nodes.length) return nodes.map((n) => normalizeLine(n.textContent || ''));
  }
  return [];
}

/** How many message bodies read exactly `text` now: the baseline a landing check compares against,
 *  so a repeat of an earlier line is told apart from the new one. */
export function countTeamsChatLines(text: string): number {
  const want = normalizeLine(text);
  return teamsChatLines().filter((t) => t === want).length;
}

/** Wait (up to `waitMs`) for one more message body reading `text` than `before`. */
export async function awaitTeamsChatLanded(text: string, before: number, waitMs = 8000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (countTeamsChatLines(text) > before) return true;
    if (Date.now() >= deadline) return false;
    await teamsSleep(Math.min(150, Math.max(1, deadline - Date.now())));
  }
}

/** Prepare a TRUSTED send driven from outside the page (Playwright fill + click / Enter): open the
 *  panel, find the composer and its send button, mark them, and return which selector found each
 *  (null when absent) plus `before` for awaitTeamsChatLanded. */
export async function prepareTeamsChatSend(
  text: string,
  opts: { log?: (m: string) => void; waitMs?: number } = {},
): Promise<{ composer: string | null; send: string | null; before: number }> {
  const log = opts.log || (() => {});
  for (const m of Array.from(document.querySelectorAll(`[${TEAMS_CHAT_COMPOSER_MARK}], [${TEAMS_CHAT_SEND_MARK}]`))) {
    m.removeAttribute(TEAMS_CHAT_COMPOSER_MARK);
    m.removeAttribute(TEAMS_CHAT_SEND_MARK);
  }
  const composer = await awaitTeamsComposer(opts.waitMs ?? TEAMS_CHAT_COMPOSER_WAIT_MS, log);
  if (!composer) { log('chat send: no visible Teams chat composer (panel would not open)'); return { composer: null, send: null, before: 0 }; }
  composer.el.setAttribute(TEAMS_CHAT_COMPOSER_MARK, '1');
  const send = findTeamsChatSendButton(composer.el);
  if (send) send.el.setAttribute(TEAMS_CHAT_SEND_MARK, '1');
  rememberTeamsChatSent(text);
  const before = countTeamsChatLines(text);
  log(`chat send: composer via ${composer.via}, send button via ${send?.via ?? 'none (Enter)'}`);
  return { composer: composer.via, send: send?.via ?? null, before };
}

/** Put `text` into a contenteditable composer through the editor's own input path (insertText),
 *  which rich editors observe; value assignment would be ignored. */
function insertTeamsText(el: HTMLElement, text: string): void {
  el.focus();
  const doc = document as Document & { execCommand?: (c: string, u?: boolean, v?: string) => boolean };
  let inserted = false;
  try { inserted = !!doc.execCommand?.('insertText', false, text); } catch { inserted = false; }
  if (!inserted) {
    const fire = (type: string, cancelable: boolean) => el.dispatchEvent(typeof InputEvent === 'function'
      ? new InputEvent(type, { inputType: 'insertText', data: text, bubbles: true, cancelable })
      : new Event(type, { bubbles: true, cancelable }));
    fire('beforeinput', true);
    el.textContent = text;
    fire('input', false);
  }
}

/** Write `text` into the Teams meeting chat from INSIDE the page: open the panel if needed, insert
 *  the text, click the row's send button, else press Enter, then wait (up to `landWaitMs`) for the
 *  line to show in the message list. ok only once it does. */
export async function sendTeamsChatMessage(
  text: string,
  opts: { log?: (m: string) => void; waitMs?: number; landWaitMs?: number } = {},
): Promise<TeamsChatSendResult> {
  const log = opts.log || (() => {});
  if (!normalizeLine(text)) return { ok: false, reason: 'empty_text' };
  const composer = await awaitTeamsComposer(opts.waitMs ?? TEAMS_CHAT_COMPOSER_WAIT_MS, log);
  if (!composer) { log('chat send: no visible Teams chat composer'); return { ok: false, reason: 'no_composer' }; }
  const before = countTeamsChatLines(text);
  rememberTeamsChatSent(text);
  insertTeamsText(composer.el, text);
  const send = findTeamsChatSendButton(composer.el);
  let how: string;
  if (send && !teamsIsDisabled(send.el)) {
    send.el.click();
    how = `click (${send.via})`;
  } else {
    const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    for (const type of ['keydown', 'keyup']) {
      composer.el.dispatchEvent(typeof KeyboardEvent === 'function' ? new KeyboardEvent(type, key) : new Event(type, key));
    }
    how = 'Enter';
  }
  if (await awaitTeamsChatLanded(text, before, opts.landWaitMs ?? 8000)) {
    log(`chat send: sent via ${how}, composer via ${composer.via}`);
    return { ok: true, composer: composer.via, send: how };
  }
  log(`chat send: ${how} — the line did not show in the message list`);
  return { ok: false, reason: 'not_landed' };
}
