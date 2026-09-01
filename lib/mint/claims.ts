// Server-only mint-claim bookkeeping helpers (Phase 4).
// Shared by pages/api/mint/{voucher,confirm,expire}.

import { and, eq, inArray, sql } from 'drizzle-orm'

import { db } from '@/db'
import { byteLedger, mintClaims, pets } from '@/db/schema'
import { ZERO_HASH } from './eip712'

if (typeof window !== 'undefined') {
  throw new Error('lib/mint/claims must never be imported from client-side code')
}

export const VOUCHER_TTL_SECONDS = 60 * 60 // 1 hour

/** Shape of the voucher we persist in mint_claims.voucher (JSONB). bigints stored as strings. */
export type StoredVoucher = {
  to: `0x${string}`
  petAttrsHash: `0x${string}`
  byteAmount: string // decimal string
  nonce: string // decimal string
  deadline: number // unix seconds
  signature: `0x${string}`
}

export function voucherKind(petAttrsHash: string): 'pet_and_byte' | 'byte_only' {
  return petAttrsHash === ZERO_HASH ? 'byte_only' : 'pet_and_byte'
}

/**
 * BYTE currently claimable by a player, in game-ledger base units.
 *
 *   claimable = SUM(byte_ledger.delta) − SUM(byte_amount of in-flight claims)
 *
 * In-flight = status IN ('issued','fee_paid') ONLY. We deliberately EXCLUDE 'minted':
 * POST /api/mint/confirm records every settled claim as a NEGATIVE `mint_debit` row in
 * byte_ledger, so a minted claim is already netted out of SUM(byte_ledger.delta). Also
 * subtracting it via the claims table would double-count it and could drive the amount
 * negative (e.g. win 100 → mint 100 → ledger=0; a later +50 win must be claimable as 50,
 * not 50−100). Issued/fee_paid claims have NO ledger debit yet, so they must be subtracted
 * here to stop the same BYTE being promised to two vouchers.
 */
export async function claimableByteAmount(playerId: string): Promise<bigint> {
  const [ledgerRows, claimedRows] = await db.batch([
    db
      .select({ total: sql<string>`coalesce(sum(${byteLedger.delta}), 0)` })
      .from(byteLedger)
      .where(eq(byteLedger.playerId, playerId)),
    db
      .select({ total: sql<string>`coalesce(sum(${mintClaims.byteAmount}), 0)` })
      .from(mintClaims)
      .where(
        and(
          eq(mintClaims.playerId, playerId),
          inArray(mintClaims.status, ['issued', 'fee_paid']),
        ),
      ),
  ])
  const ledger = BigInt(ledgerRows[0]?.total ?? '0')
  const committed = BigInt(claimedRows[0]?.total ?? '0')
  const claimable = ledger - committed
  return claimable > 0n ? claimable : 0n
}

/**
 * Hygiene: flip this player's past-deadline 'issued' claims to 'expired', and roll any pet
 * that was parked at 'claim_pending' back to 'offchain' so it can be re-claimed. Safe to call
 * opportunistically at the top of the voucher route (or directly via POST /api/mint/expire).
 * Deadline lives in the voucher JSONB, so we filter in JS then batch the writes.
 */
export async function expireStaleClaims(playerId: string): Promise<number> {
  const rows = await db
    .select({ id: mintClaims.id, petId: mintClaims.petId, voucher: mintClaims.voucher })
    .from(mintClaims)
    .where(and(eq(mintClaims.playerId, playerId), eq(mintClaims.status, 'issued')))

  const nowSec = Math.floor(Date.now() / 1000)
  const expired = rows.filter((r) => {
    const d = (r.voucher as StoredVoucher | null)?.deadline
    return typeof d === 'number' && d < nowSec
  })
  if (expired.length === 0) return 0

  const claimIds = expired.map((r) => r.id)
  const petIds = expired
    .filter((r) => ((r.voucher as StoredVoucher).petAttrsHash ?? ZERO_HASH) !== ZERO_HASH)
    .map((r) => r.petId)

  if (petIds.length > 0) {
    await db.batch([
      db.update(mintClaims).set({ status: 'expired' }).where(inArray(mintClaims.id, claimIds)),
      db
        .update(pets)
        .set({ status: 'offchain' })
        .where(and(inArray(pets.id, petIds), eq(pets.status, 'claim_pending'))),
    ])
  } else {
    await db.batch([
      db.update(mintClaims).set({ status: 'expired' }).where(inArray(mintClaims.id, claimIds)),
    ])
  }
  return claimIds.length
}
