/**
 * Loads and validates dipstick.yaml.
 *
 * Validation is strict and loud. A config typo that silently resolves to
 * "track nothing" would produce a cheerful empty report every morning, and
 * nobody would notice for weeks.
 */
import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

import { ALL_COUNTRIES, STOREFRONTS } from './storefronts.ts'

export const CONFIG_FILENAME = 'dipstick.yaml'

export type AppConfig = { id: string; name: string }

export type Config = {
  apps: AppConfig[]
  /** Resolved country list -- always concrete, never "all". */
  countries: string[]
  /**
   * The raw `slack.webhookUrl` value, still unresolved. Absent when Slack
   * isn't configured.
   *
   * Deliberately not resolved at load time: `check` and `--dry-run` never post,
   * and demanding a secret be present just to read ratings would make the
   * read-only commands unusable anywhere the secret isn't configured.
   * Call `resolveSlackWebhook` at the point of posting instead.
   */
  slackWebhook?: string
  /** Absent when GitHub issue posting isn't configured. */
  github?: GitHubConfig
  historyDir: string
}

export type GitHubConfig = {
  /** "owner/name". Defaults to $GITHUB_REPOSITORY, which Actions always sets. */
  repo: string
  /** An issue number, or 'auto' to find-or-create one. */
  issue: number | 'auto'
  /** Raw token spec, resolved at post time like the Slack webhook. */
  token: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Resolve a possibly-`env:`-prefixed value.
 *
 * `env:SLACK_WEBHOOK_URL` keeps the secret out of the committed file, which is
 * the whole point of supporting the prefix. A literal URL is allowed too, for
 * local experimentation.
 */
function resolveSecret(value: string, field: string): string {
  if (!value.startsWith('env:')) return value

  const name = value.slice(4).trim()
  const resolved = process.env[name]
  if (!resolved) {
    throw new ConfigError(
      `${field} refers to environment variable ${name}, which is not set.\n` +
        `  Locally:  export ${name}="https://hooks.slack.com/services/..."\n` +
        `  In CI:    add ${name} to your repository secrets.`,
    )
  }
  return resolved
}

/**
 * Normalise the country list.
 *
 * Absent, empty, and the literal "all" all mean every storefront -- so the
 * common config never has to mention countries at all.
 */
export function resolveCountries(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === 'all') return ALL_COUNTRIES
  if (Array.isArray(raw) && raw.length === 0) return ALL_COUNTRIES

  if (!Array.isArray(raw)) {
    throw new ConfigError(
      `"countries" must be a list of country codes, or omitted entirely to mean all ${ALL_COUNTRIES.length} storefronts.`,
    )
  }

  const codes = raw.map((c) => String(c).toLowerCase())
  const unknown = codes.filter((c) => !(c in STOREFRONTS))
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown country code(s) in "countries": ${unknown.join(', ')}.\n` +
        `Valid codes are the ${ALL_COUNTRIES.length} App Store storefronts, e.g. us, gb, de, jp.`,
    )
  }
  return [...new Set(codes)]
}

export function parseConfig(source: string, env = process.env): Config {
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILENAME} is not valid YAML: ${(err as Error).message}`)
  }

  if (raw === null || typeof raw !== 'object') {
    throw new ConfigError(`${CONFIG_FILENAME} is empty. Run \`dipstick init\` to scaffold one.`)
  }

  const cfg = raw as Record<string, unknown>

  if (!Array.isArray(cfg.apps) || cfg.apps.length === 0) {
    throw new ConfigError(
      `${CONFIG_FILENAME} must list at least one app under "apps":\n\n` +
        `apps:\n  - id: "284882215"\n    name: Facebook`,
    )
  }

  const apps: AppConfig[] = cfg.apps.map((entry, i) => {
    const app = entry as Record<string, unknown>
    const id = app?.id === undefined ? undefined : String(app.id)
    if (!id || !/^\d+$/.test(id)) {
      throw new ConfigError(
        `apps[${i}].id must be the numeric App Store ID (e.g. "284882215"), got ${JSON.stringify(app?.id)}.\n` +
          `You can find it in the App Store URL: apps.apple.com/app/id284882215`,
      )
    }
    return { id, name: app.name ? String(app.name) : `App ${id}` }
  })

  const slack = cfg.slack as Record<string, unknown> | undefined

  return {
    apps,
    countries: resolveCountries(cfg.countries),
    slackWebhook: slack?.webhookUrl ? String(slack.webhookUrl) : undefined,
    github: parseGitHub(cfg.github, env),
    historyDir: cfg.historyDir ? String(cfg.historyDir) : 'history',
  }
}

function parseGitHub(raw: unknown, env: NodeJS.ProcessEnv): GitHubConfig | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined

  const cfg = (typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  // Both default to what GitHub Actions already provides, so the common case
  // needs no repo, no token, and no secret of any kind.
  const repo = cfg.repo ? String(cfg.repo) : env.GITHUB_REPOSITORY
  if (!repo) {
    throw new ConfigError(
      `github.repo is not set and $GITHUB_REPOSITORY is unavailable.\n` +
        `Set it explicitly when running outside GitHub Actions:\n\n` +
        `github:\n  repo: owner/name\n  issue: auto`,
    )
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new ConfigError(`github.repo must be "owner/name", got ${JSON.stringify(repo)}.`)
  }

  const rawIssue = cfg.issue ?? 'auto'
  let issue: number | 'auto'
  if (rawIssue === 'auto') {
    issue = 'auto'
  } else {
    issue = Number(rawIssue)
    if (!Number.isInteger(issue) || issue <= 0) {
      throw new ConfigError(
        `github.issue must be a positive issue number or "auto", got ${JSON.stringify(rawIssue)}.`,
      )
    }
  }

  return { repo, issue, token: cfg.token ? String(cfg.token) : 'env:GITHUB_TOKEN' }
}

/** Resolve the GitHub token only when about to post, mirroring the Slack path. */
export function resolveGitHubToken(github: GitHubConfig): string {
  return resolveSecret(github.token, 'github.token')
}

/**
 * Resolve the webhook to an actual URL. Called only when about to post, so
 * read-only commands never require the secret to exist.
 */
export function resolveSlackWebhook(config: Config): string | undefined {
  if (!config.slackWebhook) return undefined

  const url = resolveSecret(config.slackWebhook, 'slack.webhookUrl')

  // Validate the shape here. Handing a malformed value straight to fetch
  // produces an opaque undici stack trace that looks like a dipstick crash
  // rather than the config typo it actually is.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ConfigError(
      `slack.webhookUrl is not a valid URL: ${JSON.stringify(url)}\n` +
        `Expected something like https://hooks.slack.com/services/T000/B000/xxxx`,
    )
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(
      `slack.webhookUrl must be an http(s) URL, got "${parsed.protocol}".`,
    )
  }

  return url
}

export function loadConfig(path = CONFIG_FILENAME): Config {
  if (!existsSync(path)) {
    throw new ConfigError(
      `No ${path} found in this directory.\n` + `Run \`dipstick init\` to create one.`,
    )
  }
  return parseConfig(readFileSync(path, 'utf8'))
}
