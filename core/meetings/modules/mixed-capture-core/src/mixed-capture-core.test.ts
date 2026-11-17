/**
 * mixed-capture-core L2 — the PURE signal-gating logic, no browser. Shims a
 * minimal AudioContext/MediaStream so we can drive the real createMixedAudioCapture
 * ScriptProcessor callback with synthetic buffers and assert: near-silent frames
 * are dropped (silenceThreshold), audible frames are forwarded as a COPY (the
 * source buffer is reused by the engine), and stop() tears down. The actual
 * device capture + re-play is live-validated. installRemoteAudioHook is a no-op
 * without RTCPeerConnection — assert that contract too.
 * Run: npm test  or  npx tsx src/mixed-capture-core.test.ts
 */
import {
  createMixedAudioCapture, installRemoteAudioHook,
  createCaptureClock, stampCaptureFrame, createSpeechGate, gateSpeechFrame,
  CAPTURE_CLOCK_MAX_LAG_MS, CAPTURE_CLOCK_WINDOW_FRAMES, PROCESSOR_FRAME_SAMPLES,
} from './index.js';

let failed = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? '✅' : '❌'} ${name}`); if (!cond) failed++; };

// ── Minimal Web Audio / MediaStream shim ──────────────────────────────────────
const g = globalThis as any;
let lastProc: any = null;            // the most-recently-created ScriptProcessor
const closed: any[] = [];            // contexts that got .close()

class FakeAudioContext {
  sampleRate: number;
  destination = { _id: 'dest' };
  state = 'running';
  constructor(opts?: { sampleRate?: number }) { this.sampleRate = opts?.sampleRate ?? 48000; }
  createMediaStreamSource() { return { connect() {} }; }
  createScriptProcessor() {
    const proc: any = { onaudioprocess: null, connect() {}, disconnect() {} };
    lastProc = proc;
    return proc;
  }
  resume() { return Promise.resolve(); }
  close() { closed.push(this); return Promise.resolve(); }
}
class FakeTrack { stopped = false; clone() { return new FakeTrack(); } stop() { this.stopped = true; } }
class FakeMediaStream {
  private tracks: FakeTrack[];
  constructor(tracks?: FakeTrack[]) { this.tracks = tracks ?? [new FakeTrack()]; }
  getAudioTracks() { return this.tracks; }
}
g.AudioContext = FakeAudioContext;
g.MediaStream = FakeMediaStream;

// Fire one audio buffer through the live ScriptProcessor callback.
const fire = (samples: Float32Array) => {
  lastProc.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
};

// ── silence gate ──────────────────────────────────────────────────────────────
{
  const pcms: Float32Array[] = [];
  const cap = await createMixedAudioCapture(new FakeMediaStream() as any, (pcm) => pcms.push(pcm), { sampleRate: 16000, silenceThreshold: 0.01 });
  fire(new Float32Array(8).fill(0.001));   // below threshold → dropped
  check('near-silent frame is dropped', pcms.length === 0);
  fire(new Float32Array(8).fill(0.5));     // above threshold → forwarded
  check('audible frame is forwarded', pcms.length === 1);
  check('forwarded PCM has the right length', pcms[0]?.length === 8);
  cap.stop();
}
{
  // The forwarded PCM must be a COPY — the engine reuses the input buffer, so a
  // forwarded reference would alias and corrupt downstream.
  const pcms: Float32Array[] = [];
  const cap = await createMixedAudioCapture(new FakeMediaStream() as any, (pcm) => pcms.push(pcm), { silenceThreshold: 0.01 });
  const shared = new Float32Array(4).fill(0.5);
  fire(shared);
  shared.fill(0.0);                        // mutate the engine's buffer after the callback
  check('forwarded PCM is a copy (not aliased to the engine buffer)', pcms[0]?.every((v) => v === 0.5) === true);
  cap.stop();
}
{
  // replay:false → no second (native-rate) context; stop() closes the capture ctx.
  const cap = await createMixedAudioCapture(new FakeMediaStream() as any, () => {}, { replay: false });
  const before = closed.length;
  cap.stop();
  check('stop() closes the capture context', closed.length === before + 1);
}

// ── speech hangover: an utterance crosses as one contiguous stretch ─────────────
{
  const SR = 16000;
  const frameMs = (PROCESSOR_FRAME_SAMPLES / SR) * 1000;
  const loud = () => new Float32Array(PROCESSOR_FRAME_SAMPLES).fill(0.3);
  const quiet = () => new Float32Array(PROCESSOR_FRAME_SAMPLES).fill(0.0001);
  const got: Array<{ loud: boolean; tsMs: number }> = [];
  const cap = await createMixedAudioCapture(new FakeMediaStream() as any,
    (pcm, tsMs) => got.push({ loud: pcm[0] > 0.1, tsMs: tsMs ?? NaN }),
    { sampleRate: SR, replay: false, speechHangoverMs: 3 * frameMs });
  // 3 s of talk as the mix delivers it: quiet lead-in, words with two short pauses, then quiet.
  const talk = [quiet, quiet, loud, loud, quiet, loud, loud, quiet, quiet, loud, loud, loud, quiet, quiet, quiet, quiet, quiet];
  for (const f of talk) fire(f());
  const pattern = got.map((f) => (f.loud ? 'L' : 'q')).join('');
  check('hangover: one pre-roll frame, every pause inside the utterance, then the hangover and no more',
    pattern === 'qLLqLLqqLLLqqq');
  const steps = got.slice(1).map((f, i) => Math.round(f.tsMs - got[i].tsMs));
  check('hangover: the forwarded frames are contiguous in capture time (no hole inside the utterance)',
    steps.every((d) => d === Math.round(frameMs)));
  const s1 = cap.stats();
  // 17 callbacks; 4 forwarded nothing (the lead-in pair and the last two); the held lead-in frame
  // went out later as pre-roll, so 14 frames crossed.
  check('stats: callbacks, forwarded frames and silent callbacks are counted apart',
    s1.callbacks === talk.length && s1.forwarded === 14 && s1.gated === 4);
  check('stats: the capture context state and rate are reported', s1.contextState === 'running' && s1.sampleRate === SR);
  check('stats: interval counters restart after a read', cap.stats().callbacks === 0);
  cap.stop();
}
{
  // Default (no hangover): only audible frames cross, as before.
  const got: Float32Array[] = [];
  const cap = await createMixedAudioCapture(new FakeMediaStream() as any, (pcm) => got.push(pcm), { replay: false });
  fire(new Float32Array(8).fill(0.0001)); fire(new Float32Array(8).fill(0.5)); fire(new Float32Array(8).fill(0.0001));
  check('no hangover by default: silent frames around speech stay gated', got.length === 1);
  cap.stop();
}
{
  const gate = createSpeechGate();
  const f = new Float32Array(1);
  check('gate: silence before any speech is held', gateSpeechFrame(gate, f, 0, false, 2).length === 0);
  check('gate: an onset forwards the held frame first', gateSpeechFrame(gate, f, 256, true, 2).map((x) => x.tsMs).join() === '0,256');
  check('gate: hangover frames are forwarded', gateSpeechFrame(gate, f, 512, false, 2).length === 1 && gateSpeechFrame(gate, f, 768, false, 2).length === 1);
  check('gate: silence past the hangover is held', gateSpeechFrame(gate, f, 1024, false, 2).length === 0);
}

// ── the frame clock follows real time when the processor delivers less audio than elapsed ──
{
  const SR = 16000, N = PROCESSOR_FRAME_SAMPLES, frameMs = (N / SR) * 1000;
  // Healthy: callbacks on time (with jitter) keep the accumulated-audio stamps exactly.
  const ok = createCaptureClock(1_000_000);
  const stamps: number[] = [];
  for (let i = 0; i < 40; i++) stamps.push(stampCaptureFrame(ok, N, 1_000_000 + (i + 1) * frameMs + (i % 5 === 0 ? 300 : 20), SR));
  check('clock: on-time callbacks are stamped on the sample clock, jitter ignored',
    stamps.every((t, i) => t === 1_000_000 + i * frameMs) && ok.reanchors === 0);
  // One late callback (a stalled main thread that lost nothing) does not move the clock.
  const late = createCaptureClock(0);
  for (let i = 0; i < 20; i++) stampCaptureFrame(late, N, (i + 1) * frameMs + (i === 10 ? 2000 : 10), SR);
  check('clock: a single late callback is not drift', late.reanchors === 0);
  // The context starts 3 s after it was created: every stamp would be 3 s early for good.
  const slow = createCaptureClock(0);
  let last = 0;
  for (let i = 0; i < 20; i++) last = stampCaptureFrame(slow, N, 3000 + (i + 1) * frameMs, SR);
  check('clock: a late start is caught up within the observation window',
    slow.reanchors === 1 && Math.abs(last - (3000 + 19 * frameMs)) < 1 && Math.round(slow.lostMs) === 3000);
  // Callbacks skipped mid-meeting (10 frames lost) leave the clock behind until it re-anchors.
  const drop = createCaptureClock(0);
  let wall = 0;
  for (let i = 0; i < 10; i++) { wall += frameMs; stampCaptureFrame(drop, N, wall, SR); }
  wall += 10 * frameMs;
  for (let i = 0; i < CAPTURE_CLOCK_WINDOW_FRAMES; i++) { wall += frameMs; last = stampCaptureFrame(drop, N, wall, SR); }
  check('clock: skipped callbacks are made up once the lag has held for a whole window',
    drop.reanchors === 1 && Math.abs(last - (wall - frameMs)) < 1 && Math.round(drop.lostMs) === Math.round(10 * frameMs));
  // A lag under the threshold is left alone (the sample clock stays the smoother one).
  const small = createCaptureClock(0);
  for (let i = 0; i < 20; i++) stampCaptureFrame(small, N, CAPTURE_CLOCK_MAX_LAG_MS - 50 + (i + 1) * frameMs, SR);
  check('clock: a lag below the threshold does not move it', small.reanchors === 0);
}

// ── installRemoteAudioHook contract: no RTCPeerConnection → no-op false ─────────
{
  g.window = {};
  delete g.RTCPeerConnection;
  check('hook returns false when RTCPeerConnection is unavailable', installRemoteAudioHook({ log: () => {} }) === false);
}

if (failed) { console.error(`\n❌ mixed-capture-core: ${failed} checks FAILED.`); process.exit(1); }
console.log(`\n✅ mixed-capture-core: silence-gate + hangover + frame clock + copy-on-forward + teardown pass. (device capture/re-play is live-validated.)`);
