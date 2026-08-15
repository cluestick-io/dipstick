/**
 * Scaffolds a working setup: a config file and the daily workflow.
 *
 * The scaffolded config uses a real app id (Facebook) so `dipstick check` does
 * something useful immediately, rather than erroring on a placeholder.
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'

import { CONFIG_FILENAME } from './config.ts'

const CONFIG_TEMPLATE = `# Which apps to track. The id is the numeric App Store ID —
# find it in the store URL: apps.apple.com/app/id284882215
#
# No credentials are needed, so you can track competitors too.
apps:
  - id: "284882215"
    name: Facebook

# Post the daily report as a comment on a GitHub issue.
# Inside GitHub Actions this needs no setup at all: the repo and token come
# from the environment. "auto" finds dipstick's issue or opens one.
github:
  issue: auto

# Or post to Slack instead of / as well as the above.
# Create an Incoming Webhook at https://api.slack.com/messaging/webhooks
# and keep the URL in a secret rather than in this file.
#
# slack:
#   webhookUrl: env:SLACK_WEBHOOK_URL

# countries: omitted means all 115 App Store storefronts.
# Narrow it only if you want a smaller report:
#
# countries: [us, gb, de, jp]
`

const WORKFLOW_PATH = '.github/workflows/dipstick.yml'

const WORKFLOW_TEMPLATE = `name: dipstick

on:
  schedule:
    # 14:00 UTC daily. GitHub's scheduler is best-effort and can run late.
    - cron: "0 14 * * *"
  workflow_dispatch:

# contents: to commit the updated history file back to the repo.
# issues:   to post the daily report as an issue comment.
permissions:
  contents: write
  issues: write

jobs:
  ratings:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "24"

      # Installed straight from the public repo. Switch to the npm package
      # (npx --yes @cluestick-io/dipstick run) once it is published.
      - run: npx --yes github:cluestick-io/dipstick run
        env:
          # Provided automatically by Actions — nothing to configure.
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # Only needed if you enable the slack block in dipstick.yaml.
          SLACK_WEBHOOK_URL: \${{ secrets.SLACK_WEBHOOK_URL }}

      - name: Commit today's snapshot
        run: |
          set -euo pipefail
          git config user.name "dipstick"
          git config user.email "actions@github.com"
          git add history/

          # Nothing to commit is normal when the job is re-run the same day.
          if git diff --staged --quiet; then
            echo "No change to record."
            exit 0
          fi

          git commit -m "ratings: $(date -u +%Y-%m-%d)"

          # Anything landing on the branch between checkout and push causes a
          # non-fast-forward rejection. Across a year of daily runs that will
          # happen, so rebase and retry rather than losing the day's snapshot.
          for attempt in 1 2 3 4 5; do
            if git push; then
              exit 0
            fi
            echo "Push rejected (attempt $attempt) — rebasing onto latest."
            git pull --rebase --autostash
          done

          echo "Could not push after 5 attempts." >&2
          exit 1
`

export function writeScaffold(cwd = process.cwd()): void {
  const created: string[] = []
  const skipped: string[] = []

  const write = (path: string, contents: string) => {
    if (existsSync(path)) {
      skipped.push(path)
      return
    }
    mkdirSync(path.split('/').slice(0, -1).join('/') || '.', { recursive: true })
    writeFileSync(path, contents)
    created.push(path)
  }

  write(CONFIG_FILENAME, CONFIG_TEMPLATE)
  write(WORKFLOW_PATH, WORKFLOW_TEMPLATE)

  for (const path of created) console.log(`created  ${path}`)
  for (const path of skipped) console.log(`exists   ${path} (left alone)`)

  console.log(`
Next:
  1. Edit ${CONFIG_FILENAME} and replace the example app with your own.
  2. Run \`dipstick check\` to confirm it fetches.
  3. Commit and push. The workflow runs daily, posts the report to a GitHub
     issue, and commits history back — no secrets required.

The first run records a baseline only — deltas start on day two.`)
}
