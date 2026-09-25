import type { NextApiRequest, NextApiResponse } from 'next'
import { timingSafeEqual } from 'crypto'
import { neon } from '@neondatabase/serverless'

import * as logic from '@/components/Radar/telegramLogic'
import { footerFor, uncoveredByVenue } from '@/pages/api/_lib/uncovered'
// The ONE handler, shared with scripts/telegram-poll.mjs (a .mjs import compiles
// here; precedent: pages/api/venues/[venue]/summary.ts → alarmRules.mjs).
import { botConfig, handleUpdate, sendMessage } from '@/scripts/lib/telegramBot.mjs'

// POST /api/telegram/webhook — PRODUCTION inbound for the address-alert bot
// (MOAT step 7). Telegram POSTs each update here once setWebhook registers this
// URL with a secret_token; every request must carry that secret in
// X-Telegram-Bot-Api-Secret-Token.
//   503 — webhook secret or bot env unset (ships dark)
//   401 — secret header missing or wrong
//   200 — any update we accepted, handled or not (a non-2xx makes Telegram retry)

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>

export type WebhookDeps = {
  env: (key: string) => string | undefined
  sql: () => Sql
  footerFor: (held: string[]) => Promise<string>
  fetchImpl?: typeof fetch
}

const sameSecret = (given: unknown, want: string): boolean => {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const createWebhookHandler =
  (deps: WebhookDeps) =>
  async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
    const config = botConfig(deps.env)
    if (!config.webhookSecret || !config.enabled) return res.status(503).json({ error: 'alerts bot not configured' })
    if (!sameSecret(req.headers['x-telegram-bot-api-secret-token'], config.webhookSecret)) {
      return res.status(401).json({ error: 'bad secret' })
    }
    try {
      const out = await handleUpdate(req.body, { sql: deps.sql(), logic, footerFor: deps.footerFor })
      if (out) {
        const sent = await sendMessage(config.token, out.chatId, out.text, deps.fetchImpl)
        if (!sent.ok) console.warn(`telegram webhook: reply failed — ${sent.description ?? sent.error_code}`)
      }
    } catch (e) {
      // Swallow: a 5xx makes Telegram redeliver the same update in a loop.
      console.warn(`telegram webhook: update failed — ${(e as Error)?.message ?? e}`)
    }
    return res.status(200).json({ ok: true })
  }

export default createWebhookHandler({
  env: (key) => process.env[key],
  sql: () => neon(process.env.DATABASE_URL as string) as unknown as Sql,
  footerFor: async (held) =>
    held.length ? footerFor(await uncoveredByVenue(held)) : 'no held venues: nothing to watch',
})
