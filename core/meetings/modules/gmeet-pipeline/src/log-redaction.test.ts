/**
 * redactFilteredLog: a hallucination-filter [FILTERED] log line must never carry the quoted
 * transcript text into pod logs — only the marker, the speaker name and the text's length.
 * Run: npx tsx src/log-redaction.test.ts
 */
import { redactFilteredLog } from './log.js';

let failed = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}`);
  if (!cond) { failed++; if (extra !== undefined) console.log('    ', extra); }
};

{
  const secret = 'the Q3 numbers are confidential, don\'t share them';
  const line = `[SpeakerStreams] [FILTERED] Hallucination for "Alice": "${secret}"`;
  const out = redactFilteredLog(line);
  check('a GMeet hallucination log carries the length of the text, never the text',
    !out.includes(secret) && out.includes('[FILTERED]') && out.includes(`${secret.length} chars`), out);
}

{
  const secret = 'said "hi" mid-sentence';
  const out = redactFilteredLog(`[SpeakerStreams] [FILTERED] Hallucination segment for "Bob": "${secret}"`);
  check('a quote inside the text does not leak the rest of it', !out.includes('hi') && !out.includes('mid-sentence'), out);
}

{
  const out = redactFilteredLog(`[SpeakerStreams] [FILTERED] Hallucination in emit for "Carol": "anything"`);
  check('redacted line keeps the speaker name', out.includes('"Carol"'), out);
}

{
  const line = `[SpeakerStreams] Dedup skip for "Dave": "kept as-is" (same as last confirmed)`;
  check('a non-[FILTERED] log line is unchanged', redactFilteredLog(line) === line);
}

if (failed) { console.error(`\n❌ log-redaction: ${failed} check(s) FAILED.`); process.exit(1); }
console.log('\n✅ log-redaction: [FILTERED] hallucination log lines never carry transcript text.');
