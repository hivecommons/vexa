/**
 * TTS playback cache: a short line is synthesized once per voice and replayed from memory, the
 * BOT_TTS_PREWARM lines are synthesized before they are first spoken, and long lines always stream.
 *   npx tsx src/tts-playback.test.ts
 */
import { PassThrough, type Readable } from 'node:stream';
import { createTtsPlayback, prewarmLinesFromEnv, TTS_CACHE_MAX_CHARS, type Player, type Synthesize } from './tts-playback.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => { console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`); if (!cond) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SYNTH_MS = 300;

function fakes() {
  const synthesized: string[] = [];
  const played: Buffer[] = [];
  const synthesize: Synthesize = async (text, voice) => {
    synthesized.push(`${voice}:${text}`);
    const s = new PassThrough();
    setTimeout(() => { s.end(Buffer.from(`pcm(${voice}:${text})`)); }, SYNTH_MS);
    return s as Readable;
  };
  const player: Player = {
    start() {
      const input = new PassThrough();
      const chunks: Buffer[] = [];
      input.on('data', (c: Buffer) => chunks.push(c));
      const done = new Promise<void>((resolve) => input.on('end', () => { played.push(Buffer.concat(chunks)); resolve(); }));
      return { input, done, kill: () => input.destroy() };
    },
  };
  return { synthesize, player, synthesized, played };
}

{
  const f = fakes();
  const tts = createTtsPlayback(() => {}, { synthesize: f.synthesize, player: f.player, prewarmLines: [] });
  await tts.speak('One moment.', 'af_heart');
  const t0 = Date.now();
  await tts.speak('One moment.', 'af_heart');
  const replayMs = Date.now() - t0;
  check('a short line is synthesized once and replayed from the cache', f.synthesized.length === 1, JSON.stringify(f.synthesized));
  check('the replay starts without a synthesis round trip', replayMs < SYNTH_MS / 2, `${replayMs} ms`);
  check('the replay plays the same PCM', f.played.length === 2 && f.played[1].toString() === 'pcm(af_heart:One moment.)', f.played.map(String).join(','));
  await tts.speak('One moment.', 'bm_george');
  check('the cache is per voice', f.synthesized.length === 2, JSON.stringify(f.synthesized));
  const long = 'x'.repeat(TTS_CACHE_MAX_CHARS + 1);
  await tts.speak(long); await tts.speak(long);
  check('a long line is never cached', f.synthesized.filter((s) => s.endsWith(long)).length === 2);
}
{
  const f = fakes();
  const tts = createTtsPlayback(() => {}, { synthesize: f.synthesize, player: f.player, prewarmLines: ['Let me check on that.', 'One moment.'] });
  await sleep(SYNTH_MS * 3);                          // the default voice is prewarmed at start
  check('the prewarm lines are synthesized for the default voice at start', f.synthesized.join('|') === 'auto:Let me check on that.|auto:One moment.', f.synthesized.join('|'));
  const t0 = Date.now();
  await tts.speak('One moment.');
  check('a prewarmed line plays at once', Date.now() - t0 < SYNTH_MS / 2 && f.synthesized.length === 2, `${Date.now() - t0} ms`);
  await tts.speak('Hello there.', 'af_bella');        // first use of a voice: its prewarm starts
  await sleep(SYNTH_MS * 3);
  check('the first line in a new voice prewarms that voice', f.synthesized.includes('af_bella:Let me check on that.') && f.synthesized.includes('af_bella:One moment.'), f.synthesized.join('|'));
  const t1 = Date.now();
  await tts.speak('Let me check on that.', 'af_bella');
  check('and its stock lines then play at once', Date.now() - t1 < SYNTH_MS / 2, `${Date.now() - t1} ms`);
}
{
  check('BOT_TTS_PREWARM: "|"-separated, trimmed, empty dropped',
    JSON.stringify(prewarmLinesFromEnv({ BOT_TTS_PREWARM: ' One moment. || Let me see. |' })) === JSON.stringify(['One moment.', 'Let me see.']));
  check('BOT_TTS_PREWARM unset: nothing to prewarm', prewarmLinesFromEnv({}).length === 0);
}

if (failed) { console.error(`\n❌ tts-playback: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✅ tts-playback: short lines cached per voice, stock lines prewarmed');
