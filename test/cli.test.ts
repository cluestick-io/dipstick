import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { VERSION } from '../src/version.ts'

const run = promisify(execFile)
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

/** Run the CLI and capture output plus exit code, without throwing on non-zero. */
async function cli(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args])
    return { code: 0, out: stdout + stderr }
  } catch (err: any) {
    return { code: err.code ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

// `--help` is the first thing anyone types. It previously parsed as a command
// named "--help", printed "Unknown command", and exited 1.
test('--help prints usage and exits 0', async () => {
  const { code, out } = await cli(['--help'])
  assert.equal(code, 0)
  assert.match(out, /USAGE/)
  assert.doesNotMatch(out, /Unknown command/)
})

test('-h behaves the same as --help', async () => {
  const { code, out } = await cli(['-h'])
  assert.equal(code, 0)
  assert.match(out, /USAGE/)
})

test('help as a bare command works too', async () => {
  const { code, out } = await cli(['help'])
  assert.equal(code, 0)
  assert.match(out, /USAGE/)
})

test('no arguments prints usage but exits non-zero', async () => {
  // Being handed nothing is a usage error, unlike explicitly asking for help.
  const { code, out } = await cli([])
  assert.equal(code, 1)
  assert.match(out, /USAGE/)
})

test('--version prints the version', async () => {
  const { code, out } = await cli(['--version'])
  assert.equal(code, 0)
  assert.equal(out.trim(), VERSION)
})

test('an unknown command is rejected with a pointer to usage', async () => {
  const { code, out } = await cli(['frobnicate'])
  assert.equal(code, 1)
  assert.match(out, /Unknown command/)
  assert.match(out, /USAGE/)
})

test('the exported VERSION matches package.json', () => {
  // A published package whose --version lies is worse than having none.
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  )
  assert.equal(VERSION, pkg.version)
})

test('flags are recognised before the command as well as after', async () => {
  // `dipstick --help check` and `dipstick check --help` should both help.
  for (const args of [['--help', 'check'], ['check', '--help']]) {
    const { code, out } = await cli(args)
    assert.equal(code, 0, `${args.join(' ')} should exit 0`)
    assert.match(out, /USAGE/)
  }
})
