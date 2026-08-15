#!/usr/bin/env node
/**
 * dipstick — daily App Store rating deltas.
 *
 * `check` is deliberately side-effect free (no writes, no Slack) so it is safe
 * to run repeatedly while iterating. `run` is the one that records history and
 * posts.
 */
import {
  loadConfig,
  resolveSlackWebhook,
  resolveGitHubTarget,
  ConfigError,
  CONFIG_FILENAME,
  type Config,
} from './config.ts'
import { takeSnapshot, utcDate, type Snapshot } from './snapshot.ts'
import { readHistory, previousRow, appendSnapshot } from './store.ts'
import { diffSnapshot, type Delta } from './diff.ts'
import { renderDelta, netChangeNote } from './render/terminal.ts'
import { buildSlackMessage } from './render/slack.ts'
import { postToSlack, SlackError } from './slack.ts'
import { buildIssueComment } from './render/github.ts'
import { postIssueComment, GitHubError } from './github.ts'
import { writeScaffold } from './init.ts'

const HELP = `
dipstick — daily App Store rating deltas

USAGE
  dipstick <command> [options]

COMMANDS
  check      Fetch current ratings and show the change. Writes nothing, posts nothing.
  run        Fetch, record today's snapshot, and post to Slack.
  history    Show recorded history for each configured app.
  init       Scaffold ${CONFIG_FILENAME} and a GitHub Actions workflow.

OPTIONS
  --dry-run  (run) Do everything except write history and post to Slack.
             Prints the exact Slack payload instead.
  --config   Path to config file (default: ${CONFIG_FILENAME})
  --date     Override the snapshot date, YYYY-MM-DD (default: today, UTC)
  -h, --help Show this message

EXAMPLES
  dipstick init
  dipstick check
  dipstick run --dry-run
`

type Args = { command?: string; flags: Record<string, string | boolean> }

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('-')) continue
    const key = arg.replace(/^--?/, '')
    const next = rest[i + 1]
    if (next && !next.startsWith('-')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return { command, flags }
}

/** Snapshot every configured app and diff each against its own baseline. */
async function collect(
  config: Config,
  date: string,
): Promise<{ deltas: Delta[]; snapshots: Snapshot[] }> {
  const deltas: Delta[] = []
  const snapshots: Snapshot[] = []

  for (const app of config.apps) {
    // Read history first: knowing which storefronts had ratings yesterday is
    // what lets the snapshot tell a throttled response apart from a real zero.
    const baseline = previousRow(readHistory(config.historyDir, app.id), date)
    const knownNonZero = new Set(Object.keys(baseline?.countries ?? {}))

    const snapshot = await takeSnapshot(app, config.countries, { date, knownNonZero })
    snapshots.push(snapshot)
    deltas.push(diffSnapshot(snapshot, baseline, config.featured))
  }

  return { deltas, snapshots }
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2))

  if (!command || flags.h || flags.help || command === 'help') {
    console.log(HELP)
    return command ? 0 : 1
  }

  const configPath = typeof flags.config === 'string' ? flags.config : CONFIG_FILENAME
  const date = typeof flags.date === 'string' ? flags.date : utcDate()

  switch (command) {
    case 'init': {
      writeScaffold()
      return 0
    }

    case 'check': {
      const { deltas } = await collect(loadConfig(configPath), date)
      for (const delta of deltas) console.log(renderDelta(delta))
      if (deltas.some((d) => !d.isFirstRun)) console.log(netChangeNote() + '\n')
      return 0
    }

    case 'run': {
      const dryRun = flags['dry-run'] === true
      const config = loadConfig(configPath)
      const historyDir = config.historyDir

      // Resolve credentials before doing any work. Discovering a missing secret
      // *after* fetching and writing history would leave the run half-done:
      // recorded but never announced, which is the failure nobody notices.
      const webhook = dryRun ? undefined : resolveSlackWebhook(config)
      const githubTarget =
        dryRun || !config.github ? undefined : resolveGitHubTarget(config.github)

      const { deltas, snapshots } = await collect(config, date)

      for (const delta of deltas) console.log(renderDelta(delta))

      const message = buildSlackMessage(deltas)
      const comment = buildIssueComment(deltas)

      if (dryRun) {
        if (config.slackWebhook) {
          console.log('--- Slack payload (dry run, nothing sent) ---')
          console.log(JSON.stringify(message, null, 2))
        }
        if (config.github) {
          console.log('--- GitHub issue comment (dry run, nothing posted) ---')
          console.log(comment)
        }
        console.log('--- history not written (dry run) ---')
        return 0
      }

      for (const snapshot of snapshots) appendSnapshot(historyDir, snapshot)
      console.log(`Recorded ${snapshots.length} snapshot(s) to ${historyDir}/`)

      if (webhook) {
        await postToSlack(webhook, message)
        console.log('Posted to Slack.')
      }

      if (config.github && githubTarget) {
        const { issue, url } = await postIssueComment(
          githubTarget.repo,
          githubTarget.token,
          config.github.issue,
          config.apps.map((a) => a.name),
          comment,
        )
        console.log(`Posted to ${githubTarget.repo}#${issue} — ${url}`)
      }

      if (!webhook && !config.github) {
        console.log('No notifier configured — recorded history only.')
      }
      return 0
    }

    case 'history': {
      const config = loadConfig(configPath)
      for (const app of config.apps) {
        const rows = readHistory(config.historyDir, app.id)
        console.log(`\n${app.name} (${app.id}) — ${rows.length} day(s) recorded`)
        for (const row of rows) {
          console.log(
            `  ${row.date}  avg ${row.worldwide.avg.toFixed(5)}  ` +
              `${row.worldwide.total.toLocaleString('en-US')} ratings  ` +
              `${Object.keys(row.countries).length} storefronts`,
          )
        }
      }
      console.log('')
      return 0
    }

    default:
      console.error(`Unknown command "${command}".`)
      console.log(HELP)
      return 1
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Config and Slack problems are environment/user error: show the
    // (deliberately actionable) message without a stack trace. Anything else
    // is a real bug and deserves the full trace.
    if (err instanceof ConfigError || err instanceof SlackError || err instanceof GitHubError) {
      console.error(`\n${err.message}\n`)
    } else {
      console.error(err)
    }
    process.exit(1)
  })
