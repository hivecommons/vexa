/**
 * End of turn on the low-latency lane as deployed (pauseFinalMs 500, idleTimeoutSec 1, show fast then
 * reconfirm): the speaker's CONFIRMED segment (completed:true, what a meeting consumer acts on) must
 * follow about a second after they stop, whether they stop by going quiet on an open mic, by muting
 * (captures gate silent chunks, so the lane then receives NO frames at all), or while room noise keeps
 * arriving under their speech level. A slow STT with a request still in flight must not hold the turn
 * open ("Idle submit ... (9.0s idle)" with a 1 s timeout, hivecommons/hive#18590).
 *   npx tsx src/turn-end.test.ts
 */
import { createGmeetPipeline } from './gmeet-pipeline.js';
import { SpeakerStreamManager } from './speaker-streams.js';
import { setLogger } from './log.js';
import type { TranscriptSegment } from './contracts/transcript-v1.js';

setLogger(() => {});
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => { console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`); if (!cond) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SR = 16000, FRAME = 4096, FRAME_MS = (FRAME / SR) * 1000;
const LOW = { pauseFinalMs: 500, idleTimeoutSec: 1, submitInterval: 1, maxBufferDuration: 10, confirmThreshold: 1, pipelineDrafts: true, minAudioDuration: 0.75 };
const WORDS = 'hello Betty what is open in the hive right now'.split(' ');

function speech(n: number): Float32Array { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.1 * Math.sin(i * 0.07) * (1 + 0.3 * Math.sin(i * 0.003)); return a; }
/** Broadband room noise at about `level` RMS (peaks well above the capture gate's 0.005). */
function noise(n: number, level: number): Float32Array { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = level * Math.sqrt(3) * (2 * Math.random() - 1); return a; }
/** A fake STT: about three words per second of audio, after `ms`. */
function stt(ms: number, counter: { n: number }) {
  return async (pcm: Float32Array) => {
    counter.n++;
    await sleep(ms);
    const sec = pcm.length / SR;
    const text = WORDS.slice(0, Math.max(1, Math.round(sec * 3))).join(' ');
    return { text, language: 'en', duration: sec, segments: [{ start: 0, end: sec, text }] } as never;
  };
}

type After = 'mute' | 'open-mic-silence' | 'room-noise' | 'loud-noise';

/** Speak ~2.5 s in real time, then stop in the given way; measure from the last voiced frame to the
 *  first confirmed (completed) segment. */
async function turn(after: After, sttMs: number, waitMs = 5000) {
  let confirmedAt: number | undefined; let text = '';
  let stoppedAt = Infinity;
  const sink = {
    segment(s: TranscriptSegment) { if (s.completed && s.text.trim() && Date.now() >= stoppedAt && confirmedAt === undefined) { confirmedAt = Date.now(); text = s.text; } },
    draft() {},
    finalize() {},
  };
  const calls = { n: 0 };
  const lane = createGmeetPipeline({ transcribe: stt(sttMs, calls), sink, config: LOW, reconfirmSec: 10 });
  let ts = Date.now();
  for (let f = 0; f < Math.round(2.5 * SR / FRAME); f++) { lane.feedAudio(0, 'Andy', speech(FRAME), ts); ts += FRAME_MS; await sleep(FRAME_MS); }
  stoppedAt = Date.now();
  const until = stoppedAt + waitMs;
  while (Date.now() < until && confirmedAt === undefined) {
    if (after === 'open-mic-silence') lane.feedAudio(0, 'Andy', new Float32Array(FRAME), ts);
    else if (after === 'room-noise') lane.feedAudio(0, 'Andy', noise(FRAME, 0.006), ts);
    else if (after === 'loud-noise') lane.feedAudio(0, 'Andy', noise(FRAME, 0.05), ts);
    ts += FRAME_MS;
    await sleep(after === 'mute' ? 20 : FRAME_MS);
  }
  const closeMs = confirmedAt === undefined ? Infinity : confirmedAt - stoppedAt;
  lane.abandon();
  await lane.dispose();
  return { closeMs, text, calls: calls.n };
}

// STT round trip 300 ms: the turn's confirmed segment is due at about 1 s of silence + its reconfirmation.
{
  const r = await turn('mute', 300);
  check('mute right after speaking (no frames at all): confirmed segment ≤ 2 s after the speaker stops', r.closeMs <= 2000, `${r.closeMs} ms`);
  check('the confirmed segment carries the words', r.text.startsWith('hello Betty'), r.text);
}
{
  const r = await turn('open-mic-silence', 300);
  check('open mic, silence: confirmed segment ≤ 2 s after the speaker stops', r.closeMs <= 2000, `${r.closeMs} ms`);
}
{
  const r = await turn('room-noise', 300);
  check('room noise (0.006 RMS, above the fixed 0.0025 silence threshold) does not hold the turn open', r.closeMs <= 2200, `${r.closeMs} ms`);
}
{
  const r = await turn('loud-noise', 300, 3000);
  check('sound at speech level still counts as speech (the turn stays open while it lasts)', r.closeMs === Infinity, `${r.closeMs} ms`);
}
{
  // Slow STT (1.5 s a request): requests are in flight when the speaker stops.
  const r = await turn('mute', 1500, 8000);
  check('slow STT: the turn still closes on silence, not on idle-after-settle (≤ 4.5 s)', r.closeMs <= 4500, `${r.closeMs} ms`);
}

// The lane alone: a close deferred to an answer whose window covered the whole stretch uses it.
{
  const mgr = new SpeakerStreamManager(LOW);
  const requests: number[] = [];
  const finals: string[] = [];
  mgr.onSegmentReady = (_key, _name, pcm) => { requests.push(pcm.length); };
  mgr.onSegmentConfirmed = (_id, _name, t) => finals.push(t);
  mgr.addSpeaker('s', 'Andy');
  let ts = Date.now();
  for (let f = 0; f < 6; f++) { mgr.feedAudio('s', speech(FRAME), ts); ts += FRAME_MS; }
  const submit = (mgr as unknown as { trySubmit(id: string): Promise<void> }).trySubmit.bind(mgr);
  await submit('s');                                  // a draft covering every frame goes out
  check('a draft request is in flight', requests.length === 1, String(requests.length));
  await sleep(650);                                   // muted: no frames for > pauseFinalMs
  await submit('s');                                  // end of utterance: closes, deferred to the draft
  // The detached stretch keeps the route its request went out under ('s'); the live buffer moved on.
  mgr.handleTranscriptionResult('s', 'hello Betty what is open', 1.5, [{ text: 'hello Betty what is open', start: 0, end: 1.5 }], 'en', 1);
  check('the covering answer is the final: no second request for the same audio', requests.length === 1, String(requests.length));
  check('and the turn is published', finals.join(' ') === 'hello Betty what is open', JSON.stringify(finals));
  check('nothing is left owed', !mgr.hasUnfinished());
  mgr.removeAll();
}

if (failed) { console.error(`\n❌ turn-end: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✅ turn-end: end of turn follows silence, mute and room noise, not the STT backlog');
