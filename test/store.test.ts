import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendSnapshot, readHistory, previousRow, toRow, rowToHistograms } from '../src/store.ts'
import { sumHistograms, totalRatings, averageRating, type Histogram } from '../src/parse.ts'
import type { Snapshot } from '../src/snapshot.ts'

const h = (a: number, b: number, c: number, d: number, e: number): Histogram => ({
  1: a,
  2: b,
  3: c,
  4: d,
  5: e,
})

function snapshot(date: string, countries: Record<string, Histogram>): Snapshot {
  const w = sumHistograms(Object.values(countries))
  return {
    date,
    appId: '284882215',
    appName: 'Facebook',
    worldwide: { total: totalRatings(w), avg: averageRating(w), histogram: w },
    countries,
    failures: [],
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), 'dipstick-'))

test('a snapshot survives a write/read round trip intact', () => {
  const dir = tmp()
  const snap = snapshot('2026-08-14', { us: h(1, 2, 3, 4, 5), jp: h(9, 8, 7, 6, 5) })
  appendSnapshot(dir, snap)

  const [row] = readHistory(dir, '284882215')
  assert.equal(row.date, '2026-08-14')
  assert.deepEqual(rowToHistograms(row), snap.countries)
})

test('each day appends exactly one line', () => {
  const dir = tmp()
  appendSnapshot(dir, snapshot('2026-08-13', { us: h(1, 1, 1, 1, 1) }))
  appendSnapshot(dir, snapshot('2026-08-14', { us: h(2, 2, 2, 2, 2) }))

  const raw = readFileSync(join(dir, '284882215.ndjson'), 'utf8').trim().split('\n')
  assert.equal(raw.length, 2)
  assert.equal(readHistory(dir, '284882215').length, 2)
})

test('re-running the same day rewrites that row instead of duplicating it', () => {
  // Manually re-running after a failed CI job must not corrupt history.
  const dir = tmp()
  appendSnapshot(dir, snapshot('2026-08-14', { us: h(1, 1, 1, 1, 1) }))
  appendSnapshot(dir, snapshot('2026-08-14', { us: h(5, 5, 5, 5, 5) }))

  const rows = readHistory(dir, '284882215')
  assert.equal(rows.length, 1)
  assert.deepEqual(rowToHistograms(rows[0]).us, h(5, 5, 5, 5, 5))
})

test('reading history for an app with no file yields an empty list', () => {
  assert.deepEqual(readHistory(tmp(), 'nope'), [])
})

test('previousRow picks the latest date strictly before the target', () => {
  const rows = [
    toRow(snapshot('2026-08-10', { us: h(1, 1, 1, 1, 1) })),
    toRow(snapshot('2026-08-13', { us: h(2, 2, 2, 2, 2) })),
    toRow(snapshot('2026-08-14', { us: h(3, 3, 3, 3, 3) })),
  ]
  assert.equal(previousRow(rows, '2026-08-14')?.date, '2026-08-13')
  // A gap in history is fine -- it falls back to the most recent earlier day.
  assert.equal(previousRow(rows, '2026-08-20')?.date, '2026-08-14')
  assert.equal(previousRow(rows, '2026-08-10'), undefined)
})

test('rows are stored packed, which is what keeps the file small', () => {
  const dir = tmp()
  appendSnapshot(dir, snapshot('2026-08-14', { us: h(1, 2, 3, 4, 5) }))
  const raw = readFileSync(join(dir, '284882215.ndjson'), 'utf8')
  assert.match(raw, /"us":\[1,2,3,4,5\]/)
})

test('corrupted history fails loudly with the offending line', () => {
  const dir = tmp()
  appendSnapshot(dir, snapshot('2026-08-14', { us: h(1, 1, 1, 1, 1) }))
  writeFileSync(join(dir, '284882215.ndjson'), '{"date":"2026-08-14"}\nnot json\n')
  assert.throws(() => readHistory(dir, '284882215'), /line 2/)
})
