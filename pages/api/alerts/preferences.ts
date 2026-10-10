import type { NextApiRequest, NextApiResponse } from 'next'
import { verifyMessage } from 'viem'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { botConfig } from '@/scripts/lib/telegramBot.mjs'
import { validConsentChallenge } from '@/lib/alerts/challenge'
import { consentStatement, normalizeChoices } from '@/lib/alerts/consent'
import { createTelegramLink, readPreference, savePreference } from '@/lib/alerts/store'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const secret = process.env.ALERT_CONSENT_SECRET ?? ''
  if (secret.length < 32) return res.status(503).json({ error: 'Alert consent is not configured' })
  let body: Record<string, unknown>
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }
  const choice = normalizeChoices(body)
  if (!choice || !validConsentChallenge(choice, secret)) {
    return res.status(400).json({ error: 'Invalid or expired alert challenge' })
  }
  const signature = body?.signature
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{128,132}$/.test(signature)) {
    return res.status(400).json({ error: 'Wallet signature required' })
  }
  const statement = consentStatement(choice)
  let verified = false
  try {
    verified = await verifyMessage({
      address: choice.address,
      message: statement,
      signature: signature as `0x${string}`,
    })
  } catch {
    verified = false
  }
  if (!verified)
    return res.status(401).json({ error: 'Signature does not match this address and consent' })

  try {
    if (choice.action === 'inspect')
      return res.status(200).json({ preference: await readPreference(choice.address) })
    const saved = await savePreference(choice, statement, signature)
    if (saved.replay)
      return res.status(409).json({ error: 'Consent already used; request a fresh challenge' })
    const bot = botConfig((key: string) => process.env[key])
    let bridgeReady = false
    if (bot.enabled && process.env.TELEGRAM_ALERTS_INBOUND_VERIFIED === '1') {
      try {
        const bridge = await db.execute(sql`
          SELECT to_regprocedure('public.confirm_user_alert_telegram_link(text,text)') IS NOT NULL
            AND to_regprocedure('public.disconnect_user_alert_telegram_chat(text)') IS NOT NULL AS ready`)
        bridgeReady = bridge.rows[0]?.ready === true
      } catch {
        // Saving the signed preference succeeded; only Telegram linking is withheld.
      }
    }
    let telegramLink = null
    if (
      bot.enabled &&
      process.env.TELEGRAM_ALERTS_INBOUND_VERIFIED === '1' &&
      bridgeReady &&
      !saved.preference.telegramConfirmed
    ) {
      try {
        telegramLink = await createTelegramLink(choice, bot.username)
      } catch {
        // Signed consent is committed. A failed optional link must not report
        // the whole request as unsaved; the owner can request fresh consent.
      }
    }
    return res.status(200).json({ preference: saved.preference, telegramLink })
  } catch {
    return res
      .status(503)
      .json({ error: 'Alert preference storage unavailable; nothing will be delivered' })
  }
}
