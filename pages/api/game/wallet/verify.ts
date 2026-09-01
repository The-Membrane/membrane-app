import type { NextApiRequest, NextApiResponse } from 'next'
import { eq, sql } from 'drizzle-orm'
import { verifyMessage } from 'viem'

import { db } from '@/db'
import { byteLedger, energy, mintClaims, pets, players, playerWallets, races } from '@/db/schema'
import { checkRateLimit, getClientIp } from '@/lib/game/rateLimit'
import { buildWalletLinkMessage, requirePlayer, verifyWalletNonce } from '@/lib/game/session'

const RATE_LIMIT = 10
const RATE_WINDOW_SECONDS = 10 * 60

type VerifyBody = {
  address: string
  signature: string
  nonce: string
  merge?: boolean
}

type VerifyResult =
  | {
      linked: true
      address: string
      alreadyLinked?: true
      merged?: true
      mergedFromPlayerId?: string
    }
  | { error: string; mergeable?: true; retryAfterSeconds?: number }

function parseBody(body: unknown): VerifyBody | null {
  if (typeof body !== 'object' || body === null) return null
  const { address, signature, nonce, merge } = body as Record<string, unknown>
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null
  if (typeof signature !== 'string' || signature.length === 0) return null
  if (typeof nonce !== 'string' || nonce.length === 0) return null
  if (merge !== undefined && typeof merge !== 'boolean') return null
  return { address, signature, nonce, merge }
}

/**
 * Moves all game data owned by `sourcePlayerId` onto `targetPlayerId`, then deletes the
 * now-orphaned `players` row. Runs as a single Neon HTTP "batch" — the neon-http Drizzle
 * driver does NOT support `db.transaction()` (interactive transactions require a TCP
 * session; see node_modules/drizzle-orm/neon-http/session.js — it throws "No transactions
 * support in neon-http driver"). `db.batch([...])` is the driver-supported alternative: it
 * forwards every statement to `@neondatabase/serverless`'s `sql.transaction()`, which wraps
 * them all in one real Postgres BEGIN/COMMIT sent as a single non-interactive HTTP round
 * trip — so this is still atomic, it just can't branch on a read made mid-batch. That's why
 * every statement below is unconditional (a no-op UPDATE/DELETE if the source has no rows
 * in that table) rather than "read row, then decide".
 *
 * energy is summed via an upsert (INSERT ... ON CONFLICT) instead of a plain UPDATE because
 * either side (or both) may not have an energy row yet, and batch statements can't branch.
 *
 * mint_claims (Phase 4) is moved to the surviving player BEFORE the source players row is
 * deleted — `mint_claims.player_id` cascades on delete, so an unmoved claim on the orphan
 * would be lost (and with it any in-flight voucher / on-chain BYTE the player could still
 * settle). The move is unconditional (a no-op when the source has no claims), like the others.
 */
async function mergePlayers(
  sourcePlayerId: string,
  targetPlayerId: string,
  newSig: string,
  address: string,
) {
  await db.batch([
    db.update(pets).set({ playerId: targetPlayerId }).where(eq(pets.playerId, sourcePlayerId)),
    db
      .update(byteLedger)
      .set({ playerId: targetPlayerId })
      .where(eq(byteLedger.playerId, sourcePlayerId)),
    db.update(races).set({ playerId: targetPlayerId }).where(eq(races.playerId, sourcePlayerId)),
    // Phase 4: move mint_claims too, BEFORE the source players row is deleted below.
    db
      .update(mintClaims)
      .set({ playerId: targetPlayerId })
      .where(eq(mintClaims.playerId, sourcePlayerId)),
    db
      .update(playerWallets)
      .set({ playerId: targetPlayerId })
      .where(eq(playerWallets.playerId, sourcePlayerId)),
    // Refresh the sig/verifiedAt on the address that was just re-signed, independent of the move above.
    db
      .update(playerWallets)
      .set({ sig: newSig, verifiedAt: new Date() })
      .where(eq(playerWallets.address, address)),
    db.execute(sql`
      insert into energy (player_id, value, updated_at)
      select ${targetPlayerId}::uuid, e.value, now()
      from energy e
      where e.player_id = ${sourcePlayerId}::uuid
      on conflict (player_id) do update set
        value = energy.value + excluded.value,
        updated_at = now()
    `),
    db.execute(sql`delete from energy where player_id = ${sourcePlayerId}::uuid`),
    db.delete(players).where(eq(players.id, sourcePlayerId)),
  ])
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<VerifyResult>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const rateLimit = await checkRateLimit(
    `wallet_verify:${getClientIp(req)}`,
    RATE_LIMIT,
    RATE_WINDOW_SECONDS,
  )
  if (!rateLimit.allowed) {
    return res
      .status(429)
      .json({ error: 'rate_limited', retryAfterSeconds: rateLimit.retryAfterSeconds })
  }

  // Cookie only — the request body's playerId (if any were sent) is never trusted.
  const playerId = await requirePlayer(req, res)
  if (!playerId) return

  const body = parseBody(req.body)
  if (!body) {
    return res.status(400).json({ error: 'invalid_payload' })
  }
  const { address, signature, nonce, merge } = body
  const lowerAddress = address.toLowerCase()

  const nonceCheck = await verifyWalletNonce(nonce, playerId)
  if (!nonceCheck.ok) {
    return res
      .status(400)
      .json({ error: nonceCheck.reason === 'expired' ? 'nonce_expired' : 'invalid_nonce' })
  }

  const message = buildWalletLinkMessage(playerId, nonce)

  let signatureValid: boolean
  try {
    signatureValid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
  } catch {
    signatureValid = false
  }
  if (!signatureValid) {
    return res.status(401).json({ error: 'invalid_signature' })
  }

  const chainId = Number(process.env.NEXT_PUBLIC_EVM_CHAIN_ID)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return res.status(500).json({ error: 'chain_not_configured' })
  }

  try {
    const [existing] = await db
      .select({ playerId: playerWallets.playerId })
      .from(playerWallets)
      .where(eq(playerWallets.address, lowerAddress))
      .limit(1)

    if (!existing) {
      await db.insert(playerWallets).values({
        playerId,
        address: lowerAddress,
        chainId,
        sig: signature,
        verifiedAt: new Date(),
      })
      return res.status(200).json({ linked: true, address: lowerAddress })
    }

    if (existing.playerId === playerId) {
      return res.status(200).json({ linked: true, address: lowerAddress, alreadyLinked: true })
    }

    // Linked to a different player.
    if (!merge) {
      return res.status(409).json({ error: 'wallet_linked_elsewhere', mergeable: true })
    }

    const sourcePlayerId = existing.playerId
    await mergePlayers(sourcePlayerId, playerId, signature, lowerAddress)

    return res.status(200).json({
      linked: true,
      address: lowerAddress,
      merged: true,
      mergedFromPlayerId: sourcePlayerId,
    })
  } catch {
    return res.status(500).json({ error: 'wallet_link_failed' })
  }
}
