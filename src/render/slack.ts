/**
 * Builds the Slack Block Kit payload.
 *
 * Pure: it returns an object and never touches the network, so the exact
 * message can be asserted in tests and previewed with `run --dry-run`.
 */
import type { Delta, StarDeltas } from '../diff.ts'

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

function appBlocks(delta: Delta): unknown[] {
  const { worldwide: w } = delta

  if (delta.isFirstRun) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*${delta.appName}*\n` +
            `Baseline recorded: *${w.avgAfter.toFixed(2)}* from ${num(w.totalAfter)} ratings ` +
            `across ${delta.countryCount} storefronts.\n` +
            `_First run — daily changes start tomorrow._`,
        },
      },
    ]
  }

  // Round before choosing the arrow, so the symbol never contradicts the number
  // printed next to it.
  const avgChange = Number(w.avgChange.toFixed(4))
  const avgText = `${avgChange > 0 ? '+' : avgChange < 0 ? '' : '±'}${avgChange.toFixed(4)}`
  const headline =
    `*${delta.appName}*  ${w.avgAfter.toFixed(2)} ${trend(avgChange)} ${avgText}\n` +
    `${signed(w.net)} ratings  ·  ${num(w.totalAfter)} total`

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: headline } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Net by star*   ${starSummary(w.stars)}` }],
    },
  ]

  if (delta.changedCountries.length > 0) {
    const shown = delta.changedCountries.slice(0, MAX_COUNTRIES)
    const lines = shown.map((c) => {
      const stars = ([5, 4, 3, 2, 1] as const)
        .filter((s) => c.stars[s] !== 0)
        .map((s) => `${s}★${signed(c.stars[s])}`)
        .join(' ')
      return `\`${c.country.toUpperCase().padEnd(2)}\` ${signed(c.net).padStart(7)}  ${stars}`
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

  if (delta.failures.length > 0) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:warning: ${delta.failures.length} storefront(s) failed to fetch — totals may be incomplete.`,
        },
      ],
    })
  }

  return blocks
}

/** Plain-text fallback: what shows in notifications and unfurled previews. */
function fallbackText(deltas: Delta[]): string {
  return deltas
    .map((d) => {
      if (d.isFirstRun) return `${d.appName}: baseline ${d.worldwide.avgAfter.toFixed(2)}`
      const change = Number(d.worldwide.avgChange.toFixed(4))
      const changeText = `${change > 0 ? '+' : change < 0 ? '' : '±'}${change.toFixed(4)}`
      return `${d.appName}: ${d.worldwide.avgAfter.toFixed(2)} (${changeText}), ${signed(d.worldwide.net)} ratings`
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
