/**
 * Transcript rendering pipeline — pure unit test for dedup, grouping and
 * timestamp parsing. No chrome, no WebSocket.
 * Run: npx tsx src/transcript-rendering.test.ts
 */
import {
  deduplicateSegments, upsertSegments, sortSegments, sortByStartTime,
  deduplicateByIdentity,
} from './transcript-rendering/dedup.js';
import { groupSegments } from './transcript-rendering/grouping.js';
import { parseUTCTimestamp } from './transcript-rendering/timestamps.js';
import type { TranscriptSegment } from './transcript-rendering/types.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const t = (s: number): string => new Date(Date.UTC(2025, 0, 1, 0, 0, s)).toISOString();
const seg = (o: Partial<TranscriptSegment> & { text: string; s: number; e: number }): TranscriptSegment => {
  const { s, e, ...rest } = o;
  return { absolute_start_time: t(s), absolute_end_time: t(e), start_time: s, end_time: e, speaker: 'A', ...rest };
};
const texts = (xs: TranscriptSegment[]): string => xs.map(x => x.text).join('|');

// ── timestamps ──
check('naive timestamp is read as UTC',
  parseUTCTimestamp('2025-12-11T14:20:25.222296').toISOString() === '2025-12-11T14:20:25.222Z');
check('Z suffix kept', parseUTCTimestamp('2025-01-01T00:00:00Z').getTime() === Date.UTC(2025, 0, 1));
check('offset kept, not re-read as UTC',
  parseUTCTimestamp('2025-01-01T01:00:00+01:00').getTime() === Date.UTC(2025, 0, 1));

// ── deduplicateSegments ──
check('empty input returned as-is', deduplicateSegments([]).length === 0);
{
  const out = deduplicateSegments([seg({ text: 'hi', s: 0, e: 2, speaker: 'A' }), seg({ text: 'hi', s: 0, e: 2, speaker: 'B' })]);
  check('different speakers never deduped', out.length === 2, texts(out));
}
{
  const out = deduplicateSegments([seg({ text: 'hello', s: 0, e: 2 }), seg({ text: 'hello', s: 2.5, e: 4 })]);
  check('adjacent same text within 1s collapses', out.length === 1, String(out.length));
  check('adjacent dup keeps longer duration', out[0].absolute_start_time === t(0), out[0].absolute_start_time);
}
{
  const out = deduplicateSegments([seg({ text: 'hello', s: 0, e: 2 }), seg({ text: 'hello', s: 5, e: 7 })]);
  check('same text with gap over 1s is kept', out.length === 2);
}
{
  const out = deduplicateSegments([seg({ text: 'hello', s: 0, e: 2 }), seg({ text: 'hello', s: 0, e: 2, completed: true })]);
  check('same text overlap prefers completed', out.length === 1 && out[0].completed === true);
}
{
  const out = deduplicateSegments([seg({ text: 'a long draft', s: 0, e: 10 }), seg({ text: 'a confirmed', s: 2, e: 8, completed: true })]);
  check('confirmed inside wider draft replaces it', out.length === 1 && out[0].completed === true, texts(out));
}
{
  const out = deduplicateSegments([seg({ text: 'inner', s: 2, e: 8 }), seg({ text: 'outer draft', s: 0, e: 10 })]);
  check('wider draft replaces non-completed inner', texts(out) === 'outer draft', texts(out));
}
{
  const out = deduplicateSegments([seg({ text: 'inner done', s: 2, e: 8, completed: true }), seg({ text: 'outer draft', s: 0, e: 10 })]);
  check('wider draft does not replace confirmed inner', texts(out) === 'inner done', texts(out));
}
{
  const out = deduplicateSegments([
    seg({ text: 'we should ship', s: 0, e: 4 }),
    seg({ text: 'We should ship it today.', s: 1, e: 6, completed: true }),
  ]);
  check('expansion of partial text replaces it', texts(out) === 'We should ship it today.', texts(out));
}
{
  const out = deduplicateSegments([
    seg({ text: 'we should ship it today', s: 0, e: 6, completed: true }),
    seg({ text: 'ship it', s: 5, e: 6.5 }),
  ]);
  check('tiny tail-repeat echo is dropped', out.length === 1, texts(out));
}
{
  const out = deduplicateSegments([
    seg({ text: 'we should ship it today', s: 0, e: 6, completed: true }),
    seg({ text: 'ship it', s: 3, e: 9 }),
  ]);
  check('long repeated fragment is kept', out.length === 2, texts(out));
}
{
  const input = [seg({ text: 'x', s: 0, e: 1 }), seg({ text: 'y', s: 0, e: 1 })];
  const copy = [...input];
  deduplicateSegments(input);
  check('input array not mutated', input.length === copy.length && input[0] === copy[0]);
}

