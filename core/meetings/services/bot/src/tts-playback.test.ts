/**
 * TTS playback: a line is synthesized and played sentence by sentence (the first sentence plays
 * while the next ones are synthesized, in order, in one player session), every sentence is cached
 * per voice, the BOT_TTS_PREWARM lines are split the same way and synthesized ahead of time for
 * every voice the bot starts with, and each clip is conditioned (no DC offset, faded edges).
 *   npx tsx src/tts-playback.test.ts
 */
import { PassThrough, type Readable } from 'node:stream';
import {
  conditionPcm, createTtsPlayback, prewarmLinesFromEnv, prewarmVoicesFromEnv, splitSentences, synthConcurrencyFromEnv,
  TTS_CACHE_MAX_CHARS, TTS_FADE_MS, TTS_PCM_RATE_HZ, TTS_PREWARM_MAX_LINE_CHARS, TTS_PREWARM_MAX_LINES,
  TTS_SENTENCE_MAX_CHARS, TtsIncompleteError, type Player, type Synthesize,
} from './tts-playback.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => { console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`); if (!cond) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SYNTH_MS = 300;
/** Samples per fake sentence: 100 ms of audio. */
const CLIP_SAMPLES = TTS_PCM_RATE_HZ / 10;
const CLIP_MS = 100;

/** A square wave whose amplitude identifies its text (so order is readable from the output). */
const levelOf = (text: string): number => 1000 + (text.length % 50) * 100;
function clip(level: number, samples = CLIP_SAMPLES): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 2 ? level : -level, i * 2);
  return b;
}
/** The level in the middle of clip `n` of a played buffer. */
const midLevel = (played: Buffer, n: number): number => Math.abs(played.readInt16LE((n * CLIP_SAMPLES + CLIP_SAMPLES / 2) * 2));

function fakes(opts: { delayMs?: (text: string) => number; fail?: (text: string) => boolean } = {}) {
  const synthesized: string[] = [];
  const played: Buffer[] = [];
  const writes: number[] = [];                        // when each write reached the player (ms)
  let inFlight = 0, maxInFlight = 0;
  const synthesize: Synthesize = async (text, voice) => {
    synthesized.push(`${voice}:${text}`);
    if (opts.fail?.(text)) return null;
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const s = new PassThrough();
    // The service answers only once the whole text is synthesized.
    setTimeout(() => { inFlight--; s.end(clip(levelOf(text))); }, opts.delayMs?.(text) ?? SYNTH_MS);
    return s as Readable;
  };
  let sessions = 0;
  const player: Player = {
    start() {
      sessions++;
      const input = new PassThrough();
      const chunks: Buffer[] = [];
      input.on('data', (c: Buffer) => { chunks.push(c); writes.push(Date.now()); });
      const done = new Promise<void>((resolve) => {
        input.on('end', () => { played.push(Buffer.concat(chunks)); resolve(); });
        input.on('close', () => resolve());
      });
      return { input, done, kill: () => input.destroy() };
    },
  };
  return { synthesize, player, synthesized, played, writes, sessions: () => sessions, maxInFlight: () => maxInFlight };
}

// ── the cache ──
{
  const f = fakes();
  const tts = createTtsPlayback(() => {}, { synthesize: f.synthesize, player: f.player, prewarmLines: [] });
  await tts.speak('One moment.', 'af_heart');
  const t0 = Date.now();
  const ms = await tts.speak('One moment.', 'af_heart');
  const replayMs = Date.now() - t0;
  check('a short line is synthesized once and replayed from the cache', f.synthesized.length === 1, JSON.stringify(f.synthesized));
  check('the replay starts without a synthesis round trip', replayMs < SYNTH_MS / 2, `${replayMs} ms`);
  check('the replay plays the same PCM', f.played.length === 2 && f.played[0].equals(f.played[1]));
  check('the duration is the audio played', ms === CLIP_MS, String(ms));
  await tts.speak('One moment.', 'bm_george');
  check('the cache is per voice', f.synthesized.length === 2, JSON.stringify(f.synthesized));
  const long = 'x'.repeat(TTS_CACHE_MAX_CHARS + 1);
  await tts.speak(long); await tts.speak(long);
  check('a sentence over the cache limit is never cached', f.synthesized.filter((s) => s.endsWith(long)).length === 2);
}

