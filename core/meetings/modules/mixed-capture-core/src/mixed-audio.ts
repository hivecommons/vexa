/**
 * Mixed-audio capture — capture a MIXED audio MediaStream (e.g. a tabCapture
 * stream for Zoom / Teams web) into 16 kHz PCM AND re-play it to the speakers so
 * the user still hears the meeting.
 *
 * THE bug: `getUserMedia({chromeMediaSource:'tab'})` MUTES the tab's own playback.
 * Constraints learned the hard way in the extension OFFSCREEN document:
 *   - the AudioWorklet (createPcmCaptureNode) loads from a `blob:` URL, which the
 *     offscreen's MV3 extension-page CSP blocks ("Unable to load a worklet's
 *     module"), and MV3 forbids `blob:` in both script-src AND worker-src. So
 *     capture here uses a ScriptProcessorNode — no module to load, no CSP issue.
 *     The offscreen is a dedicated, low-load document, so the main-thread stutter
 *     that retired ScriptProcessor in the busy meeting page does not apply.
 *   - a 16 kHz context's OUTPUT won't render on most devices → re-play through it
 *     is silent; and two AudioContexts on one tab track starve each other. So
 *     RE-PLAY uses a separate NATIVE-rate context on a CLONED track.
 *
 * Pure browser code (no node). Consumed by the extension's offscreen document and
 * available to the bot — same contract as the other capture bricks.
 */

/** What the capture did since the last read (interval counters) and where it stands (gauges). */
/** Samples per ScriptProcessor callback: 256 ms at 16 kHz. */
export const PROCESSOR_FRAME_SAMPLES = 4096;

export interface MixedAudioStats {
  /** The capture AudioContext's state ('running' | 'suspended' | 'closed'). */
  contextState: string;
  /** The capture AudioContext's actual sample rate (Hz). */
  sampleRate: number;
  /** ScriptProcessor callbacks in the interval: zero means the graph is not being pulled at all. */
  callbacks: number;
  /** Frames handed to onPcm in the interval (speech, pre-roll and hangover). */
  forwarded: number;
  /** Frames held back as silence in the interval. */
  gated: number;
  /** How far the frame clock currently trails the callback clock (ms). */
  clockLagMs: number;
  /** Times the frame clock was moved forward to catch up with real time, since start. */
  reanchors: number;
  /** Capture time those moves skipped (audio the processor never delivered), since start (ms). */
  lostMs: number;
}

export interface MixedAudioCapture {
  /** Stop re-play + capture and release resources. */
  stop(): void;
  /** Read the capture's counters; the interval counters restart at zero. */
  stats(): MixedAudioStats;
  /** Resume the capture context when it is suspended (a headless page gets no user gesture). */
  resume(): void;
}

export interface MixedAudioOptions {
  /** PCM target rate (Hz). Default 16000. */
  sampleRate?: number;
  /** Skip near-silent frames below this peak amplitude. Default 0.005. */
  silenceThreshold?: number;
  /** Keep forwarding silent frames for this long after the last audible one, and forward the one
   *  silent frame before an onset, so an utterance crosses as one contiguous stretch (its short
   *  pauses and soft edges included) instead of separate loud pieces. Default 0: only audible
   *  frames are forwarded. */
  speechHangoverMs?: number;
  /** Re-play the stream to the speakers (un-mute the captured tab). Default true. */
  replay?: boolean;
  log?: (msg: string) => void;
}

/** The frame clock is moved forward once it trails real time by more than this (ms). */
export const CAPTURE_CLOCK_MAX_LAG_MS = 400;
/** Callbacks the lag is observed over before the clock moves: the SMALLEST lag in the window is
 *  the drift, since a late callback only ever adds to it. */
export const CAPTURE_CLOCK_WINDOW_FRAMES = 8;

