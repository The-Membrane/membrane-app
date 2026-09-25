// telegram-poll.mjs — LOCAL/DEV inbound for the address-alert bot (MOAT step 7).
//
// Production receives commands on pages/api/telegram/webhook.ts. Without a public
// URL, this drains the same commands with getUpdates and answers them through the
// SAME handler (scripts/lib/telegramBot.mjs handleUpdate). The offset lives in
// alert_bot_state, so a restart never re-answers a command.
//
//   node scripts/telegram-poll.mjs           one drain, then exit
//   node scripts/telegram-poll.mjs --loop    long-poll until Ctrl-C
//
// The hourly tick (scripts/check-venue-alarms.mjs) also drains once per run.
// Refuses to run in webhook mode (TELEGRAM_ALERTS_WEBHOOK_SECRET set): Telegram
// rejects getUpdates while a webhook is registered.
//
// Env (.env.local): DATABASE_URL(_UNPOOLED), TELEGRAM_ALERTS_BOT_TOKEN,
// TELEGRAM_ALERTS_BOT_USERNAME. Unset bot env ⇒ one log line, exit 0.

import { neon } from '@neondatabase/serverless'
import { require as tsxRequire } from 'tsx/cjs/api'

import { readEnv, loadConfig } from './lib/venue-reads.mjs'
import { botConfig, pollOnce, scriptFooterFor } from './lib/telegramBot.mjs'

const { get } = readEnv()
const config = botConfig(get)
if (!config.enabled) {
  console.log('telegram alerts: bot not configured (TELEGRAM_ALERTS_BOT_TOKEN/USERNAME unset) — nothing to poll')
  process.exit(0)
}
if (config.webhookSecret) {
  console.log('telegram alerts: webhook mode (TELEGRAM_ALERTS_WEBHOOK_SECRET set) — polling disabled')
  process.exit(0)
}
const dbUrl = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!dbUrl) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}
const sql = neon(dbUrl)
// tsx's CJS require resolves the `@/` alias from tsconfig.json.
const logic = tsxRequire('../components/Radar/telegramLogic.ts', import.meta.url)
const footerFor = scriptFooterFor(sql, loadConfig())

const loop = process.argv.includes('--loop')
do {
  const { handled, ok } = await pollOnce({ sql, logic, footerFor, config, timeoutSec: loop ? 25 : 0 })
  if (handled) console.log(`telegram alerts: answered ${handled} command(s)`)
  if (loop && !ok) await new Promise((r) => setTimeout(r, 5000)) // back off on a failed getUpdates
} while (loop)
