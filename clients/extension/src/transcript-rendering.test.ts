/**
 * transcript-rendering grouping + timestamp parsing: speaker merge, ordering, blank-segment
 * skipping, char-budget chunking, custom keys, and UTC interpretation of zoneless timestamps.
 * Pure: no chrome.
 * Run: npx tsx src/transcript-rendering.test.ts
 */
import { groupSegments } from './transcript-rendering/grouping.js';
import { parseUTCTimestamp } from './transcript-rendering/timestamps.js';
import type { TranscriptSegment } from './transcript-rendering/types.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const seg = (speaker: string | undefined, text: string, start: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  speaker,
  text,
  absolute_start_time: start,
  absolute_end_time: start,
  ...extra,
});

// empty / nullish input
check('empty array → no groups', groupSegments([]).length === 0);
check('nullish input → no groups', groupSegments(undefined as unknown as TranscriptSegment[]).length === 0);

// consecutive same speaker merge; speaker change splits
{
  const g = groupSegments([
    seg('A', 'hello', '2025-01-01T00:00:01Z'),
    seg('A', 'there', '2025-01-01T00:00:02Z'),
    seg('B', 'hi', '2025-01-01T00:00:03Z'),
    seg('A', 'back', '2025-01-01T00:00:04Z'),
  ]);
  check('A,A,B,A → 3 groups', g.length === 3, JSON.stringify(g.map((x) => x.key)));
  check('same-speaker text joined with a space', g[0].combinedText === 'hello there', g[0].combinedText);
  check('non-adjacent same speaker is not merged', g[2].key === 'A' && g[2].combinedText === 'back');
}

// input is sorted by absolute_start_time and not mutated
{
  const input = [
    seg('B', 'second', '2025-01-01T00:00:02Z'),
    seg('A', 'first', '2025-01-01T00:00:01Z'),
  ];
  const g = groupSegments(input);
  check('sorted by start time', g[0].key === 'A' && g[1].key === 'B', JSON.stringify(g.map((x) => x.key)));
  check('input array not mutated', input[0].text === 'second');
}

// blank / whitespace-only text is dropped and does not break a run
{
  const g = groupSegments([
    seg('A', 'one', '2025-01-01T00:00:01Z'),
    seg('B', '   ', '2025-01-01T00:00:02Z'),
    seg('A', 'two', '2025-01-01T00:00:03Z'),
  ]);
  check('blank segment skipped, neighbours merge', g.length === 1 && g[0].combinedText === 'one two', JSON.stringify(g));
}

// missing speaker → "Unknown"
check('no speaker → key Unknown', groupSegments([seg(undefined, 'x', '2025-01-01T00:00:01Z')])[0].key === 'Unknown');

// group boundaries: start/end times, fallbacks
{
  const g = groupSegments([
    seg('A', 'a', '2025-01-01T00:00:01Z', { absolute_end_time: '2025-01-01T00:00:02Z', start_time: 1, end_time: 2 }),
    seg('A', 'b', '2025-01-01T00:00:03Z', { absolute_end_time: '', start_time: 3, end_time: 4 }),
  ])[0];
  check('startTime from first segment', g.startTime === '2025-01-01T00:00:01Z');
  check('endTime falls back to last start when end is empty', g.endTime === '2025-01-01T00:00:03Z', g.endTime);
  check('relative seconds taken from first start / last end', g.startTimeSeconds === 1 && g.endTimeSeconds === 4);
  const bare = groupSegments([seg('A', 'a', '2025-01-01T00:00:01Z')])[0];
  check('missing relative seconds default to 0', bare.startTimeSeconds === 0 && bare.endTimeSeconds === 0);
}

// char budget splits at segment boundaries, never inside a segment
{
  const g = groupSegments(
    [
      seg('A', 'aaaa', '2025-01-01T00:00:01Z'),
      seg('A', 'bbbb', '2025-01-01T00:00:02Z'),
      seg('A', 'cccc', '2025-01-01T00:00:03Z'),
    ],
    { maxCharsPerGroup: 9 },
  );
  check('9-char budget → 2 chunks', g.length === 2, JSON.stringify(g.map((x) => x.combinedText)));
  check('chunk 1 holds aaaa bbbb (exactly 9)', g[0].combinedText === 'aaaa bbbb');
  check('chunk 2 holds cccc, same key', g[1].combinedText === 'cccc' && g[1].key === 'A');
  const big = groupSegments([seg('A', 'x'.repeat(50), '2025-01-01T00:00:01Z')], { maxCharsPerGroup: 5 });
  check('a single oversize segment is kept whole', big.length === 1 && big[0].combinedText.length === 50);
}

// custom group key
{
  const g = groupSegments(
    [seg('A', 'a', '2025-01-01T00:00:01Z'), seg('B', 'b', '2025-01-01T00:00:02Z')],
    { getGroupKey: () => 'all' },
  );
  check('custom getGroupKey merges across speakers', g.length === 1 && g[0].key === 'all');
}

// timestamps
check('zoneless → treated as UTC', parseUTCTimestamp('2025-12-11T14:20:25.222296').toISOString() === '2025-12-11T14:20:25.222Z');
check('Z suffix kept', parseUTCTimestamp('2025-12-11T14:20:25Z').toISOString() === '2025-12-11T14:20:25.000Z');
check('lowercase z kept', parseUTCTimestamp('2025-12-11T14:20:25z').getTime() === Date.parse('2025-12-11T14:20:25Z'));
check('+offset honoured', parseUTCTimestamp('2025-12-11T14:20:25+02:00').toISOString() === '2025-12-11T12:20:25.000Z');
check('-offset honoured', parseUTCTimestamp('2025-12-11T14:20:25-05:00').toISOString() === '2025-12-11T19:20:25.000Z');

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall transcript-rendering checks passed');
