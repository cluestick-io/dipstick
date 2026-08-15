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

export function diffSnapshot(snapshot: Snapshot, baseline?: HistoryRow): Delta {
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

  for (const country of allCountries) {
    const after = snapshot.countries[country] ?? ZERO
    const prior = before[country] ?? ZERO
    const stars = starDeltas(after, prior)
    if (!hasMovement(stars)) continue

    changedCountries.push({
      country,
      net: totalRatings(after) - totalRatings(prior),
      stars,
      avgBefore: averageRating(prior),
      avgAfter: averageRating(after),
    })
  }

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
    changedCountries: isFirstRun ? [] : changedCountries,
    failures: snapshot.failures,
  }
}
