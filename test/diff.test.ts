import { test } from 'node:test'
import assert from 'node:assert/strict'

import { diffSnapshot } from '../src/diff.ts'
import { toRow } from '../src/store.ts'
import { totalRatings, averageRating, sumHistograms, type Histogram } from '../src/parse.ts'
import type { Snapshot } from '../src/snapshot.ts'

const h = (one: number, two: number, three: number, four: number, five: number): Histogram => ({
  1: one,
  2: two,
  3: three,
  4: four,
  5: five,
})

function snapshot(date: string, countries: Record<string, Histogram>): Snapshot {
  const worldwide = sumHistograms(Object.values(countries))
  return {
    date,
    appId: '284882215',
    appName: 'Facebook',
    worldwide: {
      total: totalRatings(worldwide),
      avg: averageRating(worldwide),
      histogram: worldwide,
    },
    countries,
    failures: [],
  }
}

test('first run reports no delta instead of a fake zero-change day', () => {
  const delta = diffSnapshot(snapshot('2026-08-14', { us: h(10, 5, 5, 20, 60) }))
  assert.equal(delta.isFirstRun, true)
  assert.equal(delta.baselineDate, undefined)
  assert.equal(delta.worldwide.avgChange, 0)
  assert.deepEqual(delta.changedCountries, [])
})

test('computes per-star net change worldwide', () => {
  const before = toRow(snapshot('2026-08-13', { us: h(10, 5, 5, 20, 60), gb: h(1, 1, 1, 1, 10) }))
  const after = snapshot('2026-08-14', { us: h(17, 5, 6, 23, 102), gb: h(1, 1, 1, 1, 10) })

  const delta = diffSnapshot(after, before)
  assert.equal(delta.isFirstRun, false)
  assert.equal(delta.baselineDate, '2026-08-13')
  assert.deepEqual(delta.worldwide.stars, { 1: 7, 2: 0, 3: 1, 4: 3, 5: 42 })
  assert.equal(delta.worldwide.net, 53)
})

test('only countries that actually moved are reported', () => {
  // gb and de are unchanged; reporting them would be pure noise, which is the
  // entire reason the per-country list is filtered.
  const before = toRow(
    snapshot('2026-08-13', { us: h(10, 5, 5, 20, 60), gb: h(1, 1, 1, 1, 10), de: h(2, 2, 2, 2, 2) }),
  )
  const after = snapshot('2026-08-14', {
    us: h(11, 5, 5, 20, 65),
    gb: h(1, 1, 1, 1, 10),
    de: h(2, 2, 2, 2, 2),
  })

  const delta = diffSnapshot(after, before)
  assert.deepEqual(
    delta.changedCountries.map((c) => c.country),
    ['us'],
  )
  assert.equal(delta.changedCountries[0].net, 6)
})

test('changed countries are ranked by magnitude, not by direction', () => {
  const before = toRow(
    snapshot('2026-08-13', { us: h(0, 0, 0, 0, 100), gb: h(0, 0, 0, 0, 100), jp: h(0, 0, 0, 0, 100) }),
  )
  const after = snapshot('2026-08-14', {
    us: h(0, 0, 0, 0, 105), // +5
    gb: h(0, 0, 0, 0, 60), // -40, the biggest mover
    jp: h(0, 0, 0, 0, 120), // +20
  })

  assert.deepEqual(
    diffSnapshot(after, before).changedCountries.map((c) => c.country),
    ['gb', 'jp', 'us'],
  )
})

test('a rating reset surfaces as a large negative number, not a guess', () => {
  // Deliberate: we do not try to detect and relabel this as a "version reset".
  // Inferring intent risks dressing up a genuine collapse as benign.
  const before = toRow(snapshot('2026-08-13', { us: h(1000, 500, 500, 2000, 6000) }))
  const after = snapshot('2026-08-14', { us: h(1, 0, 0, 2, 7) })

  const delta = diffSnapshot(after, before)
  assert.equal(delta.worldwide.net, -9990)
  assert.equal(delta.worldwide.stars[5], -5993)
  assert.ok(delta.changedCountries[0].net < 0)
})