// ── sentence by sentence ──
{
  const f = fakes();
  const tts = createTtsPlayback(() => {}, { synthesize: f.synthesize, player: f.player, prewarmLines: [], concurrency: 2 });
  const line = 'This is the first sentence. Here comes the second one! And is this the third?';
  const t0 = Date.now();
  let firstAudioAt = -1;
  const ms = await tts.speak(line, 'af_heart', { onFirstAudio: () => { firstAudioAt = Date.now() - t0; } });
  const total = Date.now() - t0;
  check('each sentence is its own request, in order', f.synthesized.join('|') ===
    'af_heart:This is the first sentence.|af_heart:Here comes the second one!|af_heart:And is this the third?', f.synthesized.join('|'));
  check('the first audio starts after ONE sentence is synthesized, not the line',
    firstAudioAt >= SYNTH_MS - 20 && firstAudioAt < SYNTH_MS * 1.6, `${firstAudioAt} ms`);
  check('the next sentence is synthesized while the first is on its way (2 at once)', f.maxInFlight() === 2, String(f.maxInFlight()));
  check('the whole line took two synthesis rounds, not three', total < SYNTH_MS * 2.7, `${total} ms`);
  check('one player session for the line (no gap or overlap between sentences)', f.sessions() === 1 && f.played.length === 1, String(f.sessions()));
  check('the sentences play in order',
    [0, 1, 2].map((n) => midLevel(f.played[0], n)).join(',') === splitSentences(line).map(levelOf).join(','),
    [0, 1, 2].map((n) => midLevel(f.played[0], n)).join(','));
  check('one total duration for the line', ms === 3 * CLIP_MS, String(ms));
  // A line made of sentences already spoken: nothing is synthesized.
  const before = f.synthesized.length;
  const t1 = Date.now();
  await tts.speak('Here comes the second one! This is the first sentence.', 'af_heart');
  check('sentences are cached one by one (a new line of known sentences plays at once)',
    f.synthesized.length === before && Date.now() - t1 < SYNTH_MS / 2, `${f.synthesized.length - before} request(s), ${Date.now() - t1} ms`);
}
{
  // A later sentence that is ready first still waits its turn.
  const f = fakes({ delayMs: (t) => (t.startsWith('Slow') ? SYNTH_MS : 20) });
  const tts = createTtsPlayback(() => {}, { synthesize: f.synthesize, player: f.player, prewarmLines: [], concurrency: 3 });
  const line = 'Slow sentence number one. Quick second sentence here. Quick third sentence, longer.';
  await tts.speak(line);
  check('a sentence synthesized early is not played early',
    [0, 1, 2].map((n) => midLevel(f.played[0], n)).join(',') === splitSentences(line).map(levelOf).join(','));
  check('and nothing is written before the first sentence is ready', f.writes.length === 3);
}
{
  const f = fakes({ fail: (t) => t.startsWith('Broken') });
  const logs: string[] = [];
  const tts = createTtsPlayback((m) => logs.push(m), { synthesize: f.synthesize, player: f.player, prewarmLines: [] });
  let partial: unknown;
  await tts.speak('A sentence that works. Broken sentence in the middle. The one after it.').catch((e) => { partial = e; });
  check('a sentence that cannot be synthesized ends the line there (no hole, no reordering)',
    f.played[0].length === CLIP_SAMPLES * 2, `${f.played[0]?.length}`);
  check('and the line is reported as incomplete, never as spoken (the consent invariant)',
    partial instanceof TtsIncompleteError && partial.playedMs === CLIP_MS && partial.playedSentences === 1 && partial.totalSentences === 3,
    String(partial));
  let none: unknown;
  await tts.speak('Broken from the start.').catch((e) => { none = e; });
  check('a line with nothing synthesized plays nothing and fails instead of reporting 0 ms spoken',
    none instanceof TtsIncompleteError && none.playedMs === 0 && f.sessions() === 1, `${String(none)}, ${f.sessions()} session(s)`);
}
{
  const f = fakes();
  const tts = createTtsPlayback(() => {}, { synthesize: f.synthesize, player: f.player, prewarmLines: [], concurrency: 1 });
  const speaking = tts.speak('The first sentence plays. The second one never does. Nor does the third.');
  await sleep(SYNTH_MS + 50);                         // sentence 1 is in the player, 2 is being synthesized
  tts.stop();
  await speaking;
  await sleep(SYNTH_MS * 2);
  check('stop ends the line: no later sentence is requested or played', f.synthesized.length === 2 && f.writes.length === 1,
    `${f.synthesized.length} request(s), ${f.writes.length} write(s)`);
}

