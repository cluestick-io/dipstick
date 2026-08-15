import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildIssueComment, buildIssueBody } from '../src/render/github.ts'
import type { CountryDelta, Delta } from '../src/diff.ts'

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
    featured: [],
    changedCountries: [
      country('us', 9, { 1: 2, 2: 0, 3: 0, 4: 0, 5: 7 }),
      country('gb', 1, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 }),
    ],
    failures: [],
    ...over,
  }
}

function country(
  code: string,
  net: number,
  stars: CountryDelta['stars'],
  totalAfter = 5000,
): CountryDelta {
  return {
    country: code,
    net,
    stars,
    avgBefore: 4.5,
    avgAfter: 4.52,
    totalBefore: totalAfter - net,
    totalAfter,
    isEmpty: totalAfter === 0,
  }
}

test('the comment leads with the date and the app name', () => {
  const md = buildIssueComment([delta()])
  assert.match(md, /^## 2026-08-15/)
  assert.match(md, /### Clock In/)
})

test('per-star net changes render as a table', () => {
  const md = buildIssueComment([delta()])
  assert.match(md, /\| Rating \| Worldwide \|/)
  assert.match(md, /\| ★★★★★ \| \+8 \|/)
  assert.match(md, /\| ★ \| \+2 \|/)
})

test('a featured storefront gets its own column, ahead of worldwide', () => {
  // Side by side is what makes "the US drove all of today's 1★" visible
  // without doing arithmetic across two separate tables. Featured leads,
  // because that is the column being watched.
  const md = buildIssueComment([
    delta({ featured: [country('us', 9, { 1: 2, 2: 0, 3: 0, 4: 0, 5: 7 })] }),
  ])
  assert.match(md, /\| Rating \| US \| Worldwide \|/)
  assert.match(md, /\| ★★★★★ \| \+7 \| \+8 \|/)
  assert.match(md, /\| ★ \| \+2 \| \+2 \|/)
})

test('featured standings are listed above worldwide', () => {
  const md = buildIssueComment([
    delta({ featured: [country('us', 9, { 1: 2, 2: 0, 3: 0, 4: 0, 5: 7 })] }),
  ])
  assert.ok(
    md.indexOf('**US**') < md.indexOf('**Worldwide**'),
    'the featured storefront should appear before worldwide',
  )
})

test('featured leads on a first run too', () => {
  const md = buildIssueComment([
    delta({ isFirstRun: true, featured: [country('us', 9, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })] }),
  ])
  assert.ok(md.indexOf('**US**') < md.indexOf('**Worldwide**'))
  assert.match(md, /across 32 storefronts/)
})

test('a featured storefront is shown even when it did not move', () => {
  // The whole point: ±0 confirms a quiet day, rather than leaving you to
  // wonder whether the storefront was quiet or simply absent.
  const flat = country('us', 0, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
  const md = buildIssueComment([delta({ featured: [{ ...flat, avgBefore: 4.52, avgAfter: 4.52 }] })])
  assert.match(md, /`US`/)
  assert.match(md, /±0\.00000/)
})

test('a featured storefront with no ratings says so plainly', () => {
  const empty = country('jp', 0, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, 0)
  const md = buildIssueComment([delta({ featured: [empty] })])
  assert.match(md, /no ratings in this storefront/)
  // An empty storefront must not add a meaningless all-zero column.
  assert.doesNotMatch(md, /\| Rating \| Worldwide \| JP \|/)
})

test('a featured storefront is not repeated in the moved list', () => {
  // diffSnapshot excludes featured from changedCountries; this pins the
  // rendering side of that contract.
  const md = buildIssueComment([
    delta({
      featured: [country('us', 9, { 1: 2, 2: 0, 3: 0, 4: 0, 5: 7 })],
      changedCountries: [country('gb', 1, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 })],
    }),
  ])
  assert.match(md, /Countries that moved \(1\)/)
  assert.doesNotMatch(md, /\| `US` \| \+9/)
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

test('mentions are appended so the comment actually notifies', () => {
  // GitHub folds every comment into one issue thread; a daily comment on an
  // already-read thread can pass unnoticed without a mention.
  const md = buildIssueComment([delta()], ['loganisitt'])
  assert.match(md, /cc @loganisitt/)
  // Last, so it reads as delivery plumbing rather than part of the report.
  assert.ok(md.indexOf('cc @loganisitt') > md.indexOf('Countries that moved'))
})

test('no mention block when none are configured', () => {
  assert.doesNotMatch(buildIssueComment([delta()]), /cc @/)
})

test('multiple mentions are all included', () => {
  assert.match(buildIssueComment([delta()], ['a', 'b']), /cc @a @b/)
})

test('the created issue body explains itself and names the apps', () => {
  const body = buildIssueBody(['Clock In', 'Fuel'])
  assert.match(body, /Clock In, Fuel/)
  assert.match(body, /dipstick/)
})
