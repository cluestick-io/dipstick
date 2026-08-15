import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  parseHistogram,
  totalRatings,
  averageRating,
  sumHistograms,
  ParseError,
} from '../src/parse.ts'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}.html`, import.meta.url)), 'utf8')

/**
 * Expected values captured from `asc reviews ratings` -- an independent
 * implementation -- at the time the fixtures were saved.
 */
const EXPECTED = {
  us: { hist: { 1: 1921059, 2: 420799, 3: 997694, 4: 2267380, 5: 22193865 }, avg: 4.52486 },
  de: { hist: { 1: 122389, 2: 25075, 3: 68836, 4: 154093, 5: 1006989 }, avg: 4.37813 },
  jp: { hist: { 1: 51415, 2: 22906, 3: 95280, 4: 157378, 5: 697889 }, avg: 4.39278 },
}

// The point of these three: us is English, de is German, jp is Japanese. If the
// parser ever regresses to matching on label text, de and jp break immediately.
for (const [country, { hist, avg }] of Object.entries(EXPECTED)) {
  test(`parses the ${country} storefront (${country === 'us' ? 'English' : country === 'de' ? 'German' : 'Japanese'})`, () => {
    const parsed = parseHistogram(fixture(country))
    assert.deepEqual(parsed, hist)
    assert.equal(totalRatings(parsed), Object.values(hist).reduce((a, b) => a + b, 0))
    assert.equal(Number(averageRating(parsed).toFixed(5)), avg)
  })
}

test('parses identically regardless of page language', () => {
  // Structural parsing means every fixture yields a well-formed histogram with
  // five positive buckets, whatever language the page is written in.
  for (const country of Object.keys(EXPECTED)) {
    const h = parseHistogram(fixture(country))
    for (const star of [1, 2, 3, 4, 5] as const) {
      assert.ok(h[star] > 0, `${country} star ${star} should be positive`)
    }
  }
})

test('throws on unexpected markup rather than returning a partial result', () => {
  assert.throws(() => parseHistogram('<html><body>nothing here</body></html>'), ParseError)
  // A page with only some of the blocks is the dangerous case: it must not
  // yield a plausible-but-wrong histogram.
  const truncated = fixture('us').split('<div class="vote"').slice(0, 3).join('<div class="vote"')
  assert.throws(() => parseHistogram(truncated), ParseError)
})

test('a valid page with no ratings yields zeros, not an error', () => {
  // The common case: a typical app has ratings in only a handful of the 115
  // storefronts. Treating the rest as failures would bury real breakage under
  // 80+ daily warnings, and would make the Slack digest cry wolf every day.
  const empty = fixture('no-ratings')
  assert.deepEqual(parseHistogram(empty), { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
  assert.equal(totalRatings(parseHistogram(empty)), 0)
})

test('an empty-looking page that is NOT a ratings page still throws', () => {
  // The discriminator must not be so loose that genuine markup changes pass
  // silently as "no ratings".
  assert.throws(() => parseHistogram('<html><body><div class="something-else"/></body></html>'), ParseError)
})

test('averageRating returns 0 for an app with no ratings, not NaN', () => {
  assert.equal(averageRating({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }), 0)
})

test('sumHistograms aggregates and preserves the exact average', () => {
  const us = parseHistogram(fixture('us'))
  const de = parseHistogram(fixture('de'))
  const combined = sumHistograms([us, de])

  assert.equal(combined[5], us[5] + de[5])
  assert.equal(totalRatings(combined), totalRatings(us) + totalRatings(de))

  // The worldwide average must be the true weighted average, not the mean of
  // the two country averages -- those differ, and only the former is correct.
  const naiveMean = (averageRating(us) + averageRating(de)) / 2
  assert.notEqual(averageRating(combined), naiveMean)
  assert.ok(averageRating(combined) > averageRating(de))
})
