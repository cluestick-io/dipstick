import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

import { postIssueComment } from '../src/github.ts'
import { dateMarker } from '../src/render/github.ts'

type Call = { method: string; path: string; body?: any }

/**
 * Stands in for the GitHub API so the find-then-update path can be exercised
 * without a live repo. `comments` is the pretend state of the issue thread.
 */
async function withApi(
  comments: { id: number; body: string }[],
  run: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = []

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      const path = req.url ?? ''
      calls.push({
        method: req.method ?? '',
        path,
        body: raw ? JSON.parse(raw) : undefined,
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })

      if (req.method === 'GET' && path.includes('/comments')) {
        res.end(JSON.stringify(comments))
      } else if (req.method === 'PATCH') {
        res.end(JSON.stringify({ html_url: 'https://github.com/o/r/issues/1#patched' }))
      } else {
        res.end(JSON.stringify({ html_url: 'https://github.com/o/r/issues/1#posted', number: 1 }))
      }
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }

  const originalFetch = globalThis.fetch
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    return originalFetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init)
  }) as typeof fetch

  try {
    await run(calls)
  } finally {
    globalThis.fetch = originalFetch
    await new Promise<void>((r) => server.close(() => r()))
  }
}

test('a new date posts a new comment', async () => {
  await withApi([{ id: 9, body: `old\n${dateMarker('2026-08-14')}` }], async (calls) => {
    const result = await postIssueComment('o/r', 't', 1, ['App'], 'body', '2026-08-15')

    assert.equal(result.updated, false)
    assert.ok(calls.some((c) => c.method === 'POST' && c.path.includes('/issues/1/comments')))
    assert.ok(!calls.some((c) => c.method === 'PATCH'))
  })
})

test('a re-run on the same date updates in place instead of duplicating', async () => {
  // This is the whole point: history rewrites the same-day row rather than
  // appending, and the comment should not tell a different story.
  await withApi([{ id: 42, body: `yesterday\n${dateMarker('2026-08-15')}` }], async (calls) => {
    const result = await postIssueComment('o/r', 't', 1, ['App'], 'new body', '2026-08-15')

    assert.equal(result.updated, true)
    const patch = calls.find((c) => c.method === 'PATCH')
    assert.ok(patch, 'should have PATCHed the existing comment')
    assert.match(patch.path, /\/issues\/comments\/42$/)
    assert.equal(patch.body.body, 'new body')
    assert.ok(!calls.some((c) => c.method === 'POST'), 'must not also post a duplicate')
  })
})

test('the lookup is bounded by date so old threads stay cheap', async () => {
  await withApi([], async (calls) => {
    await postIssueComment('o/r', 't', 1, ['App'], 'body', '2026-08-15')
    const get = calls.find((c) => c.method === 'GET')
    assert.ok(get)
    assert.match(get.path, /since=2026-08-15T00%3A00%3A00Z|since=2026-08-15T00:00:00Z/)
  })
})

test('a comment for a different date is never mistaken for today', async () => {
  await withApi(
    [
      { id: 1, body: `a\n${dateMarker('2026-08-13')}` },
      { id: 2, body: `b\n${dateMarker('2026-08-14')}` },
    ],
    async (calls) => {
      const result = await postIssueComment('o/r', 't', 1, ['App'], 'body', '2026-08-15')
      assert.equal(result.updated, false)
      assert.ok(calls.some((c) => c.method === 'POST'))
    },
  )
})

test('an unmarked comment is left alone', async () => {
  // Someone else's comment on the thread must never be overwritten.
  await withApi([{ id: 7, body: 'a human wrote this' }], async (calls) => {
    const result = await postIssueComment('o/r', 't', 1, ['App'], 'body', '2026-08-15')
    assert.equal(result.updated, false)
    assert.ok(!calls.some((c) => c.method === 'PATCH'))
  })
})
