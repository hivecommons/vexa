/**
 * The bot's in-meeting act handler — routes the acts.v1 actions the bot performs IN the meeting
 * (beside `leave`, which the orchestrator owns) to the controller that performs them:
 *   • speak / speak_stop → the SpeakController (gated inside it on voiceAgentEnabled). When a speak
 *                          carries an `id`, its progress goes back through the injected `speakReport`
 *                          (transcript.v1 `SpeakResult`): `speaking` once the mic is confirmed open
 *                          and synthesis starts, then `spoken` with `duration_ms` and where the
 *                          line's time went (`queue_ms`, `mic_ms`, `first_audio_ms`, `synth_ms`,
 *                          `cached`), or `failed` with the controller's `SpeakFailure` reason.
 *   • chat_send          → the ChatSender (ungated — a text act, not a voice one). When the act
 *                          carries an `id`, its outcome goes back to meeting-api through the injected
 *                          `report` (a transcript.v1 `ChatSendResult` on the signed stream): `posted`,
 *                          or not with the sender's `ChatSendFailure` reason. Without an id nothing is
 *                          reported.
 * Every other action is ignored here. Pure: the controllers are injected, so the routing is
 * provable without a browser.
 */
import type { Act } from './contracts.js';
import type { ChatSendResult, SpeakHooks, SpeakResult } from './capture-bridge.js';
import type { ChatSendReport, SpeakReport } from './ports.js';

export interface ActControllers {
  speak: { speak(text: string, voice?: string, hooks?: SpeakHooks): Promise<SpeakResult>; stop(): Promise<void> };
  chat: { send(text: string): Promise<ChatSendResult> };
  /** Where a chat send that carried an `id` reports its outcome. */
  report?: (r: ChatSendReport) => Promise<void>;
  /** Where a speak that carried an `id` reports its progress and outcome. */
  speakReport?: (r: SpeakReport) => Promise<void>;
}

/** The in-meeting act handler, plus `idle()`: resolves once no speak or chat send it took is still
 *  in progress (the orchestrator waits on it, bounded, before the platform leave, so a last line
 *  is heard or posted). */
export type ActDispatch = ((act: Act) => Promise<void>) & { idle(): Promise<void> };

export function createActDispatch(c: ActControllers): ActDispatch {
  const report = async (r: ChatSendReport): Promise<void> => {
    if (!c.report) return;
    // Best-effort: a lost report reads as `unconfirmed` on meeting-api's side, never as a failure here.
    await c.report(r).catch((e) => console.error(`[bot] chat_send_result not reported: ${String(e)}`));
  };
  const reportSpeak = async (r: SpeakReport): Promise<void> => {
    if (!c.speakReport) return;
    // Best-effort: a lost report reads as `unconfirmed` on meeting-api's side, never as a failure here.
    await c.speakReport(r).catch((e) => console.error(`[bot] speak_result not reported: ${String(e)}`));
  };
  const int = (v: number): number => Math.max(0, Math.round(v));
  const handle = async (act: Act): Promise<void> => {
    if (act.action === 'speak') {
      const id = typeof act.id === 'string' && act.id ? act.id : undefined;
      const r = await c.speak.speak(act.text, act.voice,
        id ? { onStart: () => { void reportSpeak({ id, status: 'speaking' }); } } : undefined);
      if (id) {
        const t = r.spoken ? r.timing : undefined;
        await reportSpeak(r.spoken
          ? {
            id, status: 'spoken', duration_ms: int(r.durationMs),
            ...(t ? { queue_ms: int(t.queueMs), mic_ms: int(t.micMs) } : {}),
            ...(t?.firstAudioMs !== undefined ? { first_audio_ms: int(t.firstAudioMs) } : {}),
            ...(t?.synthMs !== undefined ? { synth_ms: int(t.synthMs) } : {}),
            ...(t?.cached !== undefined ? { cached: t.cached } : {}),
          }
          : { id, status: 'failed', reason: r.reason });
      }
    }
    else if (act.action === 'speak_stop') await c.speak.stop();
    else if (act.action === 'chat_send') {
      const id = typeof act.id === 'string' && act.id ? act.id : undefined;
      if (typeof act.text !== 'string' || !act.text.trim()) {
        console.error('[bot] chat_send ignored: empty text');
        if (id) await report({ id, posted: false, reason: 'empty_text' });
        return;
      }
      const r = await c.chat.send(act.text);
      if (id) await report(r.sent ? { id, posted: true } : { id, posted: false, reason: r.reason });
    }
  };
  const busy = new Set<Promise<void>>();
  const dispatch = (act: Act): Promise<void> => {
    if (act.action !== 'speak' && act.action !== 'chat_send') return handle(act);
    const p = handle(act);
    const tracked = p.catch(() => undefined).finally(() => { busy.delete(tracked); });
    busy.add(tracked);
    return p;
  };
  return Object.assign(dispatch, {
    async idle(): Promise<void> { while (busy.size) await Promise.all([...busy]); },
  });
}
