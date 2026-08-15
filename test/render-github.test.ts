import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildIssueComment, buildIssueBody } from '../src/render/github.ts'
import type { Delta } from '../src/diff.ts'

function delta(over: Partial<Delta> = {}): Delta {
  return {
    appId: '534278133',
    appName: 'Clock In',
    date: '2026-08-15',
    isFirstRun: false,
    baselineDate: '2026-08-14',
    countryCount: 32,
    worldwide: {
      totalBefore: 7776,
      totalAfter: 7786,
      net: 10,
      avgBefore: 4.5968,
      avgAfter: 4.59723,
      avgChange: 0.00043,
      stars: { 1: 2, 2: 0, 3: 0, 4: 0, 5: 8 },
    },
    changedCountries: [
      { country: 'us', net: 9, stars: { 1: 2, 2: 0, 3: 0, 4: 0, 5: 7 }, avgBefore: 4.5, avgAfter: 4.52 },
      { country: 'gb', net: 1, stars: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 }, avgBefore: 4.6, avgAfter: 4.6 },
    ],
    failures: [],
    ...over,
  }
}

test('the comment leads with the date and the app name', () => {
  const md = buildIssueComment([delta()])
  assert.match(md, /^## 2026-08-15/)
  assert.match(md, /### Clock In/)
})

test('per-star net changes render as a table', () => {
  const md = buildIssueComment([delta()])
  assert.match(md, /\| Rating \| Net change \|/)
  assert.match(md, /\| ★★★★★ \| \+8 \|/)
  assert.match(md, /\| ★ \| \+2 \|/)
})

test('countries that moved go in a collapsed section', () => {
  const md = buildIssueComment([delta()])
  assert.match(md, /<details>/)
  assert.match(md, /Countries that moved \(2\)/)
  assert.match(md, /`US` \| \+9/)
})

test('the net-change caveat is present whenever a delta is shown', () => {
  assert.match(buildIssueComment([delta()]), /Net change since the previous snapshot/)
})

test('a first run says so and omits the caveat', () => {
  const md = buildIssueComment([delta({ isFirstRun: true })])
  assert.match(md, /Baseline recorded/)
  assert.match(md, /First run/)
  assert.doesNotMatch(md, /Net change since the previous snapshot/)
})

test('failures are surfaced on a first run too', () => {
  // A baseline taken from a partial fetch skews every delta after it.
  const md = buildIssueComment([
    delta({ isFirstRun: true, failures: [{ country: 'jp', reason: 'timeout' }] }),
  ])
  assert.match(md, /\[!WARNING\]/)
  assert.match(md, /JP/)
})

test('a zero average change reads as ± rather than a contradictory arrow', () => {
  const md = buildIssueComment([
    delta({ worldwide: { ...delta().worldwide, avgChange: 0.0000001 } }),
  ])
  assert.match(md, /±0\.00000/)
  assert.doesNotMatch(md, /▲ `\+0\.00000`/)
})

test('a quiet day is stated explicitly rather than left blank', () => {
  const md = buildIssueComment([delta({ changedCountries: [] })])
  assert.match(md, /No country changed today/)
})

test('multiple apps are separated by a rule', () => {
  const md = buildIssueComment([delta(), delta({ appName: 'Fuel', appId: '6670732733' })])
  assert.match(md, /---/)
  assert.match(md, /### Fuel/)
})

test('the created issue body explains itself and names the apps', () => {
  const body = buildIssueBody(['Clock In', 'Fuel'])
  assert.match(body, /Clock In, Fuel/)
  assert.match(body, /dipstick/)
})
