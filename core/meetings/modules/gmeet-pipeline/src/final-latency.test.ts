/**
 * How soon the confirmed segment follows the end of an utterance on the per-speaker lane.
 *
 *   1. An utterance transcribed whole in one final window is confirmed by that answer: no second
 *      request for the same audio.
 *   2. An utterance that already has drafts is reconfirmed by a request sent at its END, beside the
 *      last window's own request, so the confirmed segment lands one round trip after the pause,
 *      not two.
 *   3. If the speaker goes on after that, the early answer is not used: the group is reconfirmed
 *      over all of its audio and no word is lost.
 *   4. An end of utterance with a draft in flight sends the final window at once on a pipelined
 *      lane; without pipelining it waits for the draft, as before.
 *   5. A name bound after the turn opened relabels the SAME stream: no new stream, no restart, and
 *      the confirmed segment carries the name.
 *   6. With the capture's post-roll (quiet frames after speech), the final clip includes them.
 *   npx tsx src/final-latency.test.ts
 */
import { createGmeetPipeline } from './gmeet-pipeline.js';
import { SpeakerStreamManager } from './speaker-streams.js';
import { setLogger } from './log.js';
import type { TranscriptSegment } from './contracts/transcript-v1.js';

const logs: string[] = [];
setLogger((m: string) => { logs.push(m); });
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => { console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  : ' + detail}`); if (!cond) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SR = 16000, BLOCK = 4096, BLOCK_MS = (BLOCK / SR) * 1000;
const FAST = { pauseFinalMs: 500, idleTimeoutSec: 1, submitInterval: 1, maxBufferDuration: 10, confirmThreshold: 1, pipelineDrafts: true, minAudioDuration: 0.75 };
const STT_MS = 600;
const speech = (n = BLOCK): Float32Array => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.05 * Math.sin(i * 0.07) * (1 + 0.3 * Math.sin(i * 0.003)); return a; };
const room = (n = BLOCK): Float32Array => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.0004 * Math.sin(i * 0.3); return a; };

function rig(over: Record<string, unknown> = {}) {
  const finals: Array<{ seg: TranscriptSegment; afterMs: number }> = [];
  const drafts: TranscriptSegment[] = [];
  const requests: Array<{ sec: number; at: number }> = [];
  let lastFrameAt = Date.now();
  const sink = {
    segment(s: TranscriptSegment) { finals.push({ seg: s, afterMs: Date.now() - lastFrameAt }); },
    draft(s: TranscriptSegment) { drafts.push(s); },
    finalize() {},
  };
  const transcribe = async (pcm: Float32Array) => {
    const sec = pcm.length / SR;
    requests.push({ sec, at: Date.now() });
    const n = requests.length;
    await sleep(STT_MS);
    const text = `words of request ${n} over ${sec.toFixed(1)} seconds`;
    return { text, language: 'en', duration: sec, segments: [{ start: 0, end: sec, text }] } as never;
  };
  const lane = createGmeetPipeline({ transcribe, sink, config: FAST, reconfirmSec: 10, ...over });
  const feed = async (blocks: number, make: () => Float32Array, name?: string, voiced = true) => {
    for (let i = 0; i < blocks; i++) {
      await sleep(BLOCK_MS);
      lane.feedAudio(0, name, make(), Date.now());
      if (voiced) lastFrameAt = Date.now();
    }
  };
  return { lane, feed, finals, drafts, requests };
}

// ── 1. one final window: confirmed by its own answer ──
{
  const r = rig();
  await r.feed(4, speech, 'Ada');                     // ~1 s: the turn ends before any draft answers
  await sleep(3000);
  check('one final window: the confirmed segment is its answer, with no second request for the same audio',
    r.finals.length === 1 && r.requests.filter((q) => q.at > 0).length <= 2
      && r.requests.filter((q) => Math.abs(q.sec - r.requests[r.requests.length - 1].sec) < 0.01).length === 1,
    JSON.stringify(r.requests.map((q) => q.sec.toFixed(2))));
  check('it lands about one round trip after the pause (pause 500 ms + STT 600 ms), not two',
    r.finals[0]?.afterMs < 500 + STT_MS + 450, `${r.finals[0]?.afterMs} ms`);
  await r.lane.dispose();
  check('nothing else is published for it', r.finals.length === 1, String(r.finals.length));
}

