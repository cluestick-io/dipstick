import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildSlackMessage } from '../src/render/slack.ts'
import type { CountryDelta, Delta } from '../src/diff.ts'

export function country(
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

function delta(over: Partial<Delta> = {}): Delta {
  return {
    appId: '284882215',
    appName: 'Facebook',
    date: '2026-08-15',
    isFirstRun: false,
    baselineDate: '2026-08-14',
    countryCount: 115,
    worldwide: {
      totalBefore: 1000,
      totalAfter: 1641,
      net: 641,
      avgBefore: 4.5,
      avgAfter: 4.51,
      avgChange: 0.01,
      stars: { 1: 28, 2: 0, 3: 3, 4: 0, 5: 610 },
    },
    featured: [],
    changedCountries: [country('us', 440, { 1: 28, 2: 0, 3: 0, 4: 0, 5: 412 })],
    failures: [],
    ...over,
  }
}

const json = (d: Delta[]) => JSON.stringify(buildSlackMessage(d))

test('message has a header and a plain-text fallback for notifications', () => {
  const msg = buildSlackMessage([delta()])
  assert.match(msg.text, /Facebook/)
  assert.equal((msg.blocks[0] as any).type, 'header')
})

test('the net-change caveat is present whenever a delta is shown', () => {
  // Dropping this line would let the message imply these are gross new ratings.
  assert.match(json([delta()]), /Net change since the previous snapshot/)
})

test('the caveat is omitted on a first run, where there is no delta', () => {
  const body = json([delta({ isFirstRun: true })])
  assert.doesNotMatch(body, /Net change since the previous snapshot/)
  assert.match(body, /First run/)
})

test('a zero average change reads as ± rather than a misleading arrow', () => {
  const body = json([delta({ worldwide: { ...delta().worldwide, avgChange: 0.000001 } })])
  assert.match(body, /±0\.0000/)
  assert.doesNotMatch(body, /▲ \+0\.0000/)
})

test('a falling average is marked with a down arrow', () => {
  assert.match(json([delta({ worldwide: { ...delta().worldwide, avgChange: -0.02 } })]), /▼/)
})

test('country list is truncated so a launch day cannot flood the channel', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    country: `c${i}`,
    net: 100 - i,
    stars: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 100 - i } as Delta['changedCountries'][0]['stars'],
    avgBefore: 4,
    avgAfter: 4,
  }))
  const body = json([delta({ changedCountries: many })])
  assert.match(body, /and 32 more storefronts/)
  assert.match(body, /Countries that moved \(40\)/)
})

test('fetch failures are surfaced, not hidden', () => {
  // A partial run that looks complete is worse than a noisy one.
  const body = json([delta({ failures: [{ country: 'jp', reason: 'timeout' }] })])
  assert.match(body, /failed to fetch/)
})

test('multiple apps are separated by a divider', () => {
  const msg = buildSlackMessage([delta(), delta({ appName: 'Instagram', appId: '389801252' })])
  assert.ok((msg.blocks as any[]).some((b) => b.type === 'divider'))
  assert.match(msg.text, /Facebook.*Instagram/)
})

test('payload is JSON-serialisable and free of undefined', () => {
  // Slack rejects malformed payloads with an opaque error, so catch it here.
  const body = json([delta(), delta({ isFirstRun: true })])
  assert.doesNotMatch(body, /undefined/)
  assert.doesNotThrow(() => JSON.parse(body))
})
