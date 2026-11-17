/**
 * The trusted chat send on teams: the composer is a rich-text editor, so the driver clicks it and
 * inserts the text as keyboard input (never fill), checks the editor holds the text before it
 * presses send, and reports the step a failed send stopped at. The page-side helpers are stubbed
 * here (they are covered against a DOM fixture in @vexa/teams-capture); this pins the driver.
 * Run: npx tsx src/teams-chat-trusted.test.ts
 */
import { createChatSender, chatTypedText } from './capture-bridge.js';
import type { Invocation } from './config.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : ` (${detail})`}`);
  if (!cond) failed++;
};

const g = globalThis as unknown as Record<string, any>;
const inv = { platform: 'teams', botName: 'Vexa Bot', connectionId: 'test' } as unknown as Invocation;
const LONG = `Hi, I'm Betty Bee from the hive. I take notes, keep this meeting's transcript, and answer questions from what the hive knows: `
  + `its knowledge base and work items.\nSay my name to ask me something. Say "betty leave" and I'll buzz off.`;

interface Scene {
  /** Does the editor take keyboard input? */
  editorTakesTyping: boolean;
  /** Does the page-side sender get the text in and posted? */
  pageSide: { ok: true } | { ok: false; reason: string; step?: string };
  prepare?: { composer: string | null; send: string | null; before: number; step?: string };
}

function scene(sc: Scene) {
  const ops: string[] = [];
  let editor = '';
  const posted: string[] = [];
  g.VexaBrowserUtils = {
    prepareTeamsChatSend: async () => sc.prepare ?? { composer: '[data-tid="ckeditor"][contenteditable="true"]', send: '[data-tid="newMessageCommands-send"]', before: 0 },
    markedTeamsComposerHolds: (text: string) => editor.includes(text),
    awaitTeamsChatLanded: async (text: string) => posted.some((p) => p === chatTypedText(text)),
    sendTeamsChatMessage: async (text: string) => {
      ops.push('page-side');
      if (sc.pageSide.ok) { posted.push(chatTypedText(text)); return { ok: true, composer: 'c', send: 'click' }; }
      return sc.pageSide;
    },
  };
  const page = {
    async evaluate(fn: (arg: never) => unknown, arg?: unknown): Promise<unknown> { return fn(arg as never); },
    keyboard: {
      async press(k: string) { ops.push(`key ${k}`); if (k === 'Control+A') editor = sc.editorTakesTyping ? '' : editor; },
      async insertText(t: string) { ops.push(`insertText ${t.length}`); if (sc.editorTakesTyping) editor += t; },
    },
    locator(sel: string) {
      const handle = {
        async fill() { ops.push(`fill ${sel}`); throw new Error('locator.fill: Timeout 5000ms exceeded'); },
        async isEnabled() { return true; },
        async click() { ops.push(`click ${sel}`); if (sel === '[data-vexa-chat-send]' && editor) { posted.push(editor); editor = ''; } },
        async press(k: string) { ops.push(`press ${k}`); },
      };
      return { first: () => handle, count: async () => 1 };
    },
  } as never;
  return { page, ops, posted };
}

const logs: string[] = [];
const origLog = console.log, origErr = console.error;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try { return await fn(); } finally { console.log = origLog; console.error = origErr; }
};

// 1. The editor takes typing: click, select-all, insertText, send click; never fill.
{
  const s = scene({ editorTakesTyping: true, pageSide: { ok: false, reason: 'not_landed' } });
  const r = await quiet(() => createChatSender(s.page, inv, { landWaitMs: 20 }).send(LONG));
  check('teams trusted: the composer is clicked, the text inserted as keyboard input, then send is clicked',
    JSON.stringify(s.ops) === JSON.stringify([
      'click [data-vexa-chat-composer]', 'key Control+A', `insertText ${chatTypedText(LONG).length}`, 'click [data-vexa-chat-send]',
    ]), JSON.stringify(s.ops));
  check('teams trusted: fill is never used on the rich-text composer', !s.ops.some((o) => o.startsWith('fill')));
  check('teams trusted: a 230-char multi-line line is posted whole, as one paragraph',
    r.sent && s.posted.length === 1 && s.posted[0] === chatTypedText(LONG) && !s.posted[0].includes('\n'), JSON.stringify(s.posted));
  check('teams trusted: the outcome says how the text went in', r.sent && r.via.startsWith('trusted type + click'), JSON.stringify(r));
}

// 2. The editor takes no typing: send is NOT pressed; the page-side sender gets the line out.
{
  const s = scene({ editorTakesTyping: false, pageSide: { ok: true } });
  const r = await quiet(() => createChatSender(s.page, inv, { landWaitMs: 20 }).send('second way'));
  check('empty editor after typing: the send button is not clicked by the trusted path',
    !s.ops.includes('click [data-vexa-chat-send]') && s.ops[s.ops.length - 1] === 'page-side', JSON.stringify(s.ops));
  check('empty editor after typing: the page-side sender posts the line', r.sent && r.via.startsWith('page-side'), JSON.stringify(r));
  check('empty editor after typing: the log names the step', logs.some((l) => l.includes('step=composer_empty')), JSON.stringify(logs.slice(-4)));
}

// 3. Neither way gets the text in: failed with the wire reason and the step, send never pressed.
{
  logs.length = 0;
  const s = scene({ editorTakesTyping: false, pageSide: { ok: false, reason: 'not_landed', step: 'composer_empty' } });
  const r = await quiet(() => createChatSender(s.page, inv, { landWaitMs: 20 }).send('nowhere'));
  check('no way in: not_landed with step composer_empty', !r.sent && r.reason === 'not_landed' && r.step === 'composer_empty', JSON.stringify(r));
  check('no way in: the failure line carries reason and step',
    logs.some((l) => l.includes('chat_send_failed reason=not_landed step=composer_empty platform=teams chars=7')), JSON.stringify(logs));
  check('no way in: nothing was posted', s.posted.length === 0);
}

// 4. No composer: the step the page-side lookup stopped at is reported.
{
  logs.length = 0;
  const s = scene({ editorTakesTyping: true, pageSide: { ok: true }, prepare: { composer: null, send: null, before: 0, step: 'toggle_absent' } });
  const r = await quiet(() => createChatSender(s.page, inv, { landWaitMs: 20 }).send('no panel'));
  check('no composer: no_composer with the lookup step, nothing typed',
    !r.sent && r.reason === 'no_composer' && r.step === 'toggle_absent' && s.ops.length === 0, `${JSON.stringify(r)} ${JSON.stringify(s.ops)}`);
  check('no composer: the failure line carries the step', logs.some((l) => l.includes('reason=no_composer step=toggle_absent')), JSON.stringify(logs));
}

check('typed text: line breaks become single spaces', chatTypedText(' a\r\n\n b \n c ') === 'a b c');

console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ teams-chat-trusted: all checks passed');
process.exit(failed ? 1 : 0);
