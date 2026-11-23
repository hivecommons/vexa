// Host-injectable logger (the brick's only former coupling to the bot's utils).
type LogFn = (message: string, level?: string, ...rest: any[]) => void;
let _log: LogFn = (m, level) => console.log(level && level !== 'info' ? `[${level}] ${m}` : m);
export function setLogger(fn: LogFn): void { _log = fn; }
export const log: LogFn = (m, level, ...rest) => _log(m, level, ...rest);

/**
 * A `[FILTERED] ... "<quoted transcript>"` log line with the quoted text replaced by its length.
 * The hallucination-filter log lines quote up to 60 characters of what someone actually said in
 * the meeting (and so would put speech into pod logs, before consent included); only the marker,
 * the speaker name and the text's length are kept. Mirrors the Teams-lane redaction in
 * `services/bot/src/pipeline.ts` (`redactTeamsLaneLog`).
 */
export function redactFilteredLog(message: string): string {
  if (!message.includes('[FILTERED]')) return message;
  return message.replace(/:\s*"([\s\S]*)"\s*$/, (_all, text: string) => `: <${text.length} chars redacted>`);
}
