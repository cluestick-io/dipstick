/**
 * Turns two snapshots into a day-over-day delta.
 *
 * A note on wording that the renderers must honour: these are NET changes, not
 * gross new ratings. Apple removes fraudulent reviews and users edit their own,
 * so a bucket can move down. "42 new 5★" is a claim this data cannot support;
 * "5★ count rose by 42" is. Everything here is named accordingly.
 *
 * A large negative delta is reported as-is. We deliberately do not try to guess
 * that it was a version rating-reset: the heuristic would have to infer intent,
 * and mislabelling a genuine collapse in sentiment as a benign reset is a much
 * worse failure than showing an alarming true number.
 */
import { totalRatings, averageRating, type Histogram } from './parse.ts'
import type { Snapshot } from './snapshot.ts'
import { rowToHistograms, type HistoryRow } from './store.ts'

export type StarDeltas = Record<1 | 2 | 3 | 4 | 5, number>

export type CountryDelta = {
  country: string
  /** Net change in total ratings. */
  net: number
  stars: StarDeltas
  avgBefore: number
  avgAfter: number
  /** Absolute totals, needed to show a featured country's standing on a flat day. */
  totalBefore: number
  totalAfter: number
  /** True when the storefront has no ratings at all, as opposed to none *new*. */
  isEmpty: boolean
}

export type Delta = {
  appId: string
  appName: string
  date: string
  /** True on the very first run: there is no baseline, so there is no delta. */
  isFirstRun: boolean
  baselineDate?: string
  /** Storefronts with at least one rating in the current snapshot. */
  countryCount: number
  worldwide: {
    totalBefore: number
    totalAfter: number
    net: number
    avgBefore: number
    avgAfter: number
    avgChange: number
    stars: StarDeltas
  }
  /**
   * Storefronts pinned by config, always present in config order even when
   * nothing moved. Excluded from `changedCountries` so they never appear twice.
   */
  featured: CountryDelta[]
  /** Only countries whose rating count actually moved, biggest movement first. */
  changedCountries: CountryDelta[]
  failures: { country: string; reason: string }[]
}

const ZERO: Histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
const STARS = [1, 2, 3, 4, 5] as const

function starDeltas(after: Histogram, before: Histogram): StarDeltas {
  return {
    1: after[1] - before[1],
    2: after[2] - before[2],
    3: after[3] - before[3],
    4: after[4] - before[4],
    5: after[5] - before[5],
  }
}

export function hasMovement(stars: StarDeltas): boolean {
  return STARS.some((s) => stars[s] !== 0)
}

function countryDelta(
  country: string,
  after: Histogram,
  before: Histogram,
): CountryDelta {
  const totalAfter = totalRatings(after)
  const totalBefore = totalRatings(before)
  return {
    country,
    net: totalAfter - totalBefore,
    stars: starDeltas(after, before),
    avgBefore: averageRating(before),
    avgAfter: averageRating(after),
    totalBefore,
    totalAfter,
    isEmpty: totalAfter === 0,
  }
}

export function diffSnapshot(
  snapshot: Snapshot,
  baseline?: HistoryRow,
  featuredCountries: string[] = [],
): Delta {
  const isFirstRun = baseline === undefined
  const before = baseline ? rowToHistograms(baseline) : {}

  const worldwideBefore = Object.values(before).reduce<Histogram>(
    (acc, h) => ({
      1: acc[1] + h[1],
      2: acc[2] + h[2],
      3: acc[3] + h[3],
      4: acc[4] + h[4],
      5: acc[5] + h[5],
    }),
    { ...ZERO },
  )

  const avgBefore = averageRating(worldwideBefore)
  const avgAfter = snapshot.worldwide.avg

  const changedCountries: CountryDelta[] = []
  // Union of both sides: a country can vanish from the current run (app pulled,
  // or a fetch failure) and that is itself a change worth surfacing.
  const allCountries = new Set([...Object.keys(snapshot.countries), ...Object.keys(before)])

  const isFeatured = new Set(featuredCountries)

  for (const country of allCountries) {
    // Featured storefronts get their own section, so listing them here too
    // would just say the same thing twice.
    if (isFeatured.has(country)) continue

    const after = snapshot.countries[country] ?? ZERO
    const prior = before[country] ?? ZERO
    if (!hasMovement(starDeltas(after, prior))) continue

    changedCountries.push(countryDelta(country, after, prior))
  }

  // Built in config order, and unconditionally: a featured storefront showing
  // ±0 is the point -- it confirms nothing happened, rather than leaving you to
  // wonder whether it was quiet or simply missing.
  const featured = featuredCountries.map((country) =>
    countryDelta(country, snapshot.countries[country] ?? ZERO, before[country] ?? ZERO),
  )

  // Rank by magnitude, so the biggest movers lead regardless of direction.
  changedCountries.sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.country.localeCompare(b.country))

  return {
    appId: snapshot.appId,
    appName: snapshot.appName,
    date: snapshot.date,
    isFirstRun,
    baselineDate: baseline?.date,
    countryCount: Object.keys(snapshot.countries).length,
    worldwide: {
      totalBefore: totalRatings(worldwideBefore),
      totalAfter: snapshot.worldwide.total,
      net: snapshot.worldwide.total - totalRatings(worldwideBefore),
      avgBefore,
      avgAfter,
      avgChange: isFirstRun ? 0 : avgAfter - avgBefore,
      stars: starDeltas(snapshot.worldwide.histogram, worldwideBefore),
    },
    // Featured storefronts still appear on a first run -- showing their
    // starting position is useful even though there is no change to report.
    featured,
    changedCountries: isFirstRun ? [] : changedCountries,
    failures: snapshot.failures,
  }
}
