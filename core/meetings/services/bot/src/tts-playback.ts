/**
 * TTS playback adapter (2b) — the OS-level half of the SPEAK path.  // L4 (O6/VM).
 *
 * The browser half (unmute the meeting-UI mic) lives in capture-bridge.ts's SpeakController; this
 * is the audio half: synthesize `text` via the Vexa TTS service and play the returned PCM through
 * the container's PulseAudio `tts_sink` (→ `virtual_mic`, which Chromium captures as its mic). The
 * `tts_sink → virtual_mic` graph is created by entrypoint.sh; here we only unmute it during
 * playback, stream PCM to `paplay`, and re-mute after.
 *
 * Short lines are kept: the PCM of every line up to TTS_CACHE_MAX_CHARS is cached per (voice, text),
 * and the lines in BOT_TTS_PREWARM ("|"-separated, e.g. an agent's stock acknowledgements) are
 * synthesized ahead of time for each voice the bot speaks with, so a repeated short line starts
 * playing at once instead of after a synthesis round trip (a short sentence takes seconds on a CPU
 * TTS). The cache is bounded (entries and bytes) and lives only as long as the bot.
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

const PAPLAY_ARGS = ['--raw', '--format=s16le', '--rate=24000', '--channels=1', '--device=tts_sink'];

/** Lines up to this many characters are cached (acknowledgements, short replies). */
export const TTS_CACHE_MAX_CHARS = 120;
/** At most this many cached lines... */
export const TTS_CACHE_MAX_ENTRIES = 64;
/** ...and this many bytes of PCM in all (24 kHz s16le: about 3.5 min of speech). */
export const TTS_CACHE_MAX_BYTES = 10 * 1024 * 1024;
/** At most this many BOT_TTS_PREWARM lines are synthesized ahead of time per voice. */
export const TTS_PREWARM_MAX_LINES = 16;

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

export interface TtsPlayback {
  /** Synthesize `text` (voice optional) and play it into the meeting via tts_sink. Resolves when
   *  playback finishes. Best-effort: a synthesis/playback failure logs + resolves (never throws out
   *  — the voice handler must not break the orchestrator). */
  speak(text: string, voice?: string): Promise<void>;
  /** Synthesize `lines` for `voice` into the cache without playing them (lines already cached or too
   *  long are skipped). Resolves when done; failures are logged, never thrown. */
  prewarm(lines: string[], voice?: string): Promise<void>;
  /** Interrupt any in-flight playback (barge-in) + re-mute. */
  stop(): void;
}

/** The PCM of one line from the TTS service: a stream, or null when the service could not answer. */
export type Synthesize = (text: string, voice: string) => Promise<Readable | null>;

/** Where PCM is played. `start` opens the sink and returns the player's input and its end. */
export interface Player {
  start(): { input: NodeJS.WritableStream; done: Promise<void>; kill(): void };
}

/** BOT_TTS_PREWARM: "|"-separated lines, trimmed, empty ones dropped, bounded. */
export function prewarmLinesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.BOT_TTS_PREWARM ?? '';
  return raw.split('|').map((l) => l.trim()).filter((l) => l.length > 0 && l.length <= TTS_CACHE_MAX_CHARS)
    .slice(0, TTS_PREWARM_MAX_LINES);
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

/** Build a TtsPlayback that streams the TTS service's PCM to the player, caching short lines. */
export function createTtsPlayback(
  log: (m: string) => void = () => { /* */ },
  deps: { synthesize?: Synthesize; player?: Player; prewarmLines?: string[] } = {},
): TtsPlayback {
  const synthesize = deps.synthesize ?? ttsServiceSynthesize(log);
  const player = deps.player ?? paplayPlayer(log);
  const prewarmLines = deps.prewarmLines ?? prewarmLinesFromEnv();
  const cache = new Map<string, Buffer>();            // insertion order = least recently used first
  let cachedBytes = 0;
  const warming = new Map<string, Promise<void>>();   // per voice: its prewarm, started once
  let current: { kill(): void } | null = null;

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

  const prewarm = async (lines: string[], voice = 'auto'): Promise<void> => {
    for (const text of lines) {
      if (!cacheable(text) || cache.has(keyOf(voice, text))) continue;
      const stream = await synthesize(text, voice);
      const pcm = stream ? await collect(stream) : null;
      if (pcm) remember(keyOf(voice, text), pcm);
    }
  };
  /** The configured lines for `voice`, synthesized once in the background (first use of a voice). */
  const warm = (voice: string): void => {
    if (!prewarmLines.length || warming.has(voice)) return;
    const p = prewarm(prewarmLines, voice).then(() => log(`[tts] prewarmed ${prewarmLines.length} line(s) for voice ${voice}`))
      .catch((e) => log(`[tts] prewarm failed: ${String(e)}`));
    warming.set(voice, p);
  };

  const stop = (): void => {
    if (current) { current.kill(); current = null; }
    setTtsMute(true, log);
  };

  const play = async (feed: (input: NodeJS.WritableStream) => void): Promise<void> => {
    const p = player.start();
    current = p;
    feed(p.input);
    await p.done;
    if (current === p) current = null;
  };

  const speak = async (text: string, voice = 'auto'): Promise<void> => {
    const key = keyOf(voice, text);
    const hit = cacheable(text) ? recall(key) : undefined;
    if (hit) {
      log(`[tts] cached line (${hit.length} bytes)`);
      await play((input) => input.end(hit));
      warm(voice);
      return;
    }
    const stream = await synthesize(text, voice);
    if (!stream) return;
    const chunks: Buffer[] | null = cacheable(text) ? [] : null;
    if (chunks) {
      stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      stream.on('end', () => remember(key, Buffer.concat(chunks)));
    }
    await play((input) => { stream.pipe(input); });   // stream PCM straight to the mic sink
    warm(voice);
  };

  // The configured lines for the default voice are synthesized as soon as the bot can speak.
  if (prewarmLines.length) warm('auto');

  return { speak, prewarm, stop };
}