// ── prewarm ──
{
  const f = fakes();
  const intro = "Hi, I'm Betty from the hive. I take notes and answer questions about the queue.";
  const tts = createTtsPlayback(() => {}, {
    synthesize: f.synthesize, player: f.player, prewarmLines: [intro, 'One moment.'], prewarmVoices: ['auto', 'af_heart'],
  });
  await sleep(SYNTH_MS * 4);
  check('the prewarm lines are split into sentences and synthesized for every voice the bot starts with',
    ['auto', 'af_heart'].every((v) => splitSentences(intro).concat('One moment.').every((s) => f.synthesized.includes(`${v}:${s}`)))
      && f.synthesized.length === 6, f.synthesized.join('|'));
  const t0 = Date.now();
  const ms = await tts.speak(intro, 'af_heart');
  check('a prewarmed two-sentence introduction plays at once in the configured voice',
    Date.now() - t0 < SYNTH_MS / 2 && f.synthesized.length === 6 && ms === 2 * CLIP_MS, `${Date.now() - t0} ms`);
  await tts.speak('Hello there, everyone.', 'af_bella');   // first use of another voice: its prewarm starts
  await sleep(SYNTH_MS * 4);
  check('the first line in a voice the bot was not started with prewarms that voice',
    f.synthesized.includes('af_bella:One moment.'), f.synthesized.join('|'));
  const t1 = Date.now();
  await tts.speak('One moment.', 'af_bella');
  check('and its stock lines then play at once', Date.now() - t1 < SYNTH_MS / 2, `${Date.now() - t1} ms`);
}
{
  // A line being spoken has the service to itself: the prewarm waits for it.
  const f = fakes();
  const tts = createTtsPlayback(() => {}, { synthesize: f.synthesize, player: f.player, prewarmLines: ['Stock line one.', 'Stock line two.', 'Stock line three.'], concurrency: 1 });
  await sleep(20);                                    // the first stock line is being synthesized
  await tts.speak('A live line spoken now.');
  const at = f.synthesized.indexOf('auto:A live line spoken now.');
  check('a prewarm in progress does not queue its remaining lines ahead of a live line', at === 1, f.synthesized.join('|'));
  await sleep(SYNTH_MS * 3);
  check('and it finishes afterwards', f.synthesized.length === 4, f.synthesized.join('|'));
}

// ── the sentence splitter ──
{
  const eq = (name: string, text: string, want: string[]) =>
    check(name, JSON.stringify(splitSentences(text)) === JSON.stringify(want), JSON.stringify(splitSentences(text)));
  eq('sentences end at . ! ? followed by a space', 'I take notes for you. Shall I start? Great, here we go!',
    ['I take notes for you.', 'Shall I start?', 'Great, here we go!']);
  eq('a single sentence is one request', 'Andy, let me check on that.', ['Andy, let me check on that.']);
  eq('numbers and versions are not sentence ends', 'Version 1.2 has 3.5 times the throughput today. It ships soon enough.',
    ['Version 1.2 has 3.5 times the throughput today.', 'It ships soon enough.']);
  eq('abbreviations and initials are not sentence ends', 'Dr. Smith and J. Doe reviewed it, e.g. the queue. They approved it all.',
    ['Dr. Smith and J. Doe reviewed it, e.g. the queue.', 'They approved it all.']);
  eq('a very short sentence joins the next one', 'Hi. I am the meeting assistant.', ['Hi. I am the meeting assistant.']);
  eq('a very short last sentence joins the one before', 'There are four issues in the queue. Okay?', ['There are four issues in the queue. Okay?']);
  eq('whitespace is normalised', '  One sentence   here.\n\nAnother sentence there.  ', ['One sentence here.', 'Another sentence there.']);
  eq('closing quotes stay with their sentence', 'She said "ship it today." Then we shipped it.', ['She said "ship it today."', 'Then we shipped it.']);
  eq('empty text has no sentences', '   ', []);
  const long = `${'word, '.repeat(80)}end.`;
  const parts = splitSentences(long);
  check('an over-long sentence is cut at clause boundaries', parts.length > 1 && parts.every((p) => p.length <= TTS_SENTENCE_MAX_CHARS),
    parts.map((p) => p.length).join(','));
  check('and nothing is lost by the cut', parts.join(' ') === long);
  const text = 'First sentence of the line. Second sentence of the line? Third!';
  check('joining the sentences gives the line back', splitSentences(text).join(' ') === text);
}

