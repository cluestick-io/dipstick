/**
 * Extracts the 1-5 star histogram from an App Store customer-reviews page.
 *
 * The page is localized. An earlier version of this parser keyed on the English
 * aria-label ("5 stars, 22,193,865 ratings") and worked perfectly for us/gb while
 * silently returning nothing for de/jp -- the worst kind of bug, because the
 * request succeeded and the failure looked like "that country has no ratings".
 *
 * So we parse structurally instead. The five `<div class="vote">` blocks appear
 * in descending star order and each contains a `<span class="total">` holding a
 * raw, unformatted integer. Neither depends on the page language.
 */

/** Rating counts per star, indexed 1-5. */
export type Histogram = Record<1 | 2 | 3 | 4 | 5, number>

const VOTE_BLOCK = /<div class="vote"[^>]*>[\s\S]*?<span class="total">(\d+)<\/span>/g

/**
 * Marker that the page rendered correctly, whether or not it holds any ratings.
 *
 * This is what separates "this app has no ratings in this storefront" -- the
 * normal case for all but the largest apps, and true of most of the 115
 * storefronts for a typical app -- from "Apple changed the markup". Both
 * produce zero vote blocks, so without this check every small app would report
 * 80+ daily failures and the real signal would be buried.
 */
const PAGE_MARKER = 'customer-ratings'

const EMPTY: Histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }

export class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParseError'
  }
}

/**
 * Parse the histogram out of a customer-reviews page.
 *
 * Returns an all-zero histogram when the page is valid but the app has no
 * ratings in that storefront. Throws only when the page is unrecognisable,
 * which genuinely does mean the markup changed -- a partial or silently-empty
 * result would corrupt stored history with zeros that look like real data.
 */
export function parseHistogram(html: string): Histogram {
  const totals = [...html.matchAll(VOTE_BLOCK)].map((m) => Number(m[1]))

  if (totals.length === 5) {
    // Blocks run 5 stars down to 1.
    const [five, four, three, two, one] = totals
    return { 1: one, 2: two, 3: three, 4: four, 5: five }
  }

  if (totals.length === 0 && html.includes(PAGE_MARKER)) return { ...EMPTY }

  throw new ParseError(
    `Expected 5 star blocks, found ${totals.length}` +
      (html.includes(PAGE_MARKER) ? '' : ' (and the page did not look like a ratings page)') +
      `. Apple likely changed the page markup -- src/parse.ts needs updating.`,
  )
}

/** Total number of ratings across all five buckets. */
export function totalRatings(h: Histogram): number {
  return h[1] + h[2] + h[3] + h[4] + h[5]
}

/**
 * Weighted average rating.
 *
 * This reproduces Apple's own published average exactly (verified to 5 decimal
 * places), which is what lets us derive a *worldwide* average by summing
 * histograms -- a number Apple does not publish anywhere.
 *
 * Returns 0 for an app with no ratings rather than NaN.
 */
export function averageRating(h: Histogram): number {
  const total = totalRatings(h)
  if (total === 0) return 0
  return (h[1] + 2 * h[2] + 3 * h[3] + 4 * h[4] + 5 * h[5]) / total
}

/** Sum histograms into one. Used to build the worldwide aggregate. */
export function sumHistograms(histograms: Histogram[]): Histogram {
  const acc: Histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const h of histograms) {
    acc[1] += h[1]
    acc[2] += h[2]
    acc[3] += h[3]
    acc[4] += h[4]
    acc[5] += h[5]
  }
  return acc
}
