import { neon } from '@neondatabase/serverless'

import type { Sql } from '@/lib/userAlerts/store'
// The bot's ONE env reader (scripts/lib/telegramBot.mjs): the same three names the
// webhook and the tick use, so "telegram on" means the same thing everywhere.
import { botConfig } from '@/scripts/lib/telegramBot.mjs'

// Shared wiring for /api/alerts/*. Env values are read here and never returned:
// callers get booleans and URLs built from the PUBLIC bot username only.

export type Env = (key: string) => string | undefined

export const processEnv: Env = (key) => process.env[key]

export const siteUrl = (env: Env): string => (env('NEXT_PUBLIC_SITE_URL') || 'https://membrane.money').replace(/\/$/, '')

/** A neon tagged-template client, made on first use (no DATABASE_URL read at import). */
export const neonSql = (env: Env): (() => Sql) => {
  let client: Sql | null = null
  return () => (client ??= neon(env('DATABASE_URL') as string) as unknown as Sql)
}

/**
 * Telegram threshold delivery is ON only when the bot token, its username AND the
 * webhook secret are all set — the owner's switch is TELEGRAM_ALERTS_WEBHOOK_SECRET.
 */
export const telegramOn = (env: Env): { on: boolean; username: string } => {
  const c = botConfig(env)
  return { on: c.enabled && !!c.webhookSecret, username: c.username }
}

export const feedPath = (token: string): string => `/api/alerts/feed/${token}`
