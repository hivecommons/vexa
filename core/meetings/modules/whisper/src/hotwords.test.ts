/**
 * Hotwords and a fixed prompt opening ride every transcription request when configured, and never
 * when not: `hotwords` as its own form part, the opening in front of the lane's rolling context in
 * `prompt`. Configuration text is one bounded line (it cannot add a form part).
 *   npx tsx src/hotwords.test.ts
 */
import { TranscriptionClient, STT_BIAS_MAX_CHARS, sttBiasText } from './transcription-client.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => { console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  : ' + detail}`); if (!cond) failed++; };

const realFetch = globalThis.fetch;
function captureFetch(): () => string {
  let body = '';
  (globalThis as any).fetch = async (_url: unknown, init: { body: Buffer }) => {
    body = Buffer.from(init.body).toString('utf8');
    return new Response(JSON.stringify({ text: 'ok', language: 'en', duration: 0.1, segments: [] }), { status: 200 });
  };
  return () => body;
}
const part = (body: string, name: string): string | null => {
  const m = body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`));
  return m ? m[1] : null;
};
const pcm = new Float32Array(1600).fill(0.05);

{
  const body = captureFetch();
  const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', hotwords: 'Betty, hive queue, pull request', initialPrompt: 'A meeting about the hive.' });
  await client.transcribe(pcm, 'en', 'how many issues are');
  check('hotwords are sent as their own form part', part(body(), 'hotwords') === 'Betty, hive queue, pull request', String(part(body(), 'hotwords')));
  check('the prompt opens with the configured text, then the rolling context',
    part(body(), 'prompt') === 'A meeting about the hive. how many issues are', String(part(body(), 'prompt')));
  await client.transcribe(pcm, 'en');
  check('a request with no rolling context still carries both', part(body(), 'hotwords') !== null && part(body(), 'prompt') === 'A meeting about the hive.', String(part(body(), 'prompt')));
}
{
  const body = captureFetch();
  const client = new TranscriptionClient({ serviceUrl: 'http://stt.test' });
  await client.transcribe(pcm, 'en', 'context only');
  check('not configured: no hotwords part, the prompt is the rolling context alone',
    part(body(), 'hotwords') === null && part(body(), 'prompt') === 'context only', body().slice(0, 80));
  await client.transcribe(pcm, 'en');
  check('not configured and no context: no prompt part at all', part(body(), 'prompt') === null);
}
{
  const body = captureFetch();
  const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', hotwords: 'Betty\r\n--x\r\nContent-Disposition: form-data; name="model"\r\n\r\nevil', initialPrompt: '   ' });
  await client.transcribe(pcm, 'en');
  check('configuration text is one line: it cannot add a form part',
    (body().match(/name="model"\r\n/g) ?? []).length === 1 && !/\r\n--x\r\n/.test(body()), String(part(body(), 'hotwords')));
  check('a blank prompt opening sends nothing', part(body(), 'prompt') === null);
  check('the text is bounded', sttBiasText('word '.repeat(1000)).length <= STT_BIAS_MAX_CHARS && sttBiasText(undefined) === '');
}

globalThis.fetch = realFetch;
if (failed) { console.error(`\n❌ hotwords: ${failed} check(s) FAILED.`); process.exit(1); }
console.log('\n✅ hotwords: configured names and a prompt opening ride every request; nothing is sent when unset');
