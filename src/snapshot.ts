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

export const DEFAULT_CONCURRENCY = 16

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
  { concurrency = DEFAULT_CONCURRENCY, date = utcDate() } = {},
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

  for (const outcome of outcomes) {
    if ('histogram' in outcome) {
      // Storefronts where the app is unavailable return an all-zero histogram.
      // Storing those would bloat history with meaningless rows.
      if (totalRatings(outcome.histogram) > 0) byCountry[outcome.country] = outcome.histogram
    } else {
      failures.push(outcome)
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
