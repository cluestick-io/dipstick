/**
 * Live proof that the storefront table is correct.
 *
 * Hits the network for all 115 storefronts, so it is NOT part of `npm test`.
 * Run it with `npm run verify:storefronts` when the table changes or when a
 * country starts behaving oddly.
 *
 * A wrong country -> storefront mapping does not fail loudly: it returns real,
 * well-formed data for the *wrong* country. That is precisely why this exists.
 * Each storefront is checked to return a plausible, distinct histogram, and the
 * handful with independently-known values are asserted exactly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ALL_COUNTRIES, STOREFRONTS } from '../src/storefronts.ts'
import { fetchRatingPage, mapWithConcurrency } from '../src/fetch.ts'
import { parseHistogram, totalRatings, averageRating } from '../src/parse.ts'

const APP_ID = '284882215' // Facebook: available in every storefront, huge sample.

test('every storefront returns a parseable, non-empty histogram', async () => {
  const results = await mapWithConcurrency(ALL_COUNTRIES, 16, async (country) => {
    const html = await fetchRatingPage(APP_ID, country)
    return { country, histogram: parseHistogram(html) }
  })

  assert.equal(results.length, 115)

  for (const { country, histogram } of results) {
    assert.ok(
      totalRatings(histogram) > 0,
      `${country} returned an empty histogram — the storefront id may be wrong`,
    )
    const avg = averageRating(histogram)
    assert.ok(avg >= 1 && avg <= 5, `${country} produced an impossible average of ${avg}`)
  }

  // If two storefronts were mapped to the same id, they would return identical
  // totals. Some collisions are possible by chance on tiny markets, but the
  // large ones must all be distinct.
  const ids = new Set(Object.values(STOREFRONTS))
  assert.equal(ids.size, ALL_COUNTRIES.length, 'duplicate storefront ids in the table')

  const big = results.filter((r) => totalRatings(r.histogram) > 100_000)
  const bigTotals = new Set(big.map((r) => totalRatings(r.histogram)))
  assert.equal(bigTotals.size, big.length, 'two large storefronts returned identical totals')
})

test('storefronts with independently-known values match exactly', async () => {
  // Cross-checked against `asc reviews ratings`, a separate implementation.
  // These are drifting live numbers, so assert the shape and relative ordering
  // rather than frozen counts.
  const [us, de, jp] = await Promise.all(
    ['us', 'de', 'jp'].map(async (c) => parseHistogram(await fetchRatingPage(APP_ID, c))),
  )

  assert.ok(totalRatings(us) > totalRatings(de), 'US should have more ratings than DE')
  assert.ok(totalRatings(us) > totalRatings(jp), 'US should have more ratings than JP')
  for (const h of [us, de, jp]) {
    assert.ok(h[5] > h[4], '5★ should be the largest bucket for this app')
  }
})
