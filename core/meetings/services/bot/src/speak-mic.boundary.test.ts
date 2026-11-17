/**
 * Speak-path mic gate, in a real headless Chromium: a line is played only once the meeting-UI mic
 * is CONFIRMED open from the control's own state, and fails `mic_muted` (unplayed) otherwise.
 *
 *   1. Teams: a mic button that reads "Unmute mic" is clicked open, verified, then the line plays.
 *   2. Teams: a mic that is already open is not toggled (a blind toggle would mute it).
 *   3. Teams: a mic that stays muted fails `mic_muted` and TTS never runs.
 *   4. Meet: "Turn on microphone" is muted; one click opens it; the line plays.
 *   5. Zoom: "unmute my microphone" is muted; one click opens it; the line plays.
 *   6. No readable control: the line is refused, never played blind.
 *   7. Concurrent lines play strictly one after another, each reporting its durationMs.
 *   8. speak_stop drops every line still queued.
 *   9. prepare() opens the mic when the bot is admitted, so the first line toggles nothing and its
 *      mic check is one read (milliseconds); a control drawn late is waited for.
 *  10. A toggle is confirmed as soon as the control reads open, not after a fixed wait.
 *  11. The line's timing (queue, mic, first audio, synthesis, cached) is reported; idle() resolves
 *      once the queue is empty.
 *
 * Where headless Chromium cannot launch the test SKIPs (exit 0), like the other boundary tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPersistentBrowser, type BrowserContext } from '@vexa/remote-browser';
import { createSpeakController } from './capture-bridge.js';
import type { Invocation } from './config.js';

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
};

/** A mic button whose label flips on click (or never flips, when `stuck`). */
const micPage = (attrs: { id?: string; muted: string; unmuted: string; startMuted: boolean; stuck?: boolean }): string => `
<!doctype html><html><body>
<button ${attrs.id ? `id="${attrs.id}"` : ''} aria-label="${attrs.startMuted ? attrs.muted : attrs.unmuted}">mic</button>
<script>(() => {
  window.__clicks = 0;
  const b = document.querySelector('button');
  b.addEventListener('click', () => {
    window.__clicks++;
    if (${attrs.stuck ? 'true' : 'false'}) return;
    b.setAttribute('aria-label', b.getAttribute('aria-label') === ${JSON.stringify(attrs.muted)} ? ${JSON.stringify(attrs.unmuted)} : ${JSON.stringify(attrs.muted)});
  });
})();</script></body></html>`;

const inv = (platform: string): Invocation => ({ platform, voiceAgentEnabled: true } as unknown as Invocation);

