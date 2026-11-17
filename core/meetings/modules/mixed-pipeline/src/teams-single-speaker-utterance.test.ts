/**
 * Teams CSRC lane: one person says one short sentence, alone in the mix. The utterance must come
 * out as ONE final row, whatever the offset between the capture clock (frame stamps) and the
 * transport clock (CSRC edges): with a single lane routed, no other speaker can own that audio.
 * A span that a second lane was also routed stays refused when it does not fit its CSRC interval.
 * Run: npx tsx src/teams-single-speaker-utterance.test.ts
 */
import { TeamsCsrcGmeetPipeline, type TeamsCsrcTranscriptSegment } from './teams-csrc-gmeet-pipeline.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` (${detail})`}`);
  if (!condition) failed++;
};

const FRAME_SAMPLES = 4096;
const FRAME_MS = FRAME_SAMPLES / 16;
const speech = (): Float32Array => new Float32Array(FRAME_SAMPLES).fill(0.2);

interface Run {
  finals: TeamsCsrcTranscriptSegment[];
  rows: Map<string, TeamsCsrcTranscriptSegment>;
  rejected: number;
  uncontested: Array<{ offsetMs: number }>;
  sttAudioSec: number[];
  health: ReturnType<TeamsCsrcGmeetPipeline['health']>;
}

/** Feed a 3 s utterance (12 frames) of CSRC 501 whose frame stamps trail the transport by `lagMs`. */
async function utterance(lagMs: number, rival = false): Promise<Run> {
  let now = 0;
  const run: Run = { finals: [], rows: new Map(), rejected: 0, uncontested: [], sttAudioSec: [], health: undefined as never };
  const pipeline = new TeamsCsrcGmeetPipeline({
    flickerHoldMs: 0,
    buffer: { scheduleSubmissions: false, now: () => now, silenceRmsThreshold: 0, minAudioDuration: 0.75, idleTimeoutSec: 1, submitInterval: 1 },
    onSegment: (segment) => {
      if (!segment.completed && !segment.text.trim()) run.rows.delete(segment.segmentId);
      else run.rows.set(segment.segmentId, segment);
      if (segment.completed) run.finals.push(segment);
    },
    onRejectedOwnership: () => { run.rejected++; },
    onUncontestedOwnership: (_segment, offsetMs) => { run.uncontested.push({ offsetMs }); },
    transcribe: async (pcm) => {
      run.sttAudioSec.push(pcm.length / 16_000);
      const text = 'Betty, please introduce yourself.';
      return { text, language: 'en', duration: pcm.length / 16_000, segments: [{ text, start: 0, end: pcm.length / 16_000 } as any] };
    },
  });
  const t0 = 1_000_000;
  pipeline.recordTransportEvent({ csrc: 501, active: true, tMs: t0 });
  if (rival) pipeline.recordTransportEvent({ csrc: 777, active: true, tMs: t0 });
  for (let i = 0; i < 12; i++) {
    now = t0 + (i + 1) * FRAME_MS;
    pipeline.feedMixedAudio(speech(), t0 + i * FRAME_MS - lagMs);
    if (i === 4) await pipeline.requestTranscription(501);      // the draft pass, 1.28 s in
  }
  now = t0 + 12 * FRAME_MS + 400;
  pipeline.recordTransportEvent({ csrc: 501, active: false, tMs: now });
  if (rival) pipeline.recordTransportEvent({ csrc: 777, active: false, tMs: now });
  // The lane's closing pass over the whole window (the idle submit in production).
  now += 1_000;
  await pipeline.requestTranscription(501, true);
  if (rival) await pipeline.requestTranscription(777, true);
  await pipeline.flush();
  run.health = pipeline.health();
  await pipeline.dispose();
  return run;
}

for (const lagMs of [0, 2_000, 30_000]) {
  const run = await utterance(lagMs);
  const rows = [...run.rows.values()];
  check(`clock lag ${lagMs} ms: the utterance yields exactly one row, and it is final`,
    rows.length === 1 && rows[0].completed && rows[0].text === 'Betty, please introduce yourself.',
    JSON.stringify(rows));
  check(`clock lag ${lagMs} ms: the final pass carries the whole 3 s utterance in one clip`,
    Math.abs(Math.max(...run.sttAudioSec) - 12 * FRAME_MS / 1000) < 0.001, JSON.stringify(run.sttAudioSec));
  check(`clock lag ${lagMs} ms: nothing is refused`, run.rejected === 0 && run.health.rejectedOwnership === 0);
  if (lagMs === 0) check('no lag: the span fits its CSRC interval, no offset is reported', run.uncontested.length === 0);
  else check(`clock lag ${lagMs} ms: the offset is reported, not hidden`,
    run.uncontested.length >= 1 && run.health.uncontestedOwnership >= 1 && Math.abs(run.uncontested[0].offsetMs) >= lagMs - 1300,
    JSON.stringify(run.uncontested));
}

{
  // Two lanes were routed the same audio: the span must fit this CSRC's own interval or be refused.
  const run = await utterance(30_000, true);
  check('contested audio outside the CSRC interval stays refused',
    run.finals.length === 0 && run.rejected >= 1 && run.uncontested.length === 0,
    JSON.stringify({ finals: run.finals.length, rejected: run.rejected }));
}

if (failed) { console.error(`\n❌ teams single-speaker utterance: ${failed} checks FAILED.`); process.exit(1); }
console.log('\n✅ Teams single-speaker utterance: one clip, one final row, whatever the clock offset.');
