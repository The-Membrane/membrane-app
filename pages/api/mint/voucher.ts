// POST /api/mint/voucher — issue an EIP-712 mint voucher (Phase 4).
//
// Trust model: the server, never the client, decides byteAmount (BYTE becomes on-chain money
// at mint). voucher.to is bound to the player's VERIFIED linked wallet, not to anything in the
// request body. Nonces are single-use (unique index) so a voucher can never be replayed.

import type { NextApiRequest, NextApiResponse } from 'next'
import { randomBytes } from 'node:crypto'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { getAddress } from 'viem'

import { db } from '@/db'
import { mintClaims, pets, playerWallets } from '@/db/schema'
import { requirePlayer } from '@/lib/game/session'
import { DEFAULT_EVM_CHAIN } from '@/config/evm/chains'
import { getContractAddress } from '@/config/evm/contracts'
import { petAttrsHash, signVoucher, ZERO_HASH, type Voucher } from '@/lib/mint/eip712'
import {
  claimableByteAmount,
  expireStaleClaims,
  voucherKind,
  VOUCHER_TTL_SECONDS,
  type StoredVoucher,
} from '@/lib/mint/claims'

const MINT_FEE_NOTE =
  'The CDT mint fee is charged on-chain at claim time (read MintClaim.mintFee()). Approve the ' +
  'MintClaim contract for at least mintFee CDT — or swap USDC/ETH to CDT first — before claim().'

type Kind = 'pet_and_byte' | 'byte_only'

type PublicVoucher = {
  to: `0x${string}`
  petAttrsHash: `0x${string}`
  byteAmount: string
  nonce: string
  deadline: string
}

type VoucherResult =
  | {
      claimId: string
      kind: Kind
      voucher: PublicVoucher
      signature: `0x${string}`
      mintFeeNote: string
      idempotent?: true
    }
  | { error: string }

function parseKind(body: unknown): Kind | null {
  if (typeof body !== 'object' || body === null) return null
  const { kind } = body as Record<string, unknown>
  return kind === 'pet_and_byte' || kind === 'byte_only' ? kind : null
}

function isZeroAddress(addr: string | undefined): boolean {
  return !addr || /^0x0{40}$/i.test(addr)
}

function toPublicVoucher(v: StoredVoucher): PublicVoucher {
  return {
    to: v.to,
    petAttrsHash: v.petAttrsHash,
    byteAmount: v.byteAmount,
    nonce: v.nonce,
    deadline: String(v.deadline),
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<VoucherResult>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const playerId = await requirePlayer(req, res)
  if (!playerId) return

  const kind = parseKind(req.body)
  if (!kind) {
    return res.status(400).json({ error: 'invalid_kind' })
  }

  const chainId = DEFAULT_EVM_CHAIN.id
  const mintClaimAddress = getContractAddress(chainId, 'qracingMintClaim')
  if (isZeroAddress(mintClaimAddress)) {
    return res.status(500).json({ error: 'mint_not_configured' })
  }
  const verifyingContract = mintClaimAddress as `0x${string}`

  try {
    // Voucher.to must be a VERIFIED linked wallet (players can play with no wallet, but not mint).
    const [wallet] = await db
      .select({ address: playerWallets.address })
      .from(playerWallets)
      .where(and(eq(playerWallets.playerId, playerId), isNotNull(playerWallets.verifiedAt)))
      .orderBy(desc(playerWallets.verifiedAt))
      .limit(1)

    if (!wallet) {
      return res.status(403).json({ error: 'no_verified_wallet' })
    }
    const to = getAddress(wallet.address)

    // Housekeeping first: retire this player's expired issued claims (returns pets to offchain).
    await expireStaleClaims(playerId)

    // Idempotency: reuse an unexpired 'issued' claim of the SAME kind instead of burning a nonce.
    const issued = await db
      .select({ id: mintClaims.id, voucher: mintClaims.voucher })
      .from(mintClaims)
      .where(and(eq(mintClaims.playerId, playerId), eq(mintClaims.status, 'issued')))
    const existing = issued.find(
      (c) => voucherKind((c.voucher as StoredVoucher).petAttrsHash) === kind,
    )
    if (existing) {
      const v = existing.voucher as StoredVoucher
      return res.status(200).json({
        claimId: existing.id,
        kind,
        voucher: toPublicVoucher(v),
        signature: v.signature,
        mintFeeNote: MINT_FEE_NOTE,
        idempotent: true,
      })
    }

    // byteAmount is net of any other in-flight (issued/fee_paid) claims — never client-supplied.
    const byteAmount = await claimableByteAmount(playerId)

    let petId: string
    let hash: `0x${string}`

    if (kind === 'pet_and_byte') {
      const [pet] = await db
        .select({ id: pets.id, attributes: pets.attributes })
        .from(pets)
        .where(and(eq(pets.playerId, playerId), eq(pets.status, 'offchain')))
        .limit(1)
      if (!pet) {
        return res.status(409).json({ error: 'no_offchain_pet' })
      }
      petId = pet.id
      // Hash the stored jsonb value (canonical, Postgres-normalized). See eip712.petAttrsHash.
      hash = petAttrsHash(pet.attributes)
    } else {
      // byte_only: the pet must already be minted; this claim mints BYTE only (petAttrsHash=0).
      const [pet] = await db
        .select({ id: pets.id })
        .from(pets)
        .where(and(eq(pets.playerId, playerId), eq(pets.status, 'minted')))
        .orderBy(desc(pets.createdAt))
        .limit(1)
      if (!pet) {
        return res.status(409).json({ error: 'no_minted_pet' })
      }
      petId = pet.id
      hash = ZERO_HASH
      if (byteAmount <= 0n) {
        return res.status(409).json({ error: 'no_byte_to_claim' })
      }
    }

    const nowSec = Math.floor(Date.now() / 1000)
    const deadline = nowSec + VOUCHER_TTL_SECONDS
    const nonce = BigInt(`0x${randomBytes(16).toString('hex')}`) // 128-bit

    const voucher: Voucher = {
      to,
      petAttrsHash: hash,
      byteAmount,
      nonce,
      deadline: BigInt(deadline),
    }
    const signature = await signVoucher(voucher, chainId, verifyingContract)

    const stored: StoredVoucher = {
      to,
      petAttrsHash: hash,
      byteAmount: byteAmount.toString(),
      nonce: nonce.toString(),
      deadline,
      signature,
    }

    // Atomic: insert the claim (+ park the pet at claim_pending for pet claims).
    let claimId: string
    if (kind === 'pet_and_byte') {
      const [insertRes] = await db.batch([
        db
          .insert(mintClaims)
          .values({
            playerId,
            petId,
            byteAmount,
            nonce: nonce.toString(),
            voucher: stored,
            status: 'issued',
          })
          .returning({ id: mintClaims.id }),
        db
          .update(pets)
          .set({ status: 'claim_pending' })
          .where(and(eq(pets.id, petId), eq(pets.status, 'offchain'))),
      ])
      claimId = insertRes[0].id
    } else {
      const [insertRes] = await db.batch([
        db
          .insert(mintClaims)
          .values({
            playerId,
            petId,
            byteAmount,
            nonce: nonce.toString(),
            voucher: stored,
            status: 'issued',
          })
          .returning({ id: mintClaims.id }),
      ])
      claimId = insertRes[0].id
    }

    return res.status(200).json({
      claimId,
      kind,
      voucher: toPublicVoucher(stored),
      signature,
      mintFeeNote: MINT_FEE_NOTE,
    })
  } catch {
    return res.status(500).json({ error: 'voucher_issue_failed' })
  }
}