export interface CaptureClock {
  /** Epoch ms of sample zero. */
  anchorMs: number;
  /** Samples processed so far. */
  samples: number;
  /** Lags (ms) of the most recent callbacks, newest last. */
  lags: number[];
  reanchors: number;
  lostMs: number;
}

export function createCaptureClock(startMs: number): CaptureClock {
  return { anchorMs: startMs, samples: 0, lags: [], reanchors: 0, lostMs: 0 };
}

/**
 * Stamp one frame and advance the clock. The stamp is the wall-clock of the frame's first sample
 * on the accumulated-audio clock (anchor + samples / rate), which is free of callback jitter.
 *
 * That clock only counts audio the processor delivered. A context that starts late, or a
 * processor whose callbacks are skipped while the page's main thread is busy, leaves it behind
 * real time for good, and everything stamped on it then disagrees with the clocks it is compared
 * against (transport edges, speaker hints). So the lag between the stamp and the callback's own
 * time is watched: when even the best callback of the last `windowFrames` trails by more than
 * `maxLagMs`, the anchor moves forward by that much.
 */
export function stampCaptureFrame(
  clock: CaptureClock,
  frameSamples: number,
  nowMs: number,
  sampleRate: number,
  maxLagMs: number = CAPTURE_CLOCK_MAX_LAG_MS,
  windowFrames: number = CAPTURE_CLOCK_WINDOW_FRAMES,
): number {
  const frameMs = (frameSamples / sampleRate) * 1000;
  let tsMs = clock.anchorMs + (clock.samples / sampleRate) * 1000;
  // The callback fires once the frame is full, so its first sample is one frame old by now.
  clock.lags.push(nowMs - frameMs - tsMs);
  if (clock.lags.length > windowFrames) clock.lags.shift();
  if (clock.lags.length >= windowFrames) {
    const drift = Math.min(...clock.lags);
    if (drift > maxLagMs) {
      clock.anchorMs += drift;
      clock.reanchors++;
      clock.lostMs += drift;
      clock.lags = clock.lags.map((lag) => lag - drift);
      tsMs += drift;
    }
  }
  clock.samples += frameSamples;
  return tsMs;
}

/** Which frames one callback hands on: nothing, the frame, or the held pre-roll frame first. */
export interface SpeechGate {
  /** Silent frames still to forward after the last audible one. */
  hangoverFramesLeft: number;
  /** The most recent silent frame that was held back, forwarded ahead of the next onset. */
  preroll: { pcm: Float32Array; tsMs: number } | null;
}

export function createSpeechGate(): SpeechGate {
  return { hangoverFramesLeft: 0, preroll: null };
}

/**
 * Decide what to forward for one frame. An audible frame is always forwarded (after the held
 * pre-roll frame, when hangover is on and that frame directly precedes it); a silent frame is
 * forwarded while the hangover lasts and held back afterwards.
 */
export function gateSpeechFrame(
  gate: SpeechGate,
  pcm: Float32Array,
  tsMs: number,
  audible: boolean,
  hangoverFrames: number,
): Array<{ pcm: Float32Array; tsMs: number }> {
  if (audible) {
    const out: Array<{ pcm: Float32Array; tsMs: number }> = [];
    if (gate.preroll) out.push(gate.preroll);
    gate.preroll = null;
    gate.hangoverFramesLeft = hangoverFrames;
    out.push({ pcm, tsMs });
    return out;
  }
  if (gate.hangoverFramesLeft > 0) {
    gate.hangoverFramesLeft--;
    return [{ pcm, tsMs }];
  }
  gate.preroll = hangoverFrames > 0 ? { pcm, tsMs } : null;
  return [];
}

