# dipstick

Daily App Store rating deltas — worldwide, per-country, per-star, straight to Slack.

```
Facebook (284882215)  2026-08-15
  compared with 2026-08-14

  Worldwide   4.50734 ▲ +0.00012   98,388,963 ratings  (+641)

  Net change by star
    5★ +610   4★ 0   3★ +3   2★ 0   1★ +28

  Countries that moved (3)
    us              +440   5★+412 1★+28
    br              +198   5★+198
    jp                +3   3★+3
```

## Why

Apple publishes a *current* rating snapshot and nothing else. There is no day-over-day
change anywhere — not in App Store Connect, not in the public APIs — and no worldwide
number at all, only per-storefront figures.

dipstick takes one snapshot a day, stores it, and diffs against yesterday. The worldwide
average it reports is derived by summing every storefront's histogram, which reproduces
Apple's own per-country averages exactly, so it is a true figure rather than an estimate.

No credentials, for anything. That means you can track competitors as easily as your own apps.

## Quick start

```bash
npx @cluestick-io/dipstick init
```

Edit `dipstick.yaml`, then:

```bash
npx @cluestick-io/dipstick check
```

`check` writes nothing and posts nothing, so it is safe to run as often as you like.

## Configuration

The whole file, in the common case:

```yaml
apps:
  - id: "284882215"
    name: Facebook

slack:
  webhookUrl: env:SLACK_WEBHOOK_URL
```

`id` is the numeric App Store ID from the store URL (`apps.apple.com/app/id284882215`).

**Countries are all 115 storefronts by default.** Omit the key entirely and you get
worldwide coverage. Narrow it only if you want a smaller report:

```yaml
countries: [us, gb, de, jp]
```

## Commands

| Command | What it does |
|---|---|
| `dipstick check` | Fetch and show today's change. No writes, no Slack. |
| `dipstick run` | Fetch, record the snapshot, post to Slack. |
| `dipstick run --dry-run` | Everything except writing and posting; prints the Slack payload. |
| `dipstick history` | Show what has been recorded so far. |
| `dipstick init` | Scaffold the config and the GitHub Actions workflow. |

## Running it daily

`init` writes `.github/workflows/dipstick.yml`, which runs at 14:00 UTC, posts to Slack,
and commits the day's snapshot back to the repo.

Add your webhook under **Settings → Secrets and variables → Actions** as
`SLACK_WEBHOOK_URL`. Create the webhook itself at
[api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks) — it is a
single URL, no OAuth app and no tokens to rotate.

One thing worth knowing: GitHub disables scheduled workflows after 60 days of repository
inactivity. Because dipstick commits a snapshot every day, the repo never goes idle and
the schedule sustains itself. This is a common way cron workflows die silently elsewhere.

## Reading the numbers

**These are net changes, not gross new ratings.** Apple removes fraudulent reviews and
users can edit their own, so a bucket can move *down*. "5★ rose by 412" is what the data
supports; "412 new 5★ ratings" is not, and dipstick never claims it.

A consequence worth stating: if you reset ratings for a new version, you will see a large
negative number. dipstick reports it as-is rather than guessing that it was a reset —
mislabelling a genuine collapse in sentiment as routine housekeeping is a far worse
failure than an alarming-but-true figure.

**The first run has no baseline**, so it records a starting point and reports no delta.
Real numbers start the following day.

**Most storefronts will be empty, and that is normal.** A typical app has ratings in a few
dozen of the 115 storefronts. Those are recorded as having no ratings, not as errors — only
a genuine fetch or parse failure is flagged.

**On absolute totals.** dipstick derives everything from the ratings histogram. Apple's
separate lookup API sometimes reports a rating count for a storefront whose histogram page
shows none — a handful of ratings across very small markets. dipstick counts what the
histogram contains, which is the only source that breaks down by star. Since the tool
measures *change*, a consistent method matters more than matching another source's absolute
total, and day-over-day deltas are unaffected.

## Storage

One NDJSON file per app under `history/`, one line per day, so the daily commit is a
clean one-line diff. About 4 KB per app per day (≈1.5 MB/year) with all 115 storefronts.

## Development

```bash
npm test                     # unit tests, no network
npm run typecheck            # tsc --noEmit
npm run build                # emit dist/
npm run verify:storefronts   # live check of all 115 storefronts
```

Node 22.18+. One runtime dependency (`yaml`), which itself has none.

Locally, `node src/cli.ts` runs the TypeScript directly — no build needed. Distribution
does need one: Node refuses to strip types for anything under `node_modules`, so an
installed package must ship JavaScript. `tsc` runs on `prepare`, and
`rewriteRelativeImportExtensions` turns the `.ts` imports into `.js` on the way out, which
is what lets the same sources work both ways.

`erasableSyntaxOnly` is on, so the compiler rejects anything Node's stripper could not have
handled (enums, namespaces, parameter properties). That keeps `node src/cli.ts` and the
built output from ever diverging.

`verify:storefronts` exists because a wrong country→storefront mapping does not fail
loudly: it returns real, well-formed data for the *wrong* country. The parser fixtures in
`test/fixtures/` are saved pages in English, German, and Japanese, which pin the parser
against regressing to matching on localized label text.

## How it works

`GET itunes.apple.com/{cc}/customer-reviews/id{appId}` with an `X-Apple-Store-Front`
header. Undocumented but public, and stable for years. Three things about it are
surprising enough to be worth recording:

1. **The country in the URL path does not select the storefront.** Without the matching
   header you get US numbers back — not an error, just quietly wrong data.
2. **The header format is `{storefrontId},12`.** The widely-cited `{id}-1,12` form 400s on
   most storefronts.
3. **The page is localized**, so parsing on English label text works for us/gb and
   silently returns nothing for de/jp. dipstick parses structurally instead.

## License

MIT
