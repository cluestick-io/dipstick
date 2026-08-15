import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

import { takeSnapshot } from '../src/snapshot.ts'

/**
 * These cover the nastiest failure mode this tool has.
 *
 * Apple throttles bursts, and a throttled storefront answers 200 with a page
 * that has no histogram -- identical in shape to a storefront that genuinely
 * has no ratings. Believing it writes a zero into history, which then reads as
 * a catastrophic one-day collapse followed by a miraculous recovery.
 */

const withRatings = (five: number) => `
<div class='customer-ratings'><div class="ratings-histogram">
  <div class="vote"><span class="total">${five}</span></div>
  <div class="vote"><span class="total">0</span></div>
  <div class="vote"><span class="total">0</span></div>
  <div class="vote"><span class="total">0</span></div>
  <div class="vote"><span class="total">0</span></div>
</div></div>`

/** What both a throttled response and a genuinely empty storefront look like. */
const noRatings = `<div class='customer-ratings'><div class="ratings-container"></div></div>`

async function withStubbedStore(
  respond: (country: string, hitCount: number) => string,
  run: () => Promise<void>,
): Promise<void> {
  const hits: Record<string, number> = {}
  const server: Server = createServer((req, res) => {
    const country = (req.url ?? '').split('/')[1] ?? ''
    hits[country] = (hits[country] ?? 0) + 1
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(respond(country, hits[country]))
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }

  const originalFetch = globalThis.fetch
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    return originalFetch(`http://127.0.0.1:${port}${path}`, init)
  }) as typeof fetch

  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
    await new Promise<void>((r) => server.close(() => r()))
  }
}

test('a transient zero on a previously-rated storefront is re-checked and recovered', async () => {
  await withStubbedStore(
    // us fails the first read (as a throttle would) then recovers.
    (country, hit) => (country === 'us' && hit === 1 ? noRatings : withRatings(500)),
    async () => {
      const snap = await takeSnapshot({ id: '1', name: 'App' }, ['us', 'gb'], {
        knownNonZero: new Set(['us', 'gb']),
      })

      assert.ok(snap.countries.us, 'us should have been recovered by the re-check')
      assert.equal(snap.countries.us[5], 500)
      assert.equal(snap.failures.length, 0)
    },
  )
})

test('a persistent zero on a previously-rated storefront is a failure, not a recorded zero', async () => {
  await withStubbedStore(
    (country) => (country === 'us' ? noRatings : withRatings(500)),
    async () => {
      const snap = await takeSnapshot({ id: '1', name: 'App' }, ['us', 'gb'], {
        knownNonZero: new Set(['us', 'gb']),
      })

      // The crucial assertion: us must NOT appear with a zero histogram, because
      // a fabricated zero would show up tomorrow as a huge negative delta.
      assert.equal(snap.countries.us, undefined)
      assert.equal(snap.failures.length, 1)
      assert.equal(snap.failures[0].country, 'us')
      assert.match(snap.failures[0].reason, /Previously had ratings/)
    },
  )
})

test('a storefront with no history and no ratings is simply absent, not a failure', async () => {
  await withStubbedStore(
    (country) => (country === 'us' ? withRatings(10) : noRatings),
    async () => {
      // knownNonZero is empty, as on a first run.
      const snap = await takeSnapshot({ id: '1', name: 'App' }, ['us', 'gb', 'jp'])

      assert.deepEqual(Object.keys(snap.countries), ['us'])
      assert.equal(snap.failures.length, 0, 'empty storefronts are normal, not errors')
    },
  )
})

test('re-checks are limited to storefronts that previously had ratings', async () => {
  let jpRequests = 0
  await withStubbedStore(
    (country) => {
      if (country === 'jp') jpRequests++
      return noRatings
    },
    async () => {
      await takeSnapshot({ id: '1', name: 'App' }, ['jp'], { knownNonZero: new Set() })
      // No history for jp, so no reason to spend retries confirming its zero.
      assert.equal(jpRequests, 1)
    },
  )
})

test('worldwide totals only count storefronts that returned data', async () => {
  await withStubbedStore(
    (country) => (country === 'us' ? withRatings(100) : withRatings(50)),
    async () => {
      const snap = await takeSnapshot({ id: '1', name: 'App' }, ['us', 'gb'])
      assert.equal(snap.worldwide.total, 150)
      assert.equal(snap.worldwide.histogram[5], 150)
    },
  )
})
