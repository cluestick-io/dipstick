/**
 * Renders the daily report as GitHub-flavoured Markdown.
 *
 * Pure, like the Slack renderer: returns a string and never touches the
 * network, so the exact comment can be asserted in tests and previewed with
 * `run --dry-run`.
 */
import type { CountryDelta, Delta, StarDeltas } from '../diff.ts'

/** Country rows beyond this go inside the collapsed section's tail. */
const MAX_COUNTRIES = 12

const num = (n: number) => n.toLocaleString('en-US')
const signed = (n: number) => `${n > 0 ? '+' : ''}${num(n)}`

function trend(change: number): string {
  if (change > 0) return '▲'
  if (change < 0) return '▼'
  return '='
}

/**
 * One column per scope: worldwide plus each featured storefront. Keeping them
 * side by side is what makes "the US drove all of today's 1★" visible at a
 * glance instead of requiring arithmetic across two tables.
 */
function starTable(worldwide: StarDeltas, featured: CountryDelta[]): string {
  const shown = featured.filter((c) => !c.isEmpty)
  // Featured columns lead, worldwide last -- same order as the lines above.
  const header = ['Rating', ...shown.map((c) => c.country.toUpperCase()), 'Worldwide']
  const rows = ([5, 4, 3, 2, 1] as const).map((s) =>
    ['★'.repeat(s), ...shown.map((c) => signed(c.stars[s])), signed(worldwide[s])],
  )

  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
}

/**
 * One standing line. Featured storefronts and worldwide share this format so
 * they read as peers in a single list rather than as two different things.
 */
function standingLine(
  label: string,
  avgAfter: number,
  avgBefore: number,
  net: number,
  total: number,
  showChange: boolean,
  suffix = '',
): string {
  if (!showChange) return `- **${label}** ${avgAfter.toFixed(5)} · ${num(total)} ratings${suffix}`

  const change = Number((avgAfter - avgBefore).toFixed(5))
  const text = `${change > 0 ? '+' : change < 0 ? '' : '±'}${change.toFixed(5)}`

  return (
    `- **${label}** ${avgAfter.toFixed(5)} ${trend(change)} \`${text}\` · ` +
    `**${signed(net)}** ratings · ${num(total)} total`
  )
}

/** A featured storefront's standing line, shown whether or not it moved. */
function featuredLine(c: CountryDelta, showChange: boolean): string {
  if (c.isEmpty) return `- **${c.country.toUpperCase()}** — _no ratings in this storefront_`
  return standingLine(
    c.country.toUpperCase(),
    c.avgAfter,
    c.avgBefore,
    c.net,
    c.totalAfter,
    showChange,
  )
}

function appSection(delta: Delta): string {
  const { worldwide: w } = delta
  const out: string[] = []

  out.push(`### ${delta.appName}`)

  if (delta.isFirstRun) {
    out.push('')
    out.push('Baseline recorded.')
    out.push('')
    out.push(...delta.featured.map((c) => featuredLine(c, false)))
    out.push(
      standingLine(
        'Worldwide',
        w.avgAfter,
        w.avgBefore,
        w.net,
        w.totalAfter,
        false,
        ` across ${delta.countryCount} storefronts`,
      ),
    )
    out.push('')
    out.push('_First run — daily changes start tomorrow._')
    if (delta.failures.length > 0) out.push('', failureNote(delta))
    return out.join('\n')
  }

  // Round before picking the arrow so the symbol never contradicts the number.
  const avgChange = Number(w.avgChange.toFixed(5))
  const avgText = `${avgChange > 0 ? '+' : avgChange < 0 ? '' : '±'}${avgChange.toFixed(5)}`

  out.push('')
  // Featured storefronts lead; worldwide closes the list as context.
  out.push(...delta.featured.map((c) => featuredLine(c, true)))
  out.push(
    `- **Worldwide** ${w.avgAfter.toFixed(5)} ${trend(avgChange)} \`${avgText}\` · ` +
      `**${signed(w.net)}** ratings · ${num(w.totalAfter)} total`,
  )
  out.push('')
  out.push(starTable(w.stars, delta.featured))

  if (delta.changedCountries.length > 0) {
    const shown = delta.changedCountries.slice(0, MAX_COUNTRIES)
    const rows = shown.map((c) => {
      const stars = ([5, 4, 3, 2, 1] as const)
        .filter((s) => c.stars[s] !== 0)
        .map((s) => `${s}★${signed(c.stars[s])}`)
        .join(', ')
      return `| \`${c.country.toUpperCase()}\` | ${signed(c.net)} | ${stars} |`
    })

    out.push('')
    out.push('<details>')
    out.push(`<summary>Countries that moved (${delta.changedCountries.length})</summary>`)
    out.push('')
    out.push(['| Store | Net | By star |', '| --- | --- | --- |', ...rows].join('\n'))
    if (delta.changedCountries.length > shown.length) {
      out.push('')
      out.push(`_…and ${delta.changedCountries.length - shown.length} more storefronts._`)
    }
    out.push('')
    out.push('</details>')
  } else {
    out.push('')
    out.push('_No country changed today._')
  }

  if (delta.failures.length > 0) out.push('', failureNote(delta))

  return out.join('\n')
}

function failureNote(delta: Delta): string {
  const codes = delta.failures
    .slice(0, 8)
    .map((f) => f.country.toUpperCase())
    .join(', ')
  return (
    `> [!WARNING]\n` +
    `> ${delta.failures.length} storefront(s) failed to fetch ` +
    `(${codes}${delta.failures.length > 8 ? '…' : ''}). Totals are incomplete.`
  )
}

export function buildIssueComment(deltas: Delta[]): string {
  const date = deltas[0]?.date ?? ''
  const sections = deltas.map(appSection).join('\n\n---\n\n')

  const footer = deltas.some((d) => !d.isFirstRun)
    ? '\n\n<sub>Net change since the previous snapshot — ratings can be removed or edited, so counts can fall.</sub>'
    : ''

  return `## ${date}\n\n${sections}${footer}`
}

/** Body used when dipstick creates the tracking issue itself. */
export function buildIssueBody(appNames: string[]): string {
  return [
    `Daily App Store rating changes for ${appNames.join(', ')}, posted by`,
    '[dipstick](https://github.com/cluestick-io/dipstick).',
    '',
    'Each comment covers one day: worldwide average, net change per star, and',
    'the storefronts that moved.',
    '',
    'Closing this issue will make dipstick open a new one on its next run.',
  ].join('\n')
}
