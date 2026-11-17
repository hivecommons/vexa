/**
 * The capture's silence gate, with room around speech.
 *
 * A participant's stream is silent most of the time, and silent blocks are not sent to the lane. A
 * bare per-block gate ("send a block only when its peak is above the threshold") cuts speech
 * wherever it is quiet for a whole block: the soft start of a word, the decaying end of a sentence.
 * The clip that reaches the transcriber then starts or ends inside a word, and the last words of a
 * sentence are the ones it gets wrong.
 *
 * This gate keeps a short PRE-ROLL (the block just before speech starts is sent first, under its
 * own capture time) and a POST-ROLL (the blocks right after the last loud block are sent too), so
 * every stretch of speech arrives whole, with the quiet audio that surrounds it. Blocks are only
 * ever dropped from the middle of a silence at least pre-roll + post-roll long, so two stretches
 * that end up next to each other in the lane are joined silence to silence, never inside a word.
 *
 * Pure (no DOM, no clock): the caller passes each block and its capture time.
 */

export interface SpeechWindowOptions {
  /** A block whose peak is above this is speech. Default 0.005. */
  threshold?: number;
  /** Quiet blocks kept before the first loud block of a stretch. Default 1 (256 ms at 16 kHz / 4096). */
  preRollBlocks?: number;
  /** Quiet blocks kept after the last loud block of a stretch. Default 2 (512 ms): at least the
   *  lane's end-of-utterance pause, so a turn's final clip ends with the room, not with the word. */
  postRollBlocks?: number;
}

/** One block the gate lets through. `voiced` is false for a pre-roll or post-roll block. */
export interface SpeechWindowBlock {
  pcm: Float32Array;
  tsMs: number;
  voiced: boolean;
}

export interface SpeechWindow {
  /** Offer one captured block; returns the blocks to send now, oldest first (often none). */
  push(pcm: Float32Array, tsMs: number): SpeechWindowBlock[];
}

export const SPEECH_WINDOW_THRESHOLD = 0.005;
export const SPEECH_WINDOW_PRE_ROLL_BLOCKS = 1;
export const SPEECH_WINDOW_POST_ROLL_BLOCKS = 2;

export function blockPeak(pcm: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
  return peak;
}

export function createSpeechWindow(opts: SpeechWindowOptions = {}): SpeechWindow {
  const threshold = opts.threshold ?? SPEECH_WINDOW_THRESHOLD;
  const preRoll = Math.max(0, opts.preRollBlocks ?? SPEECH_WINDOW_PRE_ROLL_BLOCKS);
  const postRoll = Math.max(0, opts.postRollBlocks ?? SPEECH_WINDOW_POST_ROLL_BLOCKS);
  /** Quiet blocks not sent yet, newest last: the pre-roll of whatever speech comes next. */
  let held: SpeechWindowBlock[] = [];
  /** Post-roll blocks still owed after the last loud block. */
  let owed = 0;
  return {
    push(pcm, tsMs) {
      if (blockPeak(pcm) > threshold) {
        const out = [...held, { pcm, tsMs, voiced: true }];
        held = [];
        owed = postRoll;
        return out;
      }
      const quiet: SpeechWindowBlock = { pcm, tsMs, voiced: false };
      if (owed > 0) { owed--; return [quiet]; }
      held.push(quiet);
      if (held.length > preRoll) held = held.slice(held.length - preRoll);
      return [];
    },
  };
}