// ── 2. drafts + an end of utterance: the reconfirmation is sent at the end, not after the tail ──
{
  const r = rig();
  await r.feed(11, speech, 'Ada');                    // ~2.8 s: a first draft is confirmed mid-speech
  const endedAt = Date.now();
  await sleep(3500);
  const draftTexts = r.drafts.filter((d) => d.text.trim()).length;
  check('the utterance showed drafts while it was spoken', draftTexts >= 1, String(draftTexts));
  check('exactly one confirmed segment replaces them', r.finals.length === 1, JSON.stringify(r.finals.map((f) => f.seg.text)));
  const whole = r.requests.filter((q) => q.sec > 2.5);
  check('the reconfirmation covers the whole utterance and is one request', whole.length === 1, JSON.stringify(r.requests.map((q) => q.sec.toFixed(2))));
  check('it is sent at the end of the utterance (within the pause + a tick), not after the last window answers',
    whole.length === 1 && whole[0].at - endedAt < 500 + 350, `${whole[0]?.at - endedAt} ms after the last frame`);
  check('the confirmed segment lands one round trip after the pause, not two',
    r.finals[0]?.afterMs < 500 + STT_MS + 500, `${r.finals[0]?.afterMs} ms`);
  check('and it is the whole-utterance answer', /over 2\.[5-9]|over 3\./.test(r.finals[0]?.seg.text ?? ''), r.finals[0]?.seg.text);
  await r.lane.dispose();
}

// ── 3. the speaker goes on: the early answer is dropped, nothing is lost ──
{
  const r = rig({ reconfirmQuietMs: 2500, reconfirmIdleMs: 4000 });   // the group stays open across the pause
  await r.feed(11, speech, 'Ada');
  await sleep(700);                                   // a pause long enough to end the utterance
  await r.feed(8, speech, 'Ada');                     // ...and then more speech in the same turn
  await sleep(6000);
  await r.lane.dispose();
  const longest = Math.max(...r.requests.map((q) => q.sec));
  check('speech after the pause: the group is reconfirmed over ALL of its audio (the early answer is not used)',
    r.finals.length >= 1 && longest > 4.3 && r.finals.some((f) => f.seg.text.includes(`over ${longest.toFixed(1)}`)),
    JSON.stringify({ finals: r.finals.map((f) => f.seg.text), longest }));
}

