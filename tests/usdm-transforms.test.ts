import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAnchorTiming, parseTiming, parseWindow, splitTiming, visitWindowText } from '../server/usdm/transforms.ts';

const isFail = (r: any) => 'ok' in r && r.ok === false;

test('Day 1 is the timing anchor (P0D)', () => {
  assert.equal(isAnchorTiming('Day 1'), true);
  const t = parseTiming('Day 1') as any;
  assert.equal(t.kind, 'anchor');
  assert.equal(t.value, 'P0D');
});

test('Day N and Week N convert to ISO 8601 durations relative to Day 1', () => {
  assert.deepEqual(parseTiming('Day 5'), { kind: 'after', value: 'P4D', label: 'Day 5' });
  assert.deepEqual(parseTiming('Week 4'), { kind: 'after', value: 'P4W', label: 'Week 4' });
  assert.deepEqual(parseTiming('Day -7'), { kind: 'before', value: 'P7D', label: 'Day -7' });
});

test('visit windows parse ± and asymmetric bounds; inline windows fall back from timing', () => {
  const w = parseWindow('± 3 d') as any;
  assert.equal(w.lower, '-P3D');
  assert.equal(w.upper, 'P3D');
  const asym = parseWindow('-2/+5 days') as any;
  assert.equal(asym.lower, '-P2D');
  assert.equal(asym.upper, 'P5D');
  const { point, inlineWindow } = splitTiming('Week 4 ± 3 d');
  assert.equal(point, 'Week 4');
  assert.match(inlineWindow, /±/);
  assert.equal(visitWindowText({ timing: 'Week 4 ± 3 d', window: '' }), '± 3 d');
  assert.equal(visitWindowText({ timing: 'Week 4', window: '± 2 d' }), '± 2 d');
});

test('ranges and Day 0 are not converted (no forced mapping)', () => {
  assert.ok(isFail(parseTiming('Day -28 to -1')));
  assert.ok(isFail(parseTiming('Day 0')));
});