// ── upsertSegments ──
{
  const m = new Map<string, TranscriptSegment>();
  upsertSegments(m, [seg({ text: ' ', s: 0, e: 1, segment_id: 'blank' }), { ...seg({ text: 'x', s: 0, e: 1 }), absolute_start_time: '' }]);
  check('blank text and missing start are skipped', m.size === 0, String(m.size));
}
{
  const m = new Map<string, TranscriptSegment>();
  upsertSegments(m, [seg({ text: 'hello wor', s: 0, e: 1, segment_id: 'A:1' })]);
  upsertSegments(m, [seg({ text: 'hello world', s: 0, e: 1, segment_id: 'A:1' })]);
  check('changed text updates in place', m.size === 1 && m.get('A:1')!.text === 'hello world');
}
{
  const m = new Map<string, TranscriptSegment>();
  upsertSegments(m, [seg({ text: 'same', s: 0, e: 1, segment_id: 'A:1', updated_at: '2025-01-01T00:00:05Z' })]);
  upsertSegments(m, [seg({ text: 'same', s: 0, e: 1, segment_id: 'A:1', updated_at: '2025-01-01T00:00:01Z' })]);
  check('stale same-text update is ignored', m.get('A:1')!.updated_at === '2025-01-01T00:00:05Z');
}
{
  const m = new Map<string, TranscriptSegment>();
  upsertSegments(m, [seg({ text: 'draft one', s: 0, e: 1, segment_id: 'A:draft:1' }), seg({ text: 'other', s: 0, e: 1, segment_id: 'B:draft:1', speaker: 'B' })]);
  upsertSegments(m, [seg({ text: 'confirmed', s: 0, e: 1, segment_id: 'A:2', completed: true })]);
  check('confirmed removes same-speaker draft', !m.has('A:draft:1') && m.has('A:2'));
  check('confirmed keeps other speaker draft', m.has('B:draft:1'));
}
{
  const m = new Map<string, TranscriptSegment>();
  upsertSegments(m, [seg({ text: 'dup', s: 0, e: 1, segment_id: 'A:x' }), seg({ text: 'dup', s: 0, e: 1, segment_id: 'A:y', completed: true })]);
  check('same text, different ids: confirmed wins', m.size === 1 && m.has('A:y'), [...m.keys()].join(','));
}
{
  const m = new Map<string, TranscriptSegment>();
  upsertSegments(m, [seg({ text: 'dup', s: 0, e: 1, segment_id: 'A:x', completed: true }), seg({ text: 'dup', s: 0, e: 1, segment_id: 'A:y' })]);
  check('same text, different ids: draft loses to earlier confirmed', m.size === 1 && m.has('A:x'), [...m.keys()].join(','));
}
{
  const m = new Map<string, TranscriptSegment>();
  upsertSegments(m, [seg({ text: 'no id', s: 3, e: 4 })]);
  check('key falls back to absolute_start_time', m.has(t(3)));
}

