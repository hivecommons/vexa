/**
 * The listening tone: a short, soft, rising two-note chime a voice agent plays when it heard its
 * name and is about to answer (like a smart speaker's wake sound), so the room knows it is
 * listening. It is generated here from two sine waves, so there is no sample file and no licence
 * to carry, and it is rendered once when the bot starts, so playing it costs no synthesis.
 *
 * It is requested through the existing `speak` act with the reserved line LISTENING_TONE_TEXT (no
 * contract change) and played through the same tts_sink as speech. It is not speech: it is never
 * sent to the TTS service, never cached as a sentence, and is dropped, not queued, when the bot is
 * already speaking.
 *
 * Pure (no I/O) and no workspace imports → gate:isolation-clean.
 */

/** The reserved speak line that means "play the listening tone". Quorum sends the same text. */
export const LISTENING_TONE_TEXT = '[[hive:listening-tone]]';

/** Same format as the TTS service's PCM, so the same player plays it: 24 kHz mono s16le. */
export const TONE_RATE_HZ = 24_000;
const BYTES_PER_SAMPLE = 2;

/** The two notes, rising a perfect fourth: G5 then C6. */
export const TONE_NOTE_HZ: readonly [number, number] = [783.99, 1046.5];
/** Each note's length. Two notes make a chime about 200 ms long. */
export const TONE_NOTE_MS = 100;
/** Attack: a fast, smooth rise (no click at the start). */
export const TONE_ATTACK_MS = 8;
/** Release: the last of each note fades to exactly zero. */
export const TONE_RELEASE_MS = 25;
/** How quickly each note dies away after its attack: its level falls by this factor over the note. */
export const TONE_DECAY_RATIO = 0.12;
/** The loudest sample, as a fraction of full scale. Speech peaks several times higher; this stays
 *  a quiet cue under it. */
export const TONE_PEAK = 0.18;
/** Hard ceiling on the loudest sample (of 32767) however the constants above are changed. */
export const TONE_PEAK_CAP = Math.round(0.25 * 32767);

/** The chime as 24 kHz mono signed 16-bit little-endian PCM. Deterministic. */
export function renderListeningTone(): Buffer {
  const noteSamples = Math.round((TONE_RATE_HZ * TONE_NOTE_MS) / 1000);
  const attack = Math.round((TONE_RATE_HZ * TONE_ATTACK_MS) / 1000);
  const release = Math.round((TONE_RATE_HZ * TONE_RELEASE_MS) / 1000);
  const total = noteSamples * TONE_NOTE_HZ.length;
  const out = Buffer.alloc(total * BYTES_PER_SAMPLE);
  const peak = Math.min(Math.round(TONE_PEAK * 32767), TONE_PEAK_CAP);
  const decayPerSample = Math.log(TONE_DECAY_RATIO) / noteSamples;
  TONE_NOTE_HZ.forEach((hz, n) => {
    for (let i = 0; i < noteSamples; i++) {
      const attackGain = i < attack ? Math.sin((Math.PI / 2) * (i / attack)) ** 2 : 1;
      const releaseGain = i >= noteSamples - release ? Math.sin((Math.PI / 2) * ((noteSamples - i) / release)) ** 2 : 1;
      const level = attackGain * releaseGain * Math.exp(decayPerSample * i);
      const v = Math.round(peak * level * Math.sin((2 * Math.PI * hz * i) / TONE_RATE_HZ));
      out.writeInt16LE(v, (n * noteSamples + i) * BYTES_PER_SAMPLE);
    }
  });
  return out;
}

/** The length of a rendered tone in milliseconds. */
export function toneDurationMs(pcm: Buffer): number {
  return Math.round((pcm.length / BYTES_PER_SAMPLE / TONE_RATE_HZ) * 1000);
}

/** True when a speak line is the reserved listening-tone request. */
export function isListeningTone(text: string): boolean {
  return text.trim() === LISTENING_TONE_TEXT;
}
