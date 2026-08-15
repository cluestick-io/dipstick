/**
 * Human-readable terminal output.
 *
 * Colour is disabled when stdout isn't a TTY or NO_COLOR is set, so piping to a
 * file or a CI log yields clean text.
 */
import type { Delta, StarDeltas } from '../diff.ts'

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR

const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = paint('1')
const dim = paint('2')
const green = paint('32')
const red = paint('31')
const yellow = paint('33')

const num = (n: number) => n.toLocaleString('en-US')

/** Always show the sign: "+0" and "0" mean different things at a glance. */
function signed(n: number): string {
  const text = `${n > 0 ? '+' : ''}${num(n)}`
  if (n > 0) return green(text)
  if (n < 0) return red(text)
  return dim(text)
}

function arrow(change: number): string {
  if (change > 0) return green('▲')
  if (change < 0) return red('▼')
  return dim('=')
}

function starLine(stars: StarDeltas): string {
  return ([5, 4, 3, 2, 1] as const)
    .map((s) => `${dim(`${s}★`)} ${signed(stars[s])}`)
    .join('   ')
}

export function renderDelta(delta: Delta, { maxCountries = 15 } = {}): string {
  const out: string[] = []
  const { worldwide: w } = delta

  out.push('')
  out.push(`${bold(delta.appName)} ${dim(`(${delta.appId})`)}  ${dim(delta.date)}`)

  if (delta.isFirstRun) {
    out.push('')
    out.push(
      yellow('  First run — no baseline yet, so there is nothing to compare against.'),
    )
    out.push(dim('  Run again tomorrow to see the first daily change.'))
    out.push('')
    out.push(
      `  ${bold('Worldwide')}   ${bold(w.avgAfter.toFixed(5))}   ` +
        `${num(w.totalAfter)} ratings across ${delta.countryCount} storefronts`,
    )
    out.push('')
    return out.join('\n')
  }

  out.push(dim(`  compared with ${delta.baselineDate}`))
  out.push('')

  // Round first, then choose the arrow from the rounded value: an "▲ +0.00000"
  // reads as a contradiction. On a large app a day's ratings genuinely can't
  // shift the 5th decimal, and saying so plainly is more useful than implying
  // movement that isn't there.
  const avgChange = Number(w.avgChange.toFixed(5))
  const avgText = `${avgChange > 0 ? '+' : avgChange < 0 ? '' : '±'}${avgChange.toFixed(5)}`
  out.push(
    `  ${bold('Worldwide')}   ${bold(w.avgAfter.toFixed(5))} ${arrow(avgChange)} ${
      avgChange === 0 ? dim(avgText) : avgChange > 0 ? green(avgText) : red(avgText)
    }   ${num(w.totalAfter)} ratings  (${signed(w.net)})`,
  )
  out.push('')
  out.push(`  ${dim('Net change by star')}`)
  out.push(`    ${starLine(w.stars)}`)

  if (delta.changedCountries.length > 0) {
    out.push('')
    out.push(`  ${dim(`Countries that moved (${delta.changedCountries.length})`)}`)
    for (const c of delta.changedCountries.slice(0, maxCountries)) {
      const stars = ([5, 4, 3, 2, 1] as const)
        .filter((s) => c.stars[s] !== 0)
        .map((s) => `${s}★${c.stars[s] > 0 ? '+' : ''}${c.stars[s]}`)
        .join(' ')
      out.push(
        `    ${bold(c.country.padEnd(3))} ${signed(c.net).padStart(16)}   ${dim(stars)}`,
      )
    }
    if (delta.changedCountries.length > maxCountries) {
      out.push(dim(`    …and ${delta.changedCountries.length - maxCountries} more`))
    }
  } else {
    out.push('')
    out.push(dim('  No country changed today.'))
  }

  if (delta.failures.length > 0) {
    out.push('')
    out.push(yellow(`  ⚠ ${delta.failures.length} storefront(s) failed to fetch:`))
    for (const f of delta.failures.slice(0, 5)) {
      out.push(dim(`    ${f.country}: ${f.reason}`))
    }
    if (delta.failures.length > 5) {
      out.push(dim(`    …and ${delta.failures.length - 5} more`))
    }
  }

  out.push('')
  return out.join('\n')
}

/** Footnote shown once per report, not per app. */
export function netChangeNote(): string {
  return dim(
    'Numbers are net change: Apple removes fraudulent ratings and users edit their own,\n' +
      'so a bucket can move down as well as up.',
  )
}
