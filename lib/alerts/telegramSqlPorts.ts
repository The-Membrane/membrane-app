import type { NeonQueryFunction } from '@neondatabase/serverless'
import { isAddress } from 'viem'

import type { FinalizedChainLog } from './outbox'
import type { TelegramBatchPorts, TelegramLeaseRow } from './telegramBatch'
import {
  makeVerifiedLiquidationEventLoader,
  type LiquidationSourceReads,
  type LiquidationSourceClaim,
} from './verifyLiquidationSource'

type Sql = Pick<NeonQueryFunction<false, false>, 'query'>

const POSITIVE_ID = /^[1-9][0-9]*$/
const HASH = /^0x[0-9a-fA-F]{64}$/

function integer(value: unknown, positive = false): number | null {
  if (
    typeof value !== 'bigint' &&
    typeof value !== 'number' &&
    !(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
  )
    return null
  const number = Number(value)
  return Number.isSafeInteger(number) && (positive ? number > 0 : number >= 0) ? number : null
}

function instant(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function sourceRow(value: Record<string, unknown> | undefined): LiquidationSourceClaim | null {
  if (!value) return null
  const chainId = integer(value.chain_id)
  const logIndex = integer(value.log_index)
  const blockNumber = integer(value.block_number, true)
  const occurredAt = instant(value.occurred_at)
  const firstObservedAt = instant(value.first_observed_at)
  if (chainId !== 1 || logIndex === null || blockNumber === null || !occurredAt || !firstObservedAt)
    throw new Error('malformed stored liquidation source')
  return {
    chainId: 1,
    emitter: value.emitter_address as string,
    transactionHash: value.transaction_hash as string,
    logIndex,
    blockNumber,
    blockHash: value.block_hash as string,
    occurredAt,
    firstObservedAt,
    kind: value.kind as FinalizedChainLog['kind'],
    subjectAddress: value.subject_address as string,
    sourceAttestation: value.source_attestation,
  }
}

function leaseRow(value: Record<string, unknown>): TelegramLeaseRow {
  const id = String(value.id)
  const eventId = String(value.event_id)
  if (!POSITIVE_ID.test(id) || !POSITIVE_ID.test(eventId))
    throw new Error('invalid leased alert identity')
  return {
    id,
    eventId,
    recipientAddress: value.recipient_address as string,
    channel: value.channel as string,
    leaseToken: value.lease_token as string,
  }
}

/** Inert adapter: all I/O is through caller-owned SQL, chain reads and sender. */
export function makeTelegramSqlPorts(
  sql: Sql,
  reads: LiquidationSourceReads,
  expectedEmitter: string,
  expectedRuntimeCodeHash: string,
  send: TelegramBatchPorts['send'],
): TelegramBatchPorts {
  if (!isAddress(expectedEmitter) || !HASH.test(expectedRuntimeCodeHash))
    throw new Error('unverified liquidation deployment configuration')
  const loadClaim = async (eventId: string) => {
    if (!POSITIVE_ID.test(eventId)) throw new Error('invalid alert event identity')
    const rows = await sql.query(
      `SELECT chain_id, emitter_address, transaction_hash, log_index, block_number,
              block_hash, occurred_at, first_observed_at, kind, subject_address, source_attestation
       FROM user_alert_chain_events WHERE id = $1::bigint LIMIT 1`,
      [eventId],
    )
    if (rows.length > 1) throw new Error('duplicate stored liquidation source')
    return sourceRow(rows[0])
  }
  return {
    expireLeases: async () => {
      await sql.query('SELECT * FROM expire_user_alert_leases()')
    },
    retireIneligible: async () => {
      await sql.query('SELECT * FROM retire_user_alert_outbox()')
    },
    lease: async (limit, leaseSeconds) => {
      const rows = await sql.query('SELECT * FROM lease_user_alert_outbox($1, $2)', [
        limit,
        leaseSeconds,
      ])
      return rows.map(leaseRow)
    },
    loadAttestedEvent: makeVerifiedLiquidationEventLoader(
      loadClaim,
      expectedEmitter,
      expectedRuntimeCodeHash,
      reads,
    ),
    suppress: async (id, token, reason) => {
      const rows = await sql.query('SELECT suppress_user_alert_before_send($1, $2, $3) AS ok', [
        id,
        token,
        reason,
      ])
      return rows.length === 1 && rows[0].ok === true
    },
    begin: async (id, token) => {
      const rows = await sql.query('SELECT * FROM begin_user_alert_delivery($1, $2)', [id, token])
      if (rows.length > 1) throw new Error('duplicate delivery destination')
      if (rows.length === 0) return null
      if (typeof rows[0].destination !== 'string')
        throw new Error('invalid delivery destination result')
      return rows[0].destination
    },
    send,
    complete: async (id, token) => {
      const rows = await sql.query('SELECT complete_user_alert_delivery($1, $2) AS ok', [id, token])
      return rows.length === 1 && rows[0].ok === true
    },
  }
}
