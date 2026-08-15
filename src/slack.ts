/**
 * The only module that talks to Slack. Kept separate from payload construction
 * so the message can be tested without a network or a real webhook.
 */
import type { SlackMessage } from './render/slack.ts'

export class SlackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlackError'
  }
}

export async function postToSlack(webhookUrl: string, message: SlackMessage): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
    // Critical: an invalid or revoked webhook answers 302, not 4xx. With the
    // default redirect-following that lands on a 200 and every run would
    // cheerfully report "Posted to Slack" while posting nothing at all.
    redirect: 'manual',
  })

  if (res.status < 200 || res.status >= 300) {
    const body = await res.text().catch(() => '')
    // Slack returns a plain-text reason ("invalid_payload", "no_service") that
    // is far more useful than the status code alone.
    const detail =
      res.status >= 300 && res.status < 400
        ? 'That redirect means Slack did not recognise the webhook — it is most likely wrong, revoked, or from a deleted app.'
        : 'Check that slack.webhookUrl points at a valid Incoming Webhook.'

    throw new SlackError(
      `Slack webhook returned ${res.status}${body ? `: ${body}` : ''}.\n${detail}`,
    )
  }
}
