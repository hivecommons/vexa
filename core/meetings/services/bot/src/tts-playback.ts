/**
 * TTS playback adapter (2b) — the OS-level half of the SPEAK path.  // L4 (O6/VM).
 *
 * The browser half (unmute the meeting-UI mic) lives in capture-bridge.ts's SpeakController; this
 * is the audio half: synthesize `text` via the Vexa TTS service and play the returned PCM through
 * the container's PulseAudio `tts_sink` (→ `virtual_mic`, which Chromium captures as its mic). The
 * `tts_sink → virtual_mic` graph is created by entrypoint.sh; here we only unmute it during
 * playback, write PCM to `paplay`, and re-mute after.
 *
 * A line is spoken SENTENCE BY SENTENCE (splitSentences): the first sentence is requested and
 * played as soon as it is synthesized, while the following ones are synthesized behind it
 * (BOT_TTS_SYNTH_CONCURRENCY at a time) and written to the same player in order. The TTS service
 * answers a request only once the whole of its text is synthesized, so the time to the first sound
 * is the synthesis of one sentence, not of the line.
 *
 * Every sentence up to TTS_CACHE_MAX_CHARS is cached per (voice, sentence), and the lines in
 * BOT_TTS_PREWARM ("|"-separated, e.g. an agent's introduction and stock acknowledgements) are
 * split the same way and synthesized ahead of time: for the default voice and every voice in
 * BOT_TTS_PREWARM_VOICES as soon as the bot can speak, and for any other voice when it is first
 * used. A prewarmed or repeated sentence plays at once. The cache is bounded (entries and bytes)
 * and lives only as long as the bot.
 *
 * What reaches the sink is clean: each sentence has its DC offset removed and a few milliseconds of
 * fade at both ends (no click at a clip edge), and between sentences and lines the sink carries
 * exact digital silence.
 *
 * acts.v1 `speak` already carries {text, voice} — no contract change. Config is infrastructure
 * (the TTS service URL/token), read from env like production (TTS_SERVICE_URL / TTS_API_TOKEN),
 * NOT the sealed invocation.v1. Gated by the SpeakController on inv.voiceAgentEnabled.
 *
 * Node-only (child_process + http/https) — no DOM, no workspace imports → gate:isolation-clean.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import type { Readable } from 'node:stream';

/** The TTS service's PCM: 24 kHz, mono, 16-bit little-endian. */
export const TTS_PCM_RATE_HZ = 24_000;
const TTS_PCM_BYTES_PER_SAMPLE = 2;
/** Bytes per millisecond of that PCM. */
const TTS_PCM_BYTES_PER_MS = (TTS_PCM_RATE_HZ * TTS_PCM_BYTES_PER_SAMPLE) / 1000;
/** The player's buffer target. paplay's default (about 2 s) holds a short first sentence back until
 *  the buffer fills or the input ends; this starts it within a few tens of milliseconds. */
export const TTS_PLAYER_LATENCY_MS = 40;
const PAPLAY_ARGS = ['--raw', '--format=s16le', `--rate=${TTS_PCM_RATE_HZ}`, '--channels=1', '--device=tts_sink',
  `--latency-msec=${TTS_PLAYER_LATENCY_MS}`];

/** Sentences up to this many characters are cached (acknowledgements, an introduction's sentences). */
export const TTS_CACHE_MAX_CHARS = 240;
/** At most this many cached sentences... */
export const TTS_CACHE_MAX_ENTRIES = 128;
/** ...and this many bytes of PCM in all (24 kHz s16le: about 5.5 min of speech). */
export const TTS_CACHE_MAX_BYTES = 16 * 1024 * 1024;
/** At most this many BOT_TTS_PREWARM lines are synthesized ahead of time per voice... */
export const TTS_PREWARM_MAX_LINES = 48;
/** ...each at most this long (a line is split into sentences, so an introduction fits). */
export const TTS_PREWARM_MAX_LINE_CHARS = 600;
/** The voice a line without one is spoken with (the TTS service chooses). */
export const TTS_DEFAULT_VOICE = 'auto';
/** A sentence longer than this is cut at a clause boundary, so the first sound never waits on a
 *  paragraph written as one sentence. */