// ── clip conditioning ──
{
  const fade = (TTS_PCM_RATE_HZ * TTS_FADE_MS) / 1000;
  const dcOnly = Buffer.alloc(CLIP_SAMPLES * 2);
  for (let i = 0; i < CLIP_SAMPLES; i++) dcOnly.writeInt16LE(8000, i * 2);
  const flat = conditionPcm(dcOnly);
  const s = (b: Buffer, i: number) => b.readInt16LE(i * 2);
  // A constant level IS a DC offset: it is removed entirely.
  check('a constant offset is removed (a clip of pure DC becomes silence)', [0, 100, CLIP_SAMPLES - 1].every((i) => s(flat, i) === 0));
  // A square wave around zero: no DC, so only the edges change.
  const sq = Buffer.alloc(CLIP_SAMPLES * 2);
  for (let i = 0; i < CLIP_SAMPLES; i++) sq.writeInt16LE(i % 2 ? 20000 : -20000, i * 2);
  const c = conditionPcm(sq);
  check('the clip starts and ends at zero', s(c, 0) === 0 && s(c, CLIP_SAMPLES - 1) === 0, `${s(c, 0)}, ${s(c, CLIP_SAMPLES - 1)}`);
  check('the fade is monotonic over its few milliseconds',
    Math.abs(s(c, fade / 2)) > Math.abs(s(c, 1)) && Math.abs(s(c, fade / 2)) < 20000 && Math.abs(s(c, fade)) === 20000,
    `${s(c, 1)}, ${s(c, fade / 2)}, ${s(c, fade)}`);
  let same = true;
  for (let i = fade; i < CLIP_SAMPLES - fade; i++) if (s(c, i) !== s(sq, i)) same = false;
  check('samples away from the edges are untouched', same);
  check('the input is not modified', s(sq, 0) === -20000);
  // An offset on top of a signal: the offset goes, the signal stays, nothing clips.
  const off = Buffer.alloc(CLIP_SAMPLES * 2);
  for (let i = 0; i < CLIP_SAMPLES; i++) off.writeInt16LE(i % 2 ? 32767 : 12767, i * 2);
  const o = conditionPcm(off);
  let peak = 0, sum = 0;
  for (let i = 0; i < CLIP_SAMPLES; i++) { peak = Math.max(peak, Math.abs(s(o, i))); sum += s(o, i); }
  check('an offset under a signal is removed and the peak stays below full scale',
    peak === 10000 && Math.abs(sum / CLIP_SAMPLES) < 1, `peak ${peak}, mean ${sum / CLIP_SAMPLES}`);
  check('a trailing half sample is dropped', conditionPcm(Buffer.concat([sq, Buffer.from([1])])).length === sq.length);
  check('an empty clip stays empty', conditionPcm(Buffer.alloc(0)).length === 0);
}

// ── env ──
{
  check('BOT_TTS_PREWARM: "|"-separated, trimmed, empty dropped',
    JSON.stringify(prewarmLinesFromEnv({ BOT_TTS_PREWARM: ' One moment. || Let me see. |' })) === JSON.stringify(['One moment.', 'Let me see.']));
  check('BOT_TTS_PREWARM unset: nothing to prewarm', prewarmLinesFromEnv({}).length === 0);
  const intro = `${'An introduction sentence of some length. '.repeat(6)}`.trim();
  check('a multi-sentence introduction fits in one prewarm line',
    intro.length > 200 && intro.length <= TTS_PREWARM_MAX_LINE_CHARS && prewarmLinesFromEnv({ BOT_TTS_PREWARM: intro }).length === 1, String(intro.length));
  check('a line over the prewarm limit is dropped', prewarmLinesFromEnv({ BOT_TTS_PREWARM: 'x'.repeat(TTS_PREWARM_MAX_LINE_CHARS + 1) }).length === 0);
  check('more than 16 prewarm lines are accepted, up to the limit',
    prewarmLinesFromEnv({ BOT_TTS_PREWARM: Array.from({ length: 60 }, (_, i) => `Line ${i}.`).join('|') }).length === TTS_PREWARM_MAX_LINES && TTS_PREWARM_MAX_LINES > 16);
  check('BOT_TTS_PREWARM_VOICES: the default voice first, then the named ones, once each',
    JSON.stringify(prewarmVoicesFromEnv({ BOT_TTS_PREWARM_VOICES: ' af_heart, bm_george ,af_heart,auto' })) === JSON.stringify(['auto', 'af_heart', 'bm_george']));
  check('BOT_TTS_PREWARM_VOICES unset: the default voice only', JSON.stringify(prewarmVoicesFromEnv({})) === JSON.stringify(['auto']));
  check('BOT_TTS_SYNTH_CONCURRENCY: default 1, bounded, invalid ignored',
    synthConcurrencyFromEnv({}) === 1 && synthConcurrencyFromEnv({ BOT_TTS_SYNTH_CONCURRENCY: '3' }) === 3
      && synthConcurrencyFromEnv({ BOT_TTS_SYNTH_CONCURRENCY: '99' }) === 8 && synthConcurrencyFromEnv({ BOT_TTS_SYNTH_CONCURRENCY: 'x' }) === 1);
}

if (failed) { console.error(`\n❌ tts-playback: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✅ tts-playback: sentence-by-sentence synthesis and playback, per-sentence cache, prewarm per voice, conditioned clips');
