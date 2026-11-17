/**
 * The capture's silence gate keeps room around speech: the block before a stretch of speech and
 * the blocks after it are delivered, under their own capture times, so a clip never starts or ends
 * inside a word; blocks are dropped only from the middle of a long silence.
 *   npx tsx src/speech-window.test.ts
 */
import { createSpeechWindow, blockPeak, SPEECH_WINDOW_POST_ROLL_BLOCKS, SPEECH_WINDOW_PRE_ROLL_BLOCKS } from './speech-window.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => { console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  : ' + detail}`); if (!cond) failed++; };
const BLOCK = 4096, BLOCK_MS = 256;
const block = (peak: number): Float32Array => { const a = new Float32Array(BLOCK); a[BLOCK / 2] = peak; return a; };
const LOUD = 0.05, TAIL = 0.004, ROOM = 0.0005;

/** Feed a sequence of block peaks; returns what was delivered as "<index><v|q>" in order. */
function run(peaks: number[], opts = {}): { sent: string[]; ts: number[] } {
  const gate = createSpeechWindow(opts);
  const sent: string[] = [], ts: number[] = [];
  peaks.forEach((p, i) => {
    for (const b of gate.push(block(p), i * BLOCK_MS)) { sent.push(`${Math.round(b.tsMs / BLOCK_MS)}${b.voiced ? 'v' : 'q'}`); ts.push(b.tsMs); }
  });
  return { sent, ts };
}

{
  // room, room, room, SPEECH x3, quiet word ending, room x5
  const r = run([ROOM, ROOM, ROOM, LOUD, LOUD, LOUD, TAIL, ROOM, ROOM, ROOM, ROOM, ROOM]);
  check('the block before speech is delivered first, under its own capture time (pre-roll)', r.sent[0] === '2q' && r.sent[1] === '3v', r.sent.join(' '));
  check('the quiet end of the last word and the block after it are delivered (post-roll)', r.sent.slice(-2).join(' ') === '6q 7q', r.sent.join(' '));
  check('the rest of the silence is not', r.sent.length === 6 && !r.sent.includes('8q'), r.sent.join(' '));
  check('capture times stay in order', r.ts.every((t, i) => i === 0 || t > r.ts[i - 1]), r.ts.join(','));
  check('the defaults: 1 block before, 2 after (at least the 500 ms end-of-utterance pause)',
    SPEECH_WINDOW_PRE_ROLL_BLOCKS === 1 && SPEECH_WINDOW_POST_ROLL_BLOCKS * BLOCK_MS >= 500);
}
{
  // A pause shorter than pre-roll + post-roll loses nothing: the stream stays contiguous.
  const r = run([LOUD, ROOM, ROOM, ROOM, LOUD]);
  check('a short pause inside a turn is delivered whole (no splice)', r.sent.join(' ') === '0v 1q 2q 3q 4v', r.sent.join(' '));
}
{
  // A longer pause drops only its middle: both sides keep their quiet edge.
  const r = run([LOUD, ROOM, ROOM, ROOM, ROOM, ROOM, ROOM, LOUD]);
  check('a long pause is cut in its middle, never at a word', r.sent.join(' ') === '0v 1q 2q 6q 7v', r.sent.join(' '));
}
{
  // A word ending quieter than the threshold for a whole block used to be dropped with the silence.
  const bare = run([LOUD, TAIL, ROOM, ROOM], { preRollBlocks: 0, postRollBlocks: 0 });
  const kept = run([LOUD, TAIL, ROOM, ROOM]);
  check('without post-roll the quiet word ending is lost', bare.sent.join(' ') === '0v', bare.sent.join(' '));
  check('with it the word ending reaches the lane', kept.sent.includes('1q'), kept.sent.join(' '));
}
{
  const r = run([ROOM, ROOM, ROOM, ROOM]);
  check('silence alone delivers nothing', r.sent.length === 0);
  const gate = createSpeechWindow();
  const first = gate.push(block(LOUD), 0);
  check('speech at the very start needs no pre-roll', first.length === 1 && first[0].voiced);
  check('blockPeak is the largest magnitude', blockPeak(block(-0.3)) > 0.29 && blockPeak(new Float32Array(8)) === 0);
}

if (failed) { console.error(`\n❌ speech-window: ${failed} check(s) FAILED.`); process.exit(1); }
console.log('\n✅ speech-window: speech reaches the lane whole, with the quiet audio before and after it');