const fakeTts = (): { spoken: string[]; speak(text: string): Promise<void>; stop(): void } => {
  const spoken: string[] = [];
  return { spoken, async speak(text: string) { spoken.push(text); }, stop() { /* */ } };
};

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'vexa-speak-mic-'));
  let context: BrowserContext;
  let page: any;
  try {
    ({ context, page } = await launchPersistentBrowser({ dataDir, args: ['--no-sandbox', '--mute-audio'], headless: true }));
  } catch (e) {
    console.log(`  ⚠️ SKIP — headless Chromium unavailable in this environment: ${(e as Error).message?.split('\n')[0]}`);
    process.exit(0);
  }
  try {
    const run = async (platform: string, html: string) => {
      await page.setContent(html);
      const tts = fakeTts();
      const result = await createSpeakController(page, inv(platform), tts).speak('hello room');
      const clicks = await page.evaluate(() => (globalThis as any).__clicks);
      const label = await page.evaluate(() => (globalThis as any).document.querySelector('button')?.getAttribute('aria-label'));
      return { result, clicks, label, spoken: tts.spoken };
    };

    let r = await run('teams', micPage({ id: 'microphone-button', muted: 'Unmute mic', unmuted: 'Mute mic', startMuted: true }));
    check('Teams: a muted mic is opened, verified, then the line plays',
      r.result.spoken === true && r.clicks === 1 && r.label === 'Mute mic' && r.spoken.length === 1, JSON.stringify(r));

    r = await run('teams', micPage({ id: 'microphone-button', muted: 'Unmute mic', unmuted: 'Mute mic', startMuted: false }));
    check('Teams: an open mic is not toggled shut',
      r.result.spoken === true && r.clicks === 0 && r.label === 'Mute mic', JSON.stringify(r));

    r = await run('teams', micPage({ id: 'microphone-button', muted: 'Unmute mic', unmuted: 'Mute mic', startMuted: true, stuck: true }));
    check('Teams: a mic that stays muted fails mic_muted and plays nothing',
      r.result.spoken === false && (r.result as any).reason === 'mic_muted' && r.spoken.length === 0, JSON.stringify(r));

    r = await run('google_meet', micPage({ muted: 'Turn on microphone (ctrl + d)', unmuted: 'Turn off microphone (ctrl + d)', startMuted: true }));
    check('Meet: "Turn on microphone" is opened, then the line plays',
      r.result.spoken === true && r.clicks === 1 && r.spoken.length === 1, JSON.stringify(r));

    r = await run('zoom', micPage({ muted: 'unmute my microphone', unmuted: 'mute my microphone', startMuted: true }));
    check('Zoom: "unmute my microphone" is opened, then the line plays',
      r.result.spoken === true && r.clicks === 1 && r.spoken.length === 1, JSON.stringify(r));

    await page.setContent('<!doctype html><html><body><p>no controls</p></body></html>');
    const tts = fakeTts();
    const none = await createSpeakController(page, inv('teams'), tts).speak('hello room');
    check('no readable mic control: the line is refused, never played blind',
      none.spoken === false && (none as any).reason === 'mic_muted' && tts.spoken.length === 0, JSON.stringify(none));

    // Strict serial playback: lines that arrive together never overlap, each resolves when it ends.
    await page.setContent(micPage({ id: 'microphone-button', muted: 'Unmute mic', unmuted: 'Mute mic', startMuted: false }));
    let playing = 0;
    let maxPlaying = 0;
    const order: string[] = [];
    let release: (() => void) | null = null;
    const slowTts = {
      async speak(text: string): Promise<number> {
        playing++; maxPlaying = Math.max(maxPlaying, playing); order.push(`start:${text}`);
        await new Promise<void>((resolve) => { release = resolve; setTimeout(resolve, 150); });
        playing--; order.push(`end:${text}`);
        return text.length * 10;
      },
      stop() { release?.(); },
    };
    const serial = createSpeakController(page, inv('teams'), slowTts);
    const [a, b, c] = await Promise.all([serial.speak('long intro'), serial.speak('one moment'), serial.speak('in chat')]);
    check('concurrent speak requests never play at the same time', maxPlaying === 1, JSON.stringify(order));
    check('queued lines play in arrival order',
      order.join(',') === 'start:long intro,end:long intro,start:one moment,end:one moment,start:in chat,end:in chat', JSON.stringify(order));
    check('each line reports the audio it played (durationMs)',
      (a as any).durationMs === 100 && (b as any).durationMs === 100 && (c as any).durationMs === 70, JSON.stringify([a, b, c]));

    // speak_stop drops every line still queued.
    order.length = 0;
    const first = serial.speak('first');
    const second = serial.speak('second');
    await new Promise((r) => setTimeout(r, 50));
    await serial.stop();
    const [f, g] = await Promise.all([first, second]);
    check('speak_stop drops the queued line', (g as any).reason === 'stopped' && !order.includes('start:second'),
      JSON.stringify({ f, g, order }));

    // prepare(): the mic is opened at join, and the first line then only reads it.
    await page.setContent(micPage({ muted: 'Turn on microphone (ctrl + d)', unmuted: 'Turn off microphone (ctrl + d)', startMuted: true }));
    const stats = { synthMs: 12, cached: false };
    const timedTts = {
      spoken: [] as string[],
      async speak(text: string, _voice?: string, hooks?: { onFirstAudio?: () => void; onLine?: (s: { synthMs: number; cached: boolean }) => void }): Promise<number> {
        await new Promise((r) => setTimeout(r, 30));
        hooks?.onFirstAudio?.();
        await new Promise((r) => setTimeout(r, 60));
        hooks?.onLine?.(stats);
        this.spoken.push(text);
        return 60;
      },
      stop() { /* */ },
    };
    const joined = createSpeakController(page, inv('google_meet'), timedTts);
    await joined.prepare();
    const afterPrepare = await page.evaluate(() => ({
      clicks: (globalThis as any).__clicks,
      label: (globalThis as any).document.querySelector('button')?.getAttribute('aria-label'),
    }));
    check('prepare opens the mic once at join', afterPrepare.clicks === 1 && /turn off/i.test(afterPrepare.label), JSON.stringify(afterPrepare));
    let firstAudio = -1;
    const line = await joined.speak('hello room', undefined, { onFirstAudio: (ms) => { firstAudio = ms; } });
    const clicksAfterLine = await page.evaluate(() => (globalThis as any).__clicks);
    const t = (line as any).timing;
    check('the first line after prepare toggles nothing', line.spoken === true && clicksAfterLine === 1, JSON.stringify({ line, clicksAfterLine }));
    check('its mic check is one read: tens of milliseconds at most', t && t.micMs < 100, JSON.stringify(t));
    check('the line reports where its time went (queue, mic, first audio, synthesis, cached)',
      t && t.queueMs < 50 && t.firstAudioMs >= 30 && t.firstAudioMs < t.totalMs && t.synthMs === 12 && t.cached === false && firstAudio === t.firstAudioMs,
      JSON.stringify({ t, firstAudio }));

    // A toggle is confirmed as soon as the control reads open.
    await page.setContent(micPage({ id: 'microphone-button', muted: 'Unmute mic', unmuted: 'Mute mic', startMuted: true }));
    const quick = await createSpeakController(page, inv('teams'), timedTts).speak('hello room');
    check('a toggle that takes effect at once is not waited on for the full settle time',
      quick.spoken === true && (quick as any).timing.micMs < 300, JSON.stringify((quick as any).timing));

    // A control drawn after admission is waited for by prepare().
    await page.setContent('<!doctype html><html><body><p>joining</p></body></html>');
    const late = createSpeakController(page, inv('teams'), timedTts);
    const preparing = late.prepare();
    await new Promise((r) => setTimeout(r, 200));
    await page.setContent(micPage({ id: 'microphone-button', muted: 'Unmute mic', unmuted: 'Mute mic', startMuted: true }));
    await preparing;
    const lateLabel = await page.evaluate(() => (globalThis as any).document.querySelector('button')?.getAttribute('aria-label'));
    check('prepare waits for a mic control drawn after admission, then opens it', lateLabel === 'Mute mic', String(lateLabel));

    // A line that arrives while prepare() is still looking for the control does not wait for it.
    await page.setContent('<!doctype html><html><body><p>joining</p></body></html>');
    const busy = createSpeakController(page, inv('teams'), timedTts);
    const looking = busy.prepare();
    const t0 = Date.now();
    const refused = await busy.speak('too early');
    check('a line never waits on the join-time mic search', Date.now() - t0 < 3000 && refused.spoken === false, `${Date.now() - t0} ms`);
    await looking;
    await page.setContent(micPage({ id: 'microphone-button', muted: 'Unmute mic', unmuted: 'Mute mic', startMuted: false }));

    // idle(): resolves once nothing is playing or queued.
    const before = timedTts.spoken.length;
    void late.speak('one'); void late.speak('two');
    await late.idle();
    check('idle resolves once every queued line has played', timedTts.spoken.length === before + 2, String(timedTts.spoken.length - before));
    const disabled = createSpeakController(page, { platform: 'teams', voiceAgentEnabled: false } as unknown as Invocation, timedTts);
    await disabled.prepare(); await disabled.idle();
    const disabledClicks = await page.evaluate(() => (globalThis as any).__clicks);
    check('a bot that cannot speak never touches the mic at join', disabledClicks === 0, String(disabledClicks));
  } finally {
    await context!.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
  if (failed > 0) process.exit(1);
  console.log('\n✅ The speak path plays a line only into a mic confirmed open.');
}

void main().catch((e) => { console.error(`❌ FAIL — ${String(e)}`); process.exit(1); });