export const TTS_SENTENCE_MAX_CHARS = 220;
/** A sentence shorter than this joins the next one ("Hi." alone is one request too many). */
export const TTS_SENTENCE_MIN_CHARS = 12;
/** Fade at both ends of every synthesized sentence. */
export const TTS_FADE_MS = 5;
/** A mean sample value beyond this (of 32768) is a DC offset and is removed. */
export const TTS_DC_OFFSET_MIN = 16;
/** Sentences synthesized at once behind the one playing (BOT_TTS_SYNTH_CONCURRENCY). One: on a CPU
 *  Kokoro (about real time per stream) two requests in flight both finish after the combined work,
 *  so the first sentence reached the meeting only once the second was also done (live Meet test:
 *  first audio 14.6 s, both syntheses "completed in 14.6 s"). Raise it where synthesis is faster
 *  than real time (a GPU). */
export const TTS_SYNTH_CONCURRENCY_DEFAULT = 1;
const TTS_SYNTH_CONCURRENCY_MAX = 8;

/** Gate the bot's voice at tts_sink only. virtual_mic (the source Chromium captures) stays unmuted:
 *  Meet shows a muted source as "Microphone problem" in place of the mic toggle. */
function setTtsMute(muted: boolean, log: (m: string) => void): void {
  const v = muted ? '1' : '0';
  try {
    execSync(`pactl set-sink-mute tts_sink ${v}`, { stdio: 'pipe' });
  } catch (err) {
    log(`[tts] pactl ${muted ? 'mute' : 'unmute'} failed: ${(err as Error).message}`);
  }
}

/** What one spoken line cost. `synthMs`: time spent waiting on the TTS service before the first
 *  audio (0 when the first sentence came from the cache). `cached`: every sentence of the line came
 *  from the cache. `sentences`: how many the line was split into. */
/** A line that could not be said whole: nothing was synthesized, or a sentence was dropped so the
 *  line ended early. The caller must report it as NOT spoken; the prefix that was already played
 *  (if any) is `playedMs`. */
export class TtsIncompleteError extends Error {
  constructor(readonly playedMs: number, readonly playedSentences: number, readonly totalSentences: number) {
    super(`tts_incomplete: ${playedSentences}/${totalSentences} sentence(s) synthesized, ${playedMs} ms played`);
    this.name = 'TtsIncompleteError';
  }
}

export interface TtsLineStats { synthMs: number; cached: boolean; sentences: number }

/** Per-line callbacks. */
export interface TtsSpeakHooks {
  /** The first PCM of the line was handed to the player (it is audible one player buffer later). */
  onFirstAudio?: () => void;
  /** The line finished playing (not called for a line that played nothing). */
  onLine?: (stats: TtsLineStats) => void;
}

export interface TtsPlayback {
  /** Synthesize `text` (voice optional) and play it into the meeting via tts_sink. Resolves when
   *  playback finishes, with the milliseconds of audio played (0 when nothing played). Best-effort:
   *  a synthesis/playback failure logs + resolves (never throws out — the voice handler must not
   *  break the orchestrator). */
  speak(text: string, voice?: string, hooks?: TtsSpeakHooks): Promise<number>;
  /** Synthesize `lines` for `voice` into the cache without playing them (sentences already cached
   *  or too long are skipped). Resolves when done; failures are logged, never thrown. */
  prewarm(lines: string[], voice?: string): Promise<void>;
  /** Interrupt any in-flight playback (barge-in) + re-mute. */
  stop(): void;
}

