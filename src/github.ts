/**
 * Posts the daily report as a comment on a GitHub issue.
 *
 * The appeal of this destination is that it needs nothing new: inside GitHub
 * Actions the repo and token are already in the environment, so there is no
 * account to create, no webhook to mint, and no secret to store. GitHub's own
 * notifications then deliver it to email and the mobile app.
 */
import type { GitHubConfig } from './config.ts'
import { buildIssueBody } from './render/github.ts'

/** Marks the issue dipstick owns, so it can find it again without title matching. */
export const TRACKING_LABEL = 'dipstick'

export class GitHubError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubError'
  }
}

async function api(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'dipstick',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  })

  const text = await res.text()
  let body: any
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }

  if (res.status < 200 || res.status >= 300) {
    // 403 here is almost always the workflow lacking `issues: write`, which is
    // worth naming outright rather than leaving as a bare status code.
    const hint =
      res.status === 403 || res.status === 404
        ? `\nIf running in GitHub Actions, make sure the workflow grants:\n\npermissions:\n  contents: write\n  issues: write`
        : ''
    throw new GitHubError(
      `GitHub API ${init.method ?? 'GET'} ${path} returned ${res.status}` +
        `${body?.message ? `: ${body.message}` : ''}${hint}`,
    )
  }

  return { status: res.status, body }
}

/** Find the open issue dipstick owns, or create one. */
async function resolveIssueNumber(
  token: string,
  repo: string,
  appNames: string[],
): Promise<number> {
  const { body: found } = await api(
    token,
    `/repos/${repo}/issues?state=open&labels=${TRACKING_LABEL}&per_page=1`,
  )

  if (Array.isArray(found) && found.length > 0) return found[0].number

  // The label may not exist yet. Creating an issue with an unknown label fails,
  // so ensure it exists first -- and tolerate the race where it already does.
  try {
    await api(token, `/repos/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({
        name: TRACKING_LABEL,
        color: '0e8a16',
        description: 'Daily App Store rating reports',
      }),
    })
  } catch (err) {
    if (!(err instanceof GitHubError) || !/already_exists|422/.test(err.message)) throw err
  }

  const { body: created } = await api(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: `Daily App Store ratings — ${appNames.join(', ')}`,
      body: buildIssueBody(appNames),
      labels: [TRACKING_LABEL],
    }),
  })

  return created.number
}

export async function postIssueComment(
  github: GitHubConfig,
  token: string,
  appNames: string[],
  comment: string,
): Promise<{ issue: number; url: string }> {
  const issue =
    github.issue === 'auto'
      ? await resolveIssueNumber(token, github.repo, appNames)
      : github.issue

  const { body } = await api(token, `/repos/${github.repo}/issues/${issue}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: comment }),
  })

  return { issue, url: body.html_url }
}
