/**
 * Fetches App Store rating pages.
 *
 * The endpoint is undocumented but public and has been stable for years. Two
 * things about it are surprising enough to be worth stating plainly, because
 * both cost real time to discover:
 *
 *  1. The country in the URL path does NOT select the storefront. Requesting
 *     /de/ without the matching header returns US numbers -- not an error, just
 *     quietly wrong data. The `X-Apple-Store-Front` header is what selects the
 *     storefront; the path only has to be a country Apple recognises, or the
 *     request 400s.
 *
 *  2. The header format is `{storefrontId},12`. The widely-cited `{id}-1,12`
 *     and `{id}-2,12` forms 400 on most storefronts.
 */
import { storefrontId } from './storefronts.ts'

const USER_AGENT = 'iTunes/12.12'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_RETRIES = 3

export class FetchError extends Error {
  // Declared as fields rather than constructor parameter properties: Node's
  // type stripping is erasure-only and cannot synthesise the assignments.
  country: string
  status?: number

  constructor(message: string, country: string, status?: number) {
    super(message)
    this.name = 'FetchError'
    this.country = country
    this.status = status
  }
}

export function reviewsUrl(appId: string, country: string): string {
  return `https://itunes.apple.com/${country.toLowerCase()}/customer-reviews/id${appId}?displayable-kind=11`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fetch one storefront's page, retrying transient failures with backoff. */
export async function fetchRatingPage(
  appId: string,
  country: string,
  { retries = DEFAULT_RETRIES, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
): Promise<string> {
  const headers = {
    'X-Apple-Store-Front': `${storefrontId(country)},12`,
    'User-Agent': USER_AGENT,
  }

  let lastError: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 250)

    try {
      const res = await fetch(reviewsUrl(appId, country), {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })

      // 4xx is a real answer -- a bad app id or country. Retrying won't help.
      if (res.status >= 400 && res.status < 500) {
        throw new FetchError(
          `App Store returned ${res.status} for app ${appId} in "${country}".`,
          country,
          res.status,
        )
      }
      if (!res.ok) {
        lastError = new FetchError(`App Store returned ${res.status}.`, country, res.status)
        continue
      }
      return await res.text()
    } catch (err) {
      if (err instanceof FetchError && err.status !== undefined && err.status < 500) throw err
      lastError = err
    }
  }

  throw new FetchError(
    `Failed to fetch "${country}" after ${retries} attempts: ${lastError instanceof Error ? lastError.message : lastError}`,
    country,
  )
}

/**
 * Run tasks with bounded concurrency.
 *
 * All ~115 storefronts complete in well under a second at this concurrency, so
 * there is no reason to push Apple harder than this.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })

  await Promise.all(workers)
  return results
}
