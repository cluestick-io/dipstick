/**
 * Append-only daily history, one NDJSON file per app.
 *
 * NDJSON because the daily write is a single appended line: it reviews cleanly
 * in a git diff, and two runs on different days never touch the same line.
 *
 * Histograms are stored as a 5-element array in star order rather than an
 * object, which roughly halves the file for ~115 countries a day.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Histogram } from './parse.ts'
import type { Snapshot } from './snapshot.ts'

/** [1★, 2★, 3★, 4★, 5★] */
type PackedHistogram = [number, number, number, number, number]

export type HistoryRow = {
  date: string
  worldwide: { total: number; avg: number }
  countries: Record<string, PackedHistogram>
}

const pack = (h: Histogram): PackedHistogram => [h[1], h[2], h[3], h[4], h[5]]
const unpack = (p: PackedHistogram): Histogram => ({
  1: p[0],
  2: p[1],
  3: p[2],
  4: p[3],
  5: p[4],
})

export function historyPath(historyDir: string, appId: string): string {
  return join(historyDir, `${appId}.ndjson`)
}

export function toRow(snapshot: Snapshot): HistoryRow {
  const countries: Record<string, PackedHistogram> = {}
  for (const [country, histogram] of Object.entries(snapshot.countries)) {
    countries[country] = pack(histogram)
  }
  return {
    date: snapshot.date,
    worldwide: {
      total: snapshot.worldwide.total,
      // Full precision would write 15 noisy digits into every line.
      avg: Number(snapshot.worldwide.avg.toFixed(5)),
    },
    countries,
  }
}

export function rowToHistograms(row: HistoryRow): Record<string, Histogram> {
  const out: Record<string, Histogram> = {}
  for (const [country, packed] of Object.entries(row.countries)) out[country] = unpack(packed)
  return out
}

export function readHistory(historyDir: string, appId: string): HistoryRow[] {
  const path = historyPath(historyDir, appId)
  if (!existsSync(path)) return []

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as HistoryRow
      } catch {
        throw new Error(`${path} line ${i + 1} is not valid JSON. History may be corrupted.`)
      }
    })
}

/** Most recent row strictly before `date` -- the baseline to diff against. */
export function previousRow(rows: HistoryRow[], date: string): HistoryRow | undefined {
  return rows
    .filter((r) => r.date < date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1)
}

/**
 * Append a snapshot.
 *
 * Re-running on a date already recorded rewrites that row in place instead of
 * appending a duplicate, so a manual re-run after a failed job is safe.
 */
export function appendSnapshot(historyDir: string, snapshot: Snapshot): void {
  mkdirSync(historyDir, { recursive: true })
  const path = historyPath(historyDir, snapshot.appId)
  const row = toRow(snapshot)
  const existing = readHistory(historyDir, snapshot.appId)

  if (existing.some((r) => r.date === row.date)) {
    const rewritten = existing.map((r) => (r.date === row.date ? row : r))
    writeFileSync(path, rewritten.map((r) => JSON.stringify(r)).join('\n') + '\n')
    return
  }

  appendFileSync(path, JSON.stringify(row) + '\n')
}
