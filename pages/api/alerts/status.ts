import type { NextApiRequest, NextApiResponse } from 'next'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { getContractAddress } from '@/config/evm/contracts'
import { botConfig } from '@/scripts/lib/telegramBot.mjs'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  let schemaReady = false
  try {
    const result = await db.execute(sql`
      SELECT to_regclass('public.user_alert_preferences') IS NOT NULL
        AND to_regclass('public.user_alert_nonces') IS NOT NULL
        AND to_regclass('public.user_alert_channel_links') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'user_alert_preferences'
            AND column_name = 'signed_issued_at'
        )
        AND to_regprocedure('public.confirm_user_alert_telegram_link(text,text)') IS NOT NULL
        AND to_regprocedure('public.disconnect_user_alert_telegram_chat(text)') IS NOT NULL AS ready`)
    schemaReady = result.rows[0]?.ready === true
  } catch {
    schemaReady = false
  }
  const bot = botConfig((key: string) => process.env[key])
  // Credentials alone do not prove that webhook/polling is receiving updates.
  // Require an explicit operator-verified inbound gate before offering a link.
  const telegramInboundVerified = process.env.TELEGRAM_ALERTS_INBOUND_VERIFIED === '1'
  return res.status(200).json({
    consentReady: schemaReady && (process.env.ALERT_CONSENT_SECRET?.length ?? 0) >= 32,
    telegramLinkReady: schemaReady && bot.enabled && telegramInboundVerified,
    emailConfirmationReady: false,
    ethereumContractsListed: Boolean(
      getContractAddress(1, 'cdp') &&
      getContractAddress(1, 'liquidationEngine') &&
      getContractAddress(1, 'curatorRegistry'),
    ),
    onchainEventIngestionReady: false,
    deliveryEnabled: false,
    venueObservationBotConfigured: bot.enabled,
  })
}