/** The PCM of one sentence from the TTS service: a stream, or null when the service could not answer. */
export type Synthesize = (text: string, voice: string) => Promise<Readable | null>;

/** Where PCM is played. `start` opens the sink and returns the player's input and its end. */
export interface Player {
  start(): { input: NodeJS.WritableStream; done: Promise<void>; kill(): void };
}

/** BOT_TTS_PREWARM: "|"-separated lines, trimmed, empty ones dropped, bounded. */
export function prewarmLinesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.BOT_TTS_PREWARM ?? '';
  return raw.split('|').map((l) => l.trim()).filter((l) => l.length > 0 && l.length <= TTS_PREWARM_MAX_LINE_CHARS)
    .slice(0, TTS_PREWARM_MAX_LINES);
}

/** BOT_TTS_PREWARM_VOICES: the voices the bot is started with (","-separated). The default voice is
 *  always first, so a line sent without a voice is covered too. */
export function prewarmVoicesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const named = (env.BOT_TTS_PREWARM_VOICES ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  return [...new Set([TTS_DEFAULT_VOICE, ...named])];
}

/** BOT_TTS_SYNTH_CONCURRENCY: sentences synthesized at once (1..8, default 1). */
export function synthConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number((env.BOT_TTS_SYNTH_CONCURRENCY ?? '').trim());
  return Number.isInteger(v) && v >= 1 ? Math.min(v, TTS_SYNTH_CONCURRENCY_MAX) : TTS_SYNTH_CONCURRENCY_DEFAULT;
}

/** A full stop after one of these is not the end of a sentence. */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'no', 'inc', 'ltd', 'co']);

/** Cut one over-long sentence at clause boundaries (", " "; " ": "), keeping every piece under
 *  TTS_SENTENCE_MAX_CHARS where the text allows it. */
