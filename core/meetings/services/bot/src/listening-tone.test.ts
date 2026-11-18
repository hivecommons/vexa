/**
 * The listening tone: a short, soft, rising two-note chime generated in code.
 *   npx tsx src/listening-tone.test.ts
 */
import {
  isListeningTone, LISTENING_TONE_TEXT, renderListeningTone, TONE_NOTE_HZ, TONE_PEAK_CAP, TONE_RATE_HZ, toneDurationMs,
} from './listening-tone.js';
import { TTS_PCM_RATE_HZ } from './tts-playback.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => { console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`); if (!cond) failed++; };

const pcm = renderListeningTone();
const samples = Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2));
const peakOf = (s: number[]) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** Frequency of a slice from its upward zero crossings. */
const freqOf = (s: number[]): number => {
  let crossings = 0;
  for (let i = 1; i < s.length; i++) if (s[i - 1] < 0 && s[i] >= 0) crossings++;
  return crossings / (s.length / TONE_RATE_HZ);
};

const ms = toneDurationMs(pcm);
check('length: about 150 to 250 ms', ms >= 150 && ms <= 250, String(ms));
check('whole 16-bit samples', pcm.length % 2 === 0);
check('same rate as the TTS PCM, so the same player plays it', TONE_RATE_HZ === TTS_PCM_RATE_HZ);
check('deterministic', renderListeningTone().equals(pcm));

const peak = peakOf(samples);
check('level cap: the loudest sample is at most a quarter of full scale', peak <= TONE_PEAK_CAP, `${peak} > ${TONE_PEAK_CAP}`);
check('but audible: at least a tenth of full scale', peak >= 0.1 * 32767, String(peak));
check('no clipping: no sample at the 16-bit limits', !samples.some((v) => v >= 32767 || v <= -32768));

check('starts at silence (no click)', Math.abs(samples[0]) <= 1 && peakOf(samples.slice(0, 4)) <= 200);
check('ends at silence (no click)', peakOf(samples.slice(-8)) <= 50, String(peakOf(samples.slice(-8))));
const mean = samples.reduce((a, v) => a + v, 0) / samples.length;
check('no DC offset', Math.abs(mean) < 50, String(mean));

const half = samples.length / 2;
const f1 = freqOf(samples.slice(0, half)), f2 = freqOf(samples.slice(half));
check('two notes, rising', f2 > f1 * 1.2, `${f1.toFixed(0)} Hz then ${f2.toFixed(0)} Hz`);
check('the notes are the configured pitches', Math.abs(f1 - TONE_NOTE_HZ[0]) < 60 && Math.abs(f2 - TONE_NOTE_HZ[1]) < 60, `${f1.toFixed(0)} ${f2.toFixed(0)}`);

check('the reserved line is recognised, trimmed', isListeningTone(LISTENING_TONE_TEXT) && isListeningTone(` ${LISTENING_TONE_TEXT}\n`));
check('ordinary speech is not the tone', !isListeningTone('Hello there.') && !isListeningTone(`${LISTENING_TONE_TEXT} and more`));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nlistening-tone: all checks passed');
