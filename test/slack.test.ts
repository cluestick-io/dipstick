import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

import { postToSlack, SlackError } from '../src/slack.ts'
import { buildSlackMessage } from '../src/render/slack.ts'

const MESSAGE = buildSlackMessage([
  {
    appId: '1',
    appName: 'Test',
    date: '2026-08-15',
    isFirstRun: true,
    countryCount: 1,
    worldwide: {
      totalBefore: 0,
      totalAfter: 10,
      net: 10,
      avgBefore: 0,
      avgAfter: 4.5,
      avgChange: 0,
      stars: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 10 },
    },
    featured: [],
    changedCountries: [],
    failures: [],
  },
])

/** Spin up a throwaway server that answers every request the same way. */
async function withServer(
  handler: (respond: (status: number, body?: string, headers?: Record<string, string>) => void) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_req, res) => {
    handler((status, body = '', headers = {}) => {
      res.writeHead(status, headers)
      res.end(body)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }

  try {
    await run(`http://127.0.0.1:${port}/hook`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('a 200 response is treated as posted', async () => {
  await withServer(
    (respond) => respond(200, 'ok'),
    async (url) => {
      await assert.doesNotReject(() => postToSlack(url, MESSAGE))
    },
  )
})

/**
 * The regression that motivated this file. An invalid or revoked Slack webhook
 * answers 302, and fetch follows redirects by default -- which meant a bad
 * webhook landed on someone else's 200 and every run reported success while
 * posting nothing. A silent no-op is the worst possible failure here, because
 * the whole point of the tool is the message arriving.
 */
test('a 302 redirect is a failure, not a success', async () => {
  await withServer(
    (respond) => respond(302, '', { Location: 'https://example.com/' }),
    async (url) => {
      await assert.rejects(() => postToSlack(url, MESSAGE), (err: Error) => {
        assert.ok(err instanceof SlackError)
        assert.match(err.message, /302/)
        assert.match(err.message, /revoked/)
        return true
      })
    },
  )
})

test('a 4xx response surfaces Slack’s own reason text', async () => {
  await withServer(
    (respond) => respond(400, 'invalid_payload'),
    async (url) => {
      await assert.rejects(() => postToSlack(url, MESSAGE), (err: Error) => {
        assert.match(err.message, /invalid_payload/)
        return true
      })
    },
  )
})

test('a 500 response fails rather than being silently swallowed', async () => {
  await withServer(
    (respond) => respond(500, 'server_error'),
    async (url) => {
      await assert.rejects(() => postToSlack(url, MESSAGE), SlackError)
    },
  )
})

test('the posted body is the Block Kit payload', async () => {
  let received = ''
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      received = Buffer.concat(chunks).toString()
      res.writeHead(200)
      res.end('ok')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }

  try {
    await postToSlack(`http://127.0.0.1:${port}/hook`, MESSAGE)
    const parsed = JSON.parse(received)
    assert.ok(Array.isArray(parsed.blocks))
    assert.equal(typeof parsed.text, 'string')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
