/**
 * Builds the Slack Block Kit payload.
 *
 * Pure: it returns an object and never touches the network, so the exact
 * message can be asserted in tests and previewed with `run --dry-run`.
 */
import type { CountryDelta, Delta, StarDeltas } from '../diff.ts'

/** Beyond this, a global launch day would flood the channel. */
const MAX_COUNTRIES = 8

export type SlackMessage = {
  text: string
  blocks: unknown[]
}

const num = (n: number) => n.toLocaleString('en-US')
const signed = (n: number) => `${n > 0 ? '+' : ''}${num(n)}`

function trend(change: number): string {
  if (change > 0) return '▲'
  if (change < 0) return '▼'
  return '='
}

function starSummary(stars: StarDeltas): string {
  return ([5, 4, 3, 2, 1] as const).map((s) => `${s}★ ${signed(stars[s])}`).join('   ')
}

/**
 * A featured storefront's standing line, shown whether or not it moved.
 *
 * Bold label, plain figures -- deliberately identical to the Worldwide line so
 * the two read as peers in one list. Backticks here render as an inline code
 * chip in Slack, which made the country look like a tag rather than a heading
 * and clashed with the bold Worldwide beneath it.
 */
function featuredLine(c: CountryDelta, showChange: boolean): string {
  const label = `*${c.country.toUpperCase()}*`

  if (c.isEmpty) return `${label} _no ratings in this storefront_`
  if (!showChange) return `${label} ${c.avgAfter.toFixed(2)} · ${num(c.totalAfter)} ratings`

  const change = Number((c.avgAfter - c.avgBefore).toFixed(4))
  const text = `${change > 0 ? '+' : change < 0 ? '' : '±'}${change.toFixed(4)}`

  return `${label} ${c.avgAfter.toFixed(2)} ${trend(change)} ${text} · ${signed(c.net)} ratings · ${num(c.totalAfter)} total`
}

function failureBlock(delta: Delta): unknown {
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          `:warning: ${delta.failures.length} storefront(s) failed to fetch ` +
          `(${delta.failures
            .slice(0, 6)
            .map((f) => f.country.toUpperCase())
            .join(', ')}${delta.failures.length > 6 ? '…' : ''}) — totals are incomplete.`,
      },
    ],
  }
}

function appBlocks(delta: Delta): unknown[] {
  const { worldwide: w } = delta

  if (delta.isFirstRun) {
    const blocks: unknown[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*${delta.appName}*\n` +
            (delta.featured.length > 0
              ? delta.featured.map((c) => featuredLine(c, false)).join('\n') + '\n'
              : '') +
            `*Worldwide* ${w.avgAfter.toFixed(2)} · ${num(w.totalAfter)} ratings ` +
            `across ${delta.countryCount} storefronts\n` +
            `_First run — daily changes start tomorrow._`,
        },
      },
    ]
    // A baseline taken from a partial fetch skews every delta that follows, so
    // this is worth flagging loudly rather than hiding behind "first run".
    if (delta.failures.length > 0) blocks.push(failureBlock(delta))
    return blocks
  }

  // Round before choosing the arrow, so the symbol never contradicts the number
  // printed next to it.
  const avgChange = Number(w.avgChange.toFixed(4))
  const avgText = `${avgChange > 0 ? '+' : avgChange < 0 ? '' : '±'}${avgChange.toFixed(4)}`
  // Featured storefronts lead; worldwide closes the list as context.
  const standings = [
    ...delta.featured.map((c) => featuredLine(c, true)),
    `*Worldwide* ${w.avgAfter.toFixed(2)} ${trend(avgChange)} ${avgText} · ` +
      `${signed(w.net)} ratings · ${num(w.totalAfter)} total`,
  ]

  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${delta.appName}*\n${standings.join('\n')}` },
    },
  ]

  for (const c of delta.featured) {
    if (c.isEmpty) continue
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Net by star, ${c.country.toUpperCase()}*   ${starSummary(c.stars)}`,
        },
      ],
    })
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `*Net by star, worldwide*   ${starSummary(w.stars)}` }],
  })

  if (delta.changedCountries.length > 0) {
    const shown = delta.changedCountries.slice(0, MAX_COUNTRIES)
    const lines = shown.map((c) => {
      const stars = ([5, 4, 3, 2, 1] as const)
        .filter((s) => c.stars[s] !== 0)
        .map((s) => `${s}★${signed(c.stars[s])}`)
        .join(' ')
      // No padding: Slack renders this as proportional text, so padStart only
      // ever produced ragged whitespace rather than aligned columns.
      return `*${c.country.toUpperCase()}* ${signed(c.net)} · ${stars}`
    })

    if (delta.changedCountries.length > shown.length) {
      lines.push(`_…and ${delta.changedCountries.length - shown.length} more storefronts_`)
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*Countries that moved (${delta.changedCountries.length})*\n${lines.join('\n')}`,
        },
      ],
    })
  }

  if (delta.failures.length > 0) blocks.push(failureBlock(delta))

  return blocks
}

/** Plain-text fallback: what shows in notifications and unfurled previews. */
function fallbackText(deltas: Delta[]): string {
  return deltas
    .map((d) => {
      // Lead with the first featured storefront when there is one: the preview
      // is one line, and it should show the number you actually watch.
      const lead = d.featured.find((c) => !c.isEmpty)
      const scope = lead
        ? { label: `${lead.country.toUpperCase()} `, avg: lead.avgAfter, before: lead.avgBefore, net: lead.net }
        : { label: '', avg: d.worldwide.avgAfter, before: d.worldwide.avgBefore, net: d.worldwide.net }

      if (d.isFirstRun) return `${d.appName}: ${scope.label}baseline ${scope.avg.toFixed(2)}`

      const change = Number((scope.avg - scope.before).toFixed(4))
      const changeText = `${change > 0 ? '+' : change < 0 ? '' : '±'}${change.toFixed(4)}`
      return `${d.appName}: ${scope.label}${scope.avg.toFixed(2)} (${changeText}), ${signed(scope.net)} ratings`
    })
    .join(' · ')
}

export function buildSlackMessage(deltas: Delta[]): SlackMessage {
  const date = deltas[0]?.date ?? ''
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `App Store ratings — ${date}`, emoji: true },
    },
  ]

  deltas.forEach((delta, i) => {
    if (i > 0) blocks.push({ type: 'divider' })
    blocks.push(...appBlocks(delta))
  })

  // Stated once, at the bottom: these are net changes, and claiming otherwise
  // would misrepresent what the data can actually support.
  if (deltas.some((d) => !d.isFirstRun)) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '_Net change since the previous snapshot — ratings can be removed or edited, so counts can fall._',
        },
      ],
    })
  }

  return { text: fallbackText(deltas), blocks }
}