// ── 4. end of utterance with a draft in flight ──
{
  const run = async (pipelineDrafts: boolean, blocks: number) => {
    const mgr = new SpeakerStreamManager({ ...FAST, pipelineDrafts });
    const sent: Array<{ id: number; sec: number; at: number }> = [];
    const confirmed: Array<{ text: string; final?: boolean; at: number }> = [];
    let ends = 0;
    mgr.onUtteranceEnd = () => { ends++; };
    mgr.onSegmentConfirmed = (_id, _name, text, _s, _e, _seg, _lang, final) => { confirmed.push({ text, final, at: Date.now() }); };
    mgr.onSegmentReady = (key, _name, audio, requestId) => {
      const sec = audio.length / SR;
      sent.push({ id: requestId, sec, at: Date.now() });
      // A slow STT: the draft is still in flight when the utterance ends.
      setTimeout(() => mgr.handleTranscriptionResult(key, `answer to ${sec.toFixed(1)}s`, sec, [{ start: 0, end: sec, text: `answer to ${sec.toFixed(1)}s` }] as never, 'en', requestId), 1500);
    };
    mgr.addSpeaker('s', 'Ada');
    for (let i = 0; i < blocks; i++) { await sleep(BLOCK_MS); mgr.feedAudio('s', speech(), Date.now()); }
    const endedAt = Date.now();
    await sleep(4500);
    mgr.removeAll();
    return { sent, confirmed, ends, endedAt };
  };
  // ~1.3 s: the draft in flight was cut at 0.8 s, while the speaker was still talking.
  const fast = await run(true, 5);
  const finalReq = fast.sent[fast.sent.length - 1];
  check('pipelined lane: the final window goes out at the end of the utterance, beside the draft in flight',
    fast.sent.length === 2 && finalReq.at - fast.endedAt < 500 + 350, `${finalReq?.at - fast.endedAt} ms, ${fast.sent.length} request(s)`);
  check('its answer is published as a final, once', fast.confirmed.length === 1 && fast.confirmed[0].final === true, JSON.stringify(fast.confirmed));
  check('the confirmed text follows the pause by one round trip', fast.confirmed[0]?.at - fast.endedAt < 500 + 1500 + 400, `${fast.confirmed[0]?.at - fast.endedAt} ms`);
  check('the end of the utterance is announced once', fast.ends === 1, String(fast.ends));
  // ~1.5 s: a pipelined draft covering the whole utterance went out just before the pause ended.
  const covered = await run(true, 6);
  const whole = covered.sent.filter((q) => Math.abs(q.sec - (6 * BLOCK) / SR) < 0.01);
  check('a draft in flight that already covers the whole utterance IS the final: the audio is not sent again',
    whole.length === 1 && covered.confirmed.length === 1 && covered.confirmed[0].final === true,
    `${whole.length} whole-utterance request(s) of ${covered.sent.length}, ${JSON.stringify(covered.confirmed)}`);
  check('even when an older draft answers first', covered.sent.length === 2 && covered.confirmed[0].at - whole[0].at < 1500 + 300,
    `${covered.sent.length} request(s), ${covered.confirmed[0]?.at - whole[0]?.at} ms after it was sent`);
  const plain = await run(false, 5);
  const lastPlain = plain.sent[plain.sent.length - 1];
  check('without pipelining the final still waits for the request in flight (one request per speaker)',
    plain.sent.length >= 2 && lastPlain.at - plain.endedAt >= 900 && plain.confirmed.length === 1,
    `${lastPlain?.at - plain.endedAt} ms, ${plain.sent.length} request(s), ${plain.confirmed.length} confirmed`);
}

// ── 5. a name bound after the turn opened: same stream, the segment carries the name ──
{
  logs.length = 0;
  const r = rig();
  await r.feed(2, speech, undefined);                 // the turn opens before the glow names it
  await r.feed(9, speech, 'Andy Anderson');
  await sleep(3500);
  await r.lane.dispose();
  const added = logs.filter((l) => l.includes('Added speaker')).length;
  check('relabel: one stream for the turn (no restart, no split)', added === 1 && logs.some((l) => l.includes('Updated speaker name "Speaker"')), `${added} stream(s)`);
  check('relabel: the audio fed before the name is in the confirmed text\'s window',
    r.requests.some((q) => q.sec > 2.5), JSON.stringify(r.requests.map((q) => q.sec.toFixed(2))));
  check('relabel: the confirmed segment carries the bound name and one speaker_key',
    r.finals.length === 1 && r.finals[0].seg.speaker === 'Andy Anderson' && r.finals[0].seg.speaker_key === 'ch-0:1',
    JSON.stringify(r.finals.map((f) => [f.seg.speaker, f.seg.speaker_key])));
}

// ── 6. the capture's post-roll is part of the final clip ──
{
  const r = rig();
  await r.feed(4, speech, 'Ada');                     // ~1 s of speech
  await r.feed(2, room, undefined, false);            // the two quiet blocks the capture sends after it
  await sleep(3000);
  await r.lane.dispose();
  const finalSec = Math.max(...r.requests.map((q) => q.sec));
  check('the final window includes the quiet audio after the last word (about 0.5 s of post-roll)',
    finalSec >= (6 * BLOCK) / SR - 0.01, `${finalSec.toFixed(2)} s`);
  check('quiet frames after speech still end the utterance on time', r.finals.length === 1 && r.finals[0].afterMs < 500 + STT_MS + 700, `${r.finals[0]?.afterMs} ms`);
}

setLogger(() => {});
if (failed) { console.error(`\n❌ final-latency: ${failed} check(s) FAILED.`); process.exit(1); }
console.log('\n✅ final-latency: the confirmed segment follows the pause by one round trip; relabel keeps the stream; the clip keeps its post-roll');
