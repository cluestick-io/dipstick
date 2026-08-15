import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseConfig,
  resolveCountries,
  resolveFeatured,
  resolveSlackWebhook,
  ConfigError,
} from '../src/config.ts'
import { ALL_COUNTRIES } from '../src/storefronts.ts'

const MINIMAL = `
apps:
  - id: "284882215"
    name: Facebook
`

test('the minimal config needs only apps', () => {
  const cfg = parseConfig(MINIMAL)
  assert.deepEqual(cfg.apps, [{ id: '284882215', name: 'Facebook' }])
  assert.equal(cfg.countries.length, ALL_COUNTRIES.length)
  assert.equal(cfg.slackWebhook, undefined)
})

// The headline simplification: you never have to learn that `countries` exists.
test('absent, empty, and "all" countries all mean every storefront', () => {
  const expected = ALL_COUNTRIES.length
  assert.equal(resolveCountries(undefined).length, expected)
  assert.equal(resolveCountries(null).length, expected)
  assert.equal(resolveCountries([]).length, expected)
  assert.equal(resolveCountries('all').length, expected)
})

test('an explicit country list narrows the run and is case-insensitive', () => {
  assert.deepEqual(resolveCountries(['us', 'GB', 'jp']), ['us', 'gb', 'jp'])
})

test('duplicate countries are collapsed', () => {
  assert.deepEqual(resolveCountries(['us', 'us', 'gb']), ['us', 'gb'])
})

test('featured accepts a bare string as well as a list', () => {
  assert.deepEqual(resolveFeatured('us'), ['us'])
  assert.deepEqual(resolveFeatured(['us', 'GB']), ['us', 'gb'])
  assert.deepEqual(resolveFeatured(undefined), [])
})

test('an unknown featured country fails loudly', () => {
  assert.throws(() => resolveFeatured(['uk']), ConfigError)
})

test('a featured country is fetched even when countries is narrowed', () => {
  // Otherwise the featured storefront would silently report nothing forever.
  const cfg = parseConfig(`${MINIMAL}\ncountries: [gb]\nfeatured: [us]\n`)
  assert.ok(cfg.countries.includes('us'), 'us must be fetched to be reported')
  assert.ok(cfg.countries.includes('gb'))
  assert.deepEqual(cfg.featured, ['us'])
})

test('an unknown country code fails loudly rather than being skipped', () => {
  // Silently dropping "uk" (a common mistake for "gb") would mean quietly
  // tracking nothing for a market someone believed was covered.
  assert.throws(() => resolveCountries(['us', 'uk']), ConfigError)
})

test('a non-numeric app id is rejected with a pointer to where to find it', () => {
  const yaml = `apps:\n  - id: com.facebook.Facebook\n    name: Facebook\n`
  assert.throws(() => parseConfig(yaml), (err: Error) => {
    assert.ok(err instanceof ConfigError)
    assert.match(err.message, /apps\.apple\.com/)
    return true
  })
})

test('a config with no apps is rejected', () => {
  assert.throws(() => parseConfig('countries: [us]\n'), ConfigError)
  assert.throws(() => parseConfig('apps: []\n'), ConfigError)
})

test('an empty or malformed file is rejected', () => {
  assert.throws(() => parseConfig(''), ConfigError)
  assert.throws(() => parseConfig('apps:\n  - id: "1"\n   bad indent\n'), ConfigError)
})

test('app id given as a YAML number still works', () => {
  // Quoting the id is easy to forget and YAML will hand us a number.
  const cfg = parseConfig(`apps:\n  - id: 284882215\n    name: Facebook\n`)
  assert.equal(cfg.apps[0].id, '284882215')
})

test('an app with no name falls back to its id', () => {
  const cfg = parseConfig(`apps:\n  - id: "284882215"\n`)
  assert.equal(cfg.apps[0].name, 'App 284882215')
})

test('env: webhook resolves from the environment when posting', () => {
  const yaml = `${MINIMAL}\nslack:\n  webhookUrl: env:TEST_HOOK\n`
  process.env.TEST_HOOK = 'https://hooks.slack.com/services/AAA'
  try {
    assert.equal(resolveSlackWebhook(parseConfig(yaml)), 'https://hooks.slack.com/services/AAA')
  } finally {
    delete process.env.TEST_HOOK
  }
})

// The important half: loading must NOT need the secret, or `dipstick check`
// becomes unusable on any machine without the webhook configured.
test('loading a config does not require the webhook secret to exist', () => {
  const yaml = `${MINIMAL}\nslack:\n  webhookUrl: env:DEFINITELY_UNSET_HOOK\n`
  const cfg = parseConfig(yaml)
  assert.equal(cfg.slackWebhook, 'env:DEFINITELY_UNSET_HOOK')
  assert.equal(cfg.apps.length, 1)
})

test('a missing webhook env var explains both local and CI fixes, at post time', () => {
  const yaml = `${MINIMAL}\nslack:\n  webhookUrl: env:DEFINITELY_UNSET_HOOK\n`
  assert.throws(() => resolveSlackWebhook(parseConfig(yaml)), (err: Error) => {
    assert.ok(err instanceof ConfigError)
    assert.match(err.message, /repository secrets/)
    return true
  })
})

test('a literal webhook url is accepted for local use', () => {
  const yaml = `${MINIMAL}\nslack:\n  webhookUrl: https://hooks.slack.com/services/BBB\n`
  assert.equal(resolveSlackWebhook(parseConfig(yaml)), 'https://hooks.slack.com/services/BBB')
})

test('no slack block means no webhook, not an error', () => {
  assert.equal(resolveSlackWebhook(parseConfig(MINIMAL)), undefined)
})

test('a malformed webhook url is a config error, not an opaque fetch crash', () => {
  // Handing a bad value to fetch surfaces an undici stack that reads like a
  // dipstick bug instead of the typo it is.
  const yaml = `${MINIMAL}\nslack:\n  webhookUrl: not-a-url\n`
  assert.throws(() => resolveSlackWebhook(parseConfig(yaml)), (err: Error) => {
    assert.ok(err instanceof ConfigError)
    assert.match(err.message, /not a valid URL/)
    return true
  })
})

test('a non-http webhook scheme is rejected', () => {
  const yaml = `${MINIMAL}\nslack:\n  webhookUrl: ftp://example.com/hook\n`
  assert.throws(() => resolveSlackWebhook(parseConfig(yaml)), ConfigError)
})