export async function createMixedAudioCapture(
  stream: MediaStream,
  onPcm: (pcm: Float32Array, tsMs?: number) => void,
  opts: MixedAudioOptions = {},
): Promise<MixedAudioCapture> {
  const SR = opts.sampleRate ?? 16000;
  const SILENCE = opts.silenceThreshold ?? 0.005;
  const log = opts.log ?? (() => { /* silent */ });

  // ── CAPTURE — 16 kHz context + ScriptProcessor (no worklet module → no CSP) ────
  const ctx = new AudioContext({ sampleRate: SR });
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(PROCESSOR_FRAME_SAMPLES, 1, 1);
  // Accumulated-audio-time clock: stamp each frame with the wall-clock of the AUDIO it holds
  // (anchor + samples-so-far / rate), NOT Date.now() at callback time. The ScriptProcessor fires a
  // buffer-length (~256ms) AFTER the audio was captured, and that latency + event-loop jitter is
  // exactly what pushed frames out of the speaker-hint binder's match window (misattribution). Count
  // ALL processed samples, silent frames included, and follow real time when the processor
  // delivers less audio than elapsed (stampCaptureFrame). It's the same page clock the
  // active-speaker hints carry, so the binder can align them.
  const clock = createCaptureClock(Date.now());
  const gate = createSpeechGate();
  const hangoverFrames = Math.ceil(Math.max(0, opts.speechHangoverMs ?? 0) / ((PROCESSOR_FRAME_SAMPLES / SR) * 1000));
  let callbacks = 0, forwarded = 0, gated = 0;
  proc.onaudioprocess = (e: AudioProcessingEvent) => {
    const input = e.inputBuffer.getChannelData(0);
    const tsMs = stampCaptureFrame(clock, input.length, Date.now(), SR);   // wall-clock of this frame's first sample
    callbacks++;
    let maxVal = 0;
    for (let i = 0; i < input.length; i++) { const a = Math.abs(input[i]); if (a > maxVal) maxVal = a; }
    const audible = maxVal > SILENCE;
    // copy, the buffer is reused; a frame that is neither forwarded nor held needs none
    const frames = audible || hangoverFrames > 0
      ? gateSpeechFrame(gate, new Float32Array(input), tsMs, audible, hangoverFrames)
      : [];
    if (!frames.length) gated++;
    for (const frame of frames) { forwarded++; onPcm(frame.pcm, frame.tsMs); }
  };
  source.connect(proc);
  proc.connect(ctx.destination);                           // pull the processor (outputs silence)
  void ctx.resume().catch(() => { /* best-effort — never await in an offscreen */ });
  log(`pcm capture @ ${SR} Hz (ScriptProcessor)`);

  // ── RE-PLAY — native context (no worklet) on a CLONED track ───────────────────
  let playCtx: AudioContext | null = null;
  let cloned: MediaStreamTrack | null = null;
  if (opts.replay !== false) {
    const track = stream.getAudioTracks()[0];
    cloned = track ? track.clone() : null;
    if (cloned) {
      playCtx = new AudioContext();                        // device-native rate
      playCtx.createMediaStreamSource(new MediaStream([cloned])).connect(playCtx.destination);
      void playCtx.resume().catch(() => { /* best-effort */ });
      log(`re-play @ ${playCtx.sampleRate} Hz (native, cloned track)`);
    }
  }

  return {
    stats(): MixedAudioStats {
      const out: MixedAudioStats = {
        contextState: String(ctx.state),
        sampleRate: ctx.sampleRate,
        callbacks, forwarded, gated,
        clockLagMs: clock.lags.length ? Math.round(clock.lags[clock.lags.length - 1]) : 0,
        reanchors: clock.reanchors,
        lostMs: Math.round(clock.lostMs),
      };
      callbacks = 0; forwarded = 0; gated = 0;
      return out;
    },
    resume(): void {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* best-effort */ });
    },
    stop(): void {
      try { proc.disconnect(); proc.onaudioprocess = null; } catch { /* */ }
      try { playCtx?.close(); } catch { /* */ }
      try { cloned?.stop(); } catch { /* */ }
      try { ctx.close(); } catch { /* */ }
    },
  };
}