function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= TTS_SENTENCE_MAX_CHARS) return [sentence];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > TTS_SENTENCE_MAX_CHARS) {
    const head = rest.slice(0, TTS_SENTENCE_MAX_CHARS);
    const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
    if (cut < TTS_SENTENCE_MIN_CHARS) break;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Split a line into the sentences it is synthesized and cached by. A sentence ends at . ! ? or …
 * (with any closing quote or bracket) followed by whitespace; not after an abbreviation, a single
 * initial, or inside a number ("3.5", "v1.2"). A very short sentence joins the next one and an
 * over-long one is cut at a clause boundary. Speak and prewarm both use this, so their cache keys
 * are the same. Whitespace is normalised; joining the result with spaces gives the line back.
 */
export function splitSentences(text: string): string[] {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return [];
  const raw: string[] = [];
  let start = 0;
  const end = /[.!?…]+["'”’)\]]*\s+/g;
  for (let m = end.exec(line); m; m = end.exec(line)) {
    const sentence = line.slice(start, m.index + m[0].length).trim();
    const lastWord = (sentence.replace(/[.!?…"'”’)\]]+$/, '').split(' ').pop() ?? '').toLowerCase();
    const endsWithStop = /\.["'”’)\]]*$/.test(sentence) && !/[!?…]/.test(m[0]);
    if (endsWithStop && (ABBREVIATIONS.has(lastWord) || /^[a-z]$/.test(lastWord))) continue;
    raw.push(sentence);
    start = m.index + m[0].length;
  }
  if (start < line.length) raw.push(line.slice(start).trim());
  // A very short sentence joins the one after it (or, at the end, the one before).
  const joined: string[] = [];
  let carry = '';
  for (const s of raw) {
    const cur = carry ? `${carry} ${s}` : s;
    if (cur.length < TTS_SENTENCE_MIN_CHARS) { carry = cur; continue; }
    joined.push(cur); carry = '';
  }
  if (carry) { if (joined.length) joined[joined.length - 1] += ` ${carry}`; else joined.push(carry); }
  return joined.flatMap(splitLongSentence);
}

/**
 * Make one synthesized clip safe to put next to silence: whole samples only, the DC offset removed
 * (a constant offset is a step, heard as a click, at both edges), and a linear fade of TTS_FADE_MS
 * at each end. Returns a new buffer; samples away from the edges are unchanged apart from the
 * offset.
 */
export function conditionPcm(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / TTS_PCM_BYTES_PER_SAMPLE);
  const out = Buffer.from(pcm.subarray(0, samples * TTS_PCM_BYTES_PER_SAMPLE));
  if (samples === 0) return out;
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += out.readInt16LE(i * 2);
  const mean = Math.round(sum / samples);
  const dc = Math.abs(mean) >= TTS_DC_OFFSET_MIN ? mean : 0;
  const fade = Math.min(Math.round((TTS_PCM_RATE_HZ * TTS_FADE_MS) / 1000), Math.floor(samples / 2));
  if (!dc && !fade) return out;
  for (let i = 0; i < samples; i++) {
    const edge = Math.min(i, samples - 1 - i);
    if (!dc && edge >= fade) { i = samples - 1 - fade; continue; }   // the untouched middle
    const gain = edge < fade ? edge / fade : 1;
    const v = Math.round((out.readInt16LE(i * 2) - dc) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}

/** The Vexa TTS service (OpenAI-compatible /v1/audio/speech, raw 24 kHz s16le PCM). */
export function ttsServiceSynthesize(log: (m: string) => void, env: NodeJS.ProcessEnv = process.env): Synthesize {
  return (text, voice) => new Promise<Readable | null>((resolve) => {
    const base = env.TTS_SERVICE_URL?.trim();
    if (!base) { log('[tts] TTS_SERVICE_URL not set — speak is a no-op'); resolve(null); return; }
    const postData = JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'pcm' });
    let url: URL;
    try { url = new URL(`${base.replace(/\/$/, '')}/v1/audio/speech`); }
    catch { log(`[tts] bad TTS_SERVICE_URL: ${base}`); resolve(null); return; }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(postData)),
    };
    const token = env.TTS_API_TOKEN?.trim();
    if (token) headers['X-API-Key'] = token;
    const req = (url.protocol === 'https:' ? https : http).request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    }, (res) => {
      if (res.statusCode !== 200) {
        let body = ''; res.on('data', (c) => (body += c));
        res.on('end', () => { log(`[tts] service ${res.statusCode}: ${body.slice(0, 120)}`); resolve(null); });
        return;
      }
      resolve(res);
    });
    req.on('error', (e) => { log(`[tts] request error: ${String(e)}`); resolve(null); });
    req.write(postData); req.end();
  });
}

/** paplay on tts_sink, unmuted only while it plays. */
export function paplayPlayer(log: (m: string) => void): Player {
  return {
    start() {
      setTtsMute(false, log);                         // open the mic only during playback
      const p: ChildProcess = spawn('paplay', PAPLAY_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
      p.stderr?.on('data', (d: Buffer) => log(`[tts] paplay: ${d.toString().trim()}`));
      p.stdin?.on('error', () => { /* the player went away (barge-in); its exit settles the line */ });
      const done = new Promise<void>((resolve) => {
        const end = () => { setTtsMute(true, log); resolve(); };
        p.on('exit', end);
        p.on('error', (e) => { log(`[tts] paplay error: ${String(e)}`); end(); });
      });
      return {
        input: p.stdin!,
        done,
        kill: () => { try { p.stdin?.destroy(); p.kill('SIGKILL'); } catch { /* */ } },
      };
    },
  };
}

const keyOf = (voice: string, text: string) => `${voice}\u0000${text}`;

/** Build a TtsPlayback that plays the TTS service's PCM sentence by sentence, caching sentences. */
export function createTtsPlayback(
  log: (m: string) => void = () => { /* */ },
  deps: {
    synthesize?: Synthesize; player?: Player; prewarmLines?: string[]; prewarmVoices?: string[];
    concurrency?: number; now?: () => number;
  } = {},
): TtsPlayback {
  const synthesize = deps.synthesize ?? ttsServiceSynthesize(log);
  const player = deps.player ?? paplayPlayer(log);
  const prewarmLines = deps.prewarmLines ?? prewarmLinesFromEnv();
  const prewarmVoices = deps.prewarmVoices ?? prewarmVoicesFromEnv();
  const concurrency = Math.max(1, deps.concurrency ?? synthConcurrencyFromEnv());
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Buffer>();            // insertion order = least recently used first
  let cachedBytes = 0;
  const fetching = new Map<string, Promise<Buffer | null>>();   // per key: the request in flight
  const warming = new Map<string, Promise<void>>();   // per voice: its prewarm, started once
  let current: { kill(): void } | null = null;
  let generation = 0;                                 // bumped by stop(): a line in progress ends
  let speaking = 0;                                   // lines being spoken (a prewarm yields to them)
  let idle: (() => void) | null = null;

  const cacheable = (text: string) => text.length <= TTS_CACHE_MAX_CHARS;
  const remember = (key: string, pcm: Buffer): void => {
    if (pcm.length === 0 || pcm.length > TTS_CACHE_MAX_BYTES) return;
    const prev = cache.get(key);
    if (prev) { cachedBytes -= prev.length; cache.delete(key); }
    cache.set(key, pcm);
    cachedBytes += pcm.length;
    for (const [k, v] of cache) {
      if (cache.size <= TTS_CACHE_MAX_ENTRIES && cachedBytes <= TTS_CACHE_MAX_BYTES) break;
      cache.delete(k); cachedBytes -= v.length;
    }
  };
  const recall = (key: string): Buffer | undefined => {
    const pcm = cache.get(key);
    if (pcm) { cache.delete(key); cache.set(key, pcm); }   // most recently used
    return pcm;
  };
  const collect = (stream: Readable): Promise<Buffer | null> => new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (e) => { log(`[tts] synthesis stream error: ${String(e)}`); resolve(null); });
  });

  /** One sentence's conditioned PCM: from the cache, from a request already in flight for it, or
   *  from a new request. Null when the service could not answer. */
  const fetchPcm = (sentence: string, voice: string): Promise<Buffer | null> => {
    const key = keyOf(voice, sentence);
    const hit = cacheable(sentence) ? recall(key) : undefined;
    if (hit) return Promise.resolve(hit);
    const flying = fetching.get(key);
    if (flying) return flying;
    const p = (async (): Promise<Buffer | null> => {
      const stream = await synthesize(sentence, voice);
      const raw = stream ? await collect(stream) : null;
      if (!raw || raw.length === 0) return null;
      const pcm = conditionPcm(raw);
      if (cacheable(sentence)) remember(key, pcm);
      return pcm;
    })().catch((e) => { log(`[tts] synthesis failed: ${String(e)}`); return null; })
      .finally(() => { fetching.delete(key); });
    fetching.set(key, p);
    return p;
  };

  const prewarm = async (lines: string[], voice = TTS_DEFAULT_VOICE): Promise<void> => {
    for (const sentence of lines.flatMap(splitSentences)) {
      if (!cacheable(sentence) || cache.has(keyOf(voice, sentence))) continue;
      // A line being spoken has the TTS service to itself; the prewarm goes on after it.
      while (speaking > 0) await new Promise<void>((r) => { idle = r; });
      await fetchPcm(sentence, voice);
    }
  };
  /** The configured lines for `voice`, synthesized once in the background. */
  const warm = (voice: string): void => {
    if (!prewarmLines.length || warming.has(voice)) return;
    const started = now();
    const p = prewarm(prewarmLines, voice)
      .then(() => log(`[tts] prewarmed ${prewarmLines.length} line(s) for voice ${voice} in ${now() - started} ms`))
      .catch((e) => log(`[tts] prewarm failed: ${String(e)}`));
    warming.set(voice, p);
  };

  const stop = (): void => {
    generation++;
    if (current) { current.kill(); current = null; }
    setTtsMute(true, log);
  };

  const speak = async (text: string, voice = TTS_DEFAULT_VOICE, hooks?: TtsSpeakHooks): Promise<number> => {
    const sentences = splitSentences(text);
    if (!sentences.length) return 0;
    const mine = generation;
    const started = now();
    speaking++;
    try {
      // Requests run `concurrency` at a time, in order, ahead of the sentence being played.
      const wanted: Array<Promise<Buffer | null> | undefined> = new Array(sentences.length);
      let next = 0, flying = 0, cachedHits = 0, firstCached = false;
      const pump = (): void => {
        while (mine === generation && next < sentences.length && flying < concurrency) {
          const i = next++;
          if (cacheable(sentences[i]) && cache.has(keyOf(voice, sentences[i]))) { cachedHits++; if (i === 0) firstCached = true; }
          flying++;
          wanted[i] = fetchPcm(sentences[i], voice).finally(() => { flying--; pump(); });
        }
      };
      pump();

      let p: ReturnType<Player['start']> | null = null;
      let bytes = 0, firstAudioMs = -1, played = 0, dropped = false, stalledMs = 0;
      const readyMs: number[] = [];                   // per sentence: request to its PCM in hand
      for (let i = 0; i < sentences.length && mine === generation; i++) {
        const waitStart = now();
        const pcm = await wanted[i];
        readyMs.push(now() - started);
        if (p) stalledMs += now() - waitStart;        // playing, and waiting for the next sentence: a gap in the speech
        if (mine !== generation) break;
        if (!pcm) {
          // Nothing is spoken out of order or with a hole in it: the line ends at the last sentence
          // that could be synthesized.
          if (sentences.length > 1) log(`[tts] sentence ${i + 1}/${sentences.length} not synthesized; the line ends before it`);
          dropped = true;
          break;
        }
        if (!p) {
          p = player.start();
          current = p;
          firstAudioMs = now() - started;
          try { hooks?.onFirstAudio?.(); } catch { /* a report hook never stops the line */ }
        }
        p.input.write(pcm);
        bytes += pcm.length;
        played++;
      }
      // A stop (barge-in) is not a failure; a sentence that could not be synthesized is, and a line
      // with no audio at all is never reported as spoken.
      const interrupted = mine !== generation;
      if (!p) {
        if (!interrupted) throw new TtsIncompleteError(0, 0, sentences.length);
        return 0;
      }
      p.input.end();
      await p.done;
      if (current === p) current = null;
      log(`[tts] line: ${sentences.length} sentence(s), ${cachedHits} cached, first audio after ${firstAudioMs} ms, `
        + `${Math.round(bytes / TTS_PCM_BYTES_PER_MS)} ms of audio, ${now() - started} ms in all, `
        + `sentences ready at [${readyMs.join(', ')}] ms, ${stalledMs} ms stalled between sentences`);
      try {
        hooks?.onLine?.({ synthMs: firstCached ? 0 : firstAudioMs, cached: cachedHits === sentences.length, sentences: sentences.length });
      } catch { /* a report hook never stops the line */ }
      const playedMs = Math.round(bytes / TTS_PCM_BYTES_PER_MS);
      if (dropped && !interrupted) throw new TtsIncompleteError(playedMs, played, sentences.length);
      return playedMs;
    } finally {
      speaking--;
      if (speaking === 0 && idle) { const wake = idle; idle = null; wake(); }
      warm(voice);
    }
  };

  // The configured lines are synthesized for every voice the bot starts with, as soon as it can speak.
  if (prewarmLines.length) for (const voice of prewarmVoices) warm(voice);

  return { speak, prewarm, stop };
}