// ── sorting / identity dedup ──
{
  const out = sortSegments([seg({ text: 'b', s: 5, e: 6 }), seg({ text: 'a', s: 1, e: 2 })]);
  check('sortSegments orders by absolute_start_time', texts(out) === 'a|b');
}
{
  const a = seg({ text: 'late-abs', s: 9, e: 10, start_time: 1 });
  const b = seg({ text: 'early-abs', s: 2, e: 3, start_time: 5 });
  check('sortByStartTime uses speech time', texts(sortByStartTime([b, a])) === 'late-abs|early-abs');
  const c = seg({ text: 'c', s: 7, e: 8, start_time: 5 });
  check('sortByStartTime ties break on absolute time', texts(sortByStartTime([c, b])) === 'early-abs|c');
}
{
  const old = seg({ text: 'old', s: 0, e: 1, segment_id: 'k', updated_at: '2025-01-01T00:00:01Z' });
  const neu = seg({ text: 'new', s: 0, e: 1, segment_id: 'k', updated_at: '2025-01-01T00:00:09Z' });
  const other = seg({ text: 'other', s: 5, e: 6, segment_id: 'z' });
  check('deduplicateByIdentity keeps newer, encounter order', texts(deduplicateByIdentity([old, other, neu])) === 'new|other');
  check('deduplicateByIdentity keeps first when no updated_at',
    texts(deduplicateByIdentity([seg({ text: 'first', s: 0, e: 1, segment_id: 'q' }), seg({ text: 'second', s: 0, e: 1, segment_id: 'q' })])) === 'first');
}

// ── groupSegments ──
check('group of empty/undefined is empty', groupSegments([]).length === 0 && groupSegments(undefined as unknown as TranscriptSegment[]).length === 0);
{
  const g = groupSegments([
    seg({ text: 'one', s: 0, e: 1, speaker: 'A' }),
    seg({ text: 'two', s: 1, e: 2, speaker: 'A' }),
    seg({ text: 'three', s: 2, e: 3, speaker: 'B' }),
    seg({ text: 'four', s: 3, e: 4, speaker: 'A' }),
  ]);
  check('consecutive same speaker merge, interleaving splits', g.length === 3 && g[0].combinedText === 'one two' && g[1].key === 'B' && g[2].key === 'A', JSON.stringify(g.map(x => x.key)));
  check('group start/end taken from first/last segment', g[0].startTime === t(0) && g[0].endTime === t(2) && g[0].startTimeSeconds === 0 && g[0].endTimeSeconds === 2);
}
{
  const g = groupSegments([seg({ text: 'late', s: 5, e: 6 }), seg({ text: 'early', s: 1, e: 2 })]);
  check('segments sorted before grouping', g[0].combinedText === 'early late');
}
{
  const g = groupSegments([seg({ text: '   ', s: 0, e: 1 }), seg({ text: 'real', s: 1, e: 2 })]);
  check('blank segments skipped', g.length === 1 && g[0].segments.length === 1);
}
{
  const g = groupSegments([{ ...seg({ text: 'who', s: 0, e: 1 }), speaker: undefined }]);
  check('missing speaker groups as Unknown', g[0].key === 'Unknown');
}
{
  const g = groupSegments([seg({ text: 'aaaa', s: 0, e: 1 }), seg({ text: 'bbbb', s: 1, e: 2 }), seg({ text: 'cccc', s: 2, e: 3 })], { maxCharsPerGroup: 9 });
  check('long group splits at segment boundary', g.length === 2 && g[0].combinedText === 'aaaa bbbb' && g[1].combinedText === 'cccc', JSON.stringify(g.map(x => x.combinedText)));
}
{
  const g = groupSegments([seg({ text: 'x'.repeat(20), s: 0, e: 1 })], { maxCharsPerGroup: 5 });
  check('single oversize segment is never split mid-segment', g.length === 1 && g[0].combinedText.length === 20);
}
{
  const g = groupSegments([seg({ text: 'a', s: 0, e: 1, speaker: 'A' }), seg({ text: 'b', s: 1, e: 2, speaker: 'B' })], { getGroupKey: () => 'all' });
  check('custom getGroupKey merges across speakers', g.length === 1 && g[0].key === 'all');
}
{
  const s1 = { ...seg({ text: 'a', s: 0, e: 1 }), absolute_end_time: '' };
  const g = groupSegments([s1]);
  check('endTime falls back to start when end missing', g[0].endTime === s1.absolute_start_time);
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