test('a country disappearing entirely is reported as a change', () => {
  // App pulled from a storefront, or a persistent fetch failure. Either way,
  // silently dropping it would hide a real event.
  const before = toRow(snapshot('2026-08-13', { us: h(1, 1, 1, 1, 1), jp: h(0, 0, 0, 0, 50) }))
  const after = snapshot('2026-08-14', { us: h(1, 1, 1, 1, 1) })

  const delta = diffSnapshot(after, before)
  const jp = delta.changedCountries.find((c) => c.country === 'jp')
  assert.ok(jp, 'jp should be reported')
  assert.equal(jp.net, -50)
})

test('an unchanged day produces an empty country list and zero movement', () => {
  const countries = { us: h(10, 5, 5, 20, 60) }
  const delta = diffSnapshot(snapshot('2026-08-14', countries), toRow(snapshot('2026-08-13', countries)))
  assert.deepEqual(delta.changedCountries, [])
  assert.equal(delta.worldwide.net, 0)
  assert.equal(delta.worldwide.avgChange, 0)
})

test('a featured country appears even on a day it did not move', () => {
  // The reason the feature exists: a flat day must be visibly flat, not absent.
  const countries = { us: h(10, 5, 5, 20, 60), gb: h(1, 1, 1, 1, 10) }
  const delta = diffSnapshot(
    snapshot('2026-08-14', countries),
    toRow(snapshot('2026-08-13', countries)),
    ['us'],
  )

  assert.equal(delta.featured.length, 1)
  assert.equal(delta.featured[0].country, 'us')
  assert.equal(delta.featured[0].net, 0)
  assert.equal(delta.featured[0].totalAfter, 100)
  assert.deepEqual(delta.changedCountries, [])
})

test('a featured country is excluded from the moved list, never listed twice', () => {
  const before = toRow(snapshot('2026-08-13', { us: h(10, 5, 5, 20, 60), gb: h(1, 1, 1, 1, 10) }))
  const after = snapshot('2026-08-14', { us: h(11, 5, 5, 20, 65), gb: h(1, 1, 1, 1, 12) })

  const delta = diffSnapshot(after, before, ['us'])

  assert.deepEqual(delta.featured.map((c) => c.country), ['us'])
  assert.deepEqual(delta.changedCountries.map((c) => c.country), ['gb'])
})

test('featured countries keep config order, not movement order', () => {
  const countries = { us: h(0, 0, 0, 0, 10), gb: h(0, 0, 0, 0, 5000) }
  const delta = diffSnapshot(
    snapshot('2026-08-14', countries),
    toRow(snapshot('2026-08-13', countries)),
    ['us', 'gb'],
  )
  // gb is far larger, but us was listed first and stays first so the report
  // reads the same way every day.
  assert.deepEqual(delta.featured.map((c) => c.country), ['us', 'gb'])
})

test('a featured country with no ratings is flagged empty rather than shown as 0.00', () => {
  const delta = diffSnapshot(snapshot('2026-08-14', { us: h(1, 1, 1, 1, 1) }), undefined, ['jp'])
  assert.equal(delta.featured[0].country, 'jp')
  assert.equal(delta.featured[0].isEmpty, true)
  assert.equal(delta.featured[0].totalAfter, 0)
})

test('featured countries are present on a first run too', () => {
  const delta = diffSnapshot(snapshot('2026-08-14', { us: h(10, 5, 5, 20, 60) }), undefined, ['us'])
  assert.equal(delta.isFirstRun, true)
  assert.equal(delta.featured.length, 1)
  assert.equal(delta.featured[0].totalAfter, 100)
  // No baseline, so there is no change to claim.
  assert.equal(delta.featured[0].net, 100 - 0)
})

test('average movement is tracked even when the net count is unchanged', () => {
  // A user editing 1★ to 5★ leaves the total flat but moves the average -- the
  // exact signal a count-only tool would miss.
  const before = toRow(snapshot('2026-08-13', { us: h(10, 0, 0, 0, 90) }))
  const after = snapshot('2026-08-14', { us: h(9, 0, 0, 0, 91) })

  const delta = diffSnapshot(after, before)
  assert.equal(delta.worldwide.net, 0)
  assert.ok(delta.worldwide.avgChange > 0)
  assert.deepEqual(delta.worldwide.stars, { 1: -1, 2: 0, 3: 0, 4: 0, 5: 1 })
})
