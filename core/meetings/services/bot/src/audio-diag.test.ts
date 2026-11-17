/**
 * The Node-side audio-hop line: frames and level that crossed the page boundary, what left for
 * STT, and the lane's own state appended when the lane reports one.
 * Run: npx tsx src/audio-diag.test.ts
 */
import { createAudioDiag, TEAMS_SPEECH_HANGOVER_MS } from './capture-bridge.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : ` (${detail})`}`);
  if (!cond) failed++;
};

let now = 1_000;
const diag = createAudioDiag(() => now);
now = 1_500;
diag.observe(new Float32Array(4096).fill(0.5));
diag.observe(new Float32Array(4096).fill(0));
const first = diag.line({ chunks: 2, audioSec: 2.56, pcmBytes: 81_920, firstChunkAtMs: 2_000 }, 'drafts=1 finals=1');
check('line: interval frames, level, totals and the STT hop',
  first.startsWith('[bot] audio-diag frames=2 rms=0.3536 peak=0.5000 frames-total=2 first-frame=500ms stt-chunks=2 stt-audio-sec=2.6 stt-pcm-bytes=81920 first-chunk=1000ms'),
  first);
check('line: the lane state is appended', first.endsWith(' drafts=1 finals=1'), first);
const second = diag.line();
check('line: interval counters restart, totals stay, no lane state when the lane reports none',
  second.includes('frames=0 rms=0.0000') && second.includes('frames-total=2') && second.endsWith('first-chunk=none'), second);
check('Teams speech hangover spans three 256 ms capture frames', TEAMS_SPEECH_HANGOVER_MS === 768);

if (failed) { console.error(`\n❌ audio-diag: ${failed} checks FAILED.`); process.exit(1); }
console.log('\n✅ audio-diag: the audio hop reads on one line, lane state included.');
