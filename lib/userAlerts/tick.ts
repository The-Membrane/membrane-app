/**
 * The operator tick's entry into user threshold alerts, loaded through tsx by
 * scripts/check-venue-alarms.mjs — and ONLY when the Telegram alerts bot is
 * configured with TELEGRAM_ALERTS_WEBHOOK_SECRET (sendThresholdAlerts ships dark
 * otherwise). Evaluates the owners linked to a chat with the same live sources the
 * feed uses, so their events exist before the sender looks for them.
 */

import { evaluateOwners } from './service'
import type { Sql } from './store'
import { liveSources, readValues } from './values'

export const evaluateLinkedOwners = (sql: Sql, ownerIds: readonly string[]) =>
  evaluateOwners(sql, ownerIds, { readValues: (needs) => readValues(needs, liveSources(() => sql)) })
