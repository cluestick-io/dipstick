/**
 * Takes one day's reading for an app: every configured storefront, plus the
 * worldwide aggregate derived by summing them.
 *
 * The worldwide number is the reason this tool exists. Apple publishes a
 * per-storefront average and nothing else -- there is no global figure anywhere
 * in App Store Connect or the public APIs. Summing the histograms gives an
 * exact one, not an estimate, because the histogram buckets are raw counts.
 */
import { fetchRatingPage, mapWithConcurrency, FetchError } from './fetch.ts'
import {
  parseHistogram,
  totalRatings,
  averageRating,
  sumHistograms,
  type Histogram,
} from './parse.ts'

/**
 * Deliberately modest. Apple throttles bursts, and a throttled storefront does
 * not fail loudly -- it returns a 200 whose page has no histogram, which is
 * byte-for-byte the same shape as a storefront that genuinely has no ratings.
 * A daily job has no reason to be fast, and being a good citizen here is what
 * keeps the data trustworthy.
 */
export const DEFAULT_CONCURRENCY = 6

/** Attempts to confirm a suspicious zero before believing it. */
const ZERO_RECHECK_ATTEMPTS = 3

export type Snapshot = {
  /** UTC date, YYYY-MM-DD. */
  date: string
  appId: string
  appName: string
  worldwide: { total: number; avg: number; histogram: Histogram }
  /** Only storefronts that returned data. */
  countries: Record<string, Histogram>
  /** Storefronts that failed, so a partial run is never mistaken for a complete one. */
  failures: { country: string; reason: string }[]
}

export function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export async function takeSnapshot(
  app: { id: string; name: string },
  countries: string[],
  {
    concurrency = DEFAULT_CONCURRENCY,
    date = utcDate(),
    /**
     * Storefronts that had ratings in the previous snapshot.
     *
     * Ratings are cumulative: a storefront holding hundreds of ratings does not
     * drop to zero overnight. So a zero here is treated as a probable throttled
     * response and re-checked rather than believed, which stops a transient
     * blip from being written into history as a real collapse.
     */
    knownNonZero = new Set<string>(),
  }: {
    concurrency?: number
    date?: string
    knownNonZero?: Set<string>
  } = {},
): Promise<Snapshot> {
  type Outcome =
    | { country: string; histogram: Histogram }
    | { country: string; reason: string }

  const outcomes = await mapWithConcurrency<string, Outcome>(
    countries,
    concurrency,
    async (country) => {
      try {
        const html = await fetchRatingPage(app.id, country)
        return { country, histogram: parseHistogram(html) }
      } catch (err) {
        // One dead storefront must not sink the whole run -- but it is recorded
        // rather than swallowed, so a shrinking country list is visible.
        const reason =
          err instanceof FetchError || err instanceof Error ? err.message : String(err)
        return { country, reason }
      }
    },
  )

  const byCountry: Record<string, Histogram> = {}
  const failures: { country: string; reason: string }[] = []
  const suspiciousZeros: string[] = []

  for (const outcome of outcomes) {
    if ('histogram' in outcome) {
      // Storefronts where the app has no ratings return an all-zero histogram.
      // Storing those would bloat history with meaningless rows.
      if (totalRatings(outcome.histogram) > 0) {
        byCountry[outcome.country] = outcome.histogram
      } else if (knownNonZero.has(outcome.country)) {
        suspiciousZeros.push(outcome.country)
      }
    } else {
      failures.push(outcome)
    }
  }

  // Re-check the suspicious zeros one at a time, slowly. If a storefront really
  // is throttled, spacing the retries out is what lets it recover; if it truly
  // has zero ratings now, it will keep saying so and we record a failure rather
  // than a fabricated zero. Either way we never silently invent a collapse.
  for (const country of suspiciousZeros) {
    let recovered = false

    for (let attempt = 0; attempt < ZERO_RECHECK_ATTEMPTS && !recovered; attempt++) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      try {
        const histogram = parseHistogram(await fetchRatingPage(app.id, country))
        if (totalRatings(histogram) > 0) {
          byCountry[country] = histogram
          recovered = true
        }
      } catch {
        // Fall through to the next attempt.
      }
    }

    if (!recovered) {
      failures.push({
        country,
        reason:
          `Previously had ratings but returned none, and still none after ` +
          `${ZERO_RECHECK_ATTEMPTS} re-checks. Recorded as a failure rather than a zero ` +
          `— if the app was pulled from this storefront, this will persist.`,
      })
    }
  }

  const worldwideHistogram = sumHistograms(Object.values(byCountry))

  return {
    date,
    appId: app.id,
    appName: app.name,
    worldwide: {
      total: totalRatings(worldwideHistogram),
      avg: averageRating(worldwideHistogram),
      histogram: worldwideHistogram,
    },
    countries: byCountry,
    failures,
  }
}
