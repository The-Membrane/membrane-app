// POST /api/mint/confirm — verify a claim() tx receipt on-chain, then settle the claim.
//
// The chain is the source of truth: we only credit/settle after viem confirms the receipt
// succeeded, touched the MintClaim contract, and emitted a Claimed event whose nonce matches
// the issued claim. On success: claim → minted, pet → minted (token_id), and a NEGATIVE
// byte_ledger 'mint_debit' row records that the offchain BYTE was moved on-chain.

import type { NextApiRequest, NextApiResponse } from 'next'
import { and, eq } from 'drizzle-orm'
import { createPublicClient, http, parseEventLogs } from 'viem'

import { db } from '@/db'
import { byteLedger, mintClaims, pets } from '@/db/schema'
import { requirePlayer } from '@/lib/game/session'
import { DEFAULT_EVM_CHAIN } from '@/config/evm/chains'
import { getContractAddress } from '@/config/evm/contracts'
import { mintClaimAbi } from '@/lib/mint/abi'
import { ZERO_HASH } from '@/lib/mint/eip712'
import type { StoredVoucher } from '@/lib/mint/claims'

type ConfirmResult =
  | {
      status: 'minted'
      tokenId: string | null
      byteMinted: string
      mintTx: `0x${string}`
      alreadyConfirmed?: true
    }
  | { error: string }

function parseBody(body: unknown): { claimId: string; txHash: `0x${string}` } | null {
  if (typeof body !== 'object' || body === null) return null
  const { claimId, txHash } = body as Record<string, unknown>
  if (typeof claimId !== 'string' || claimId.length === 0) return null
  if (typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) return null
  return { claimId, txHash: txHash as `0x${string}` }
}

function isZeroAddress(addr: string | undefined): boolean {
  return !addr || /^0x0{40}$/i.test(addr)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ConfirmResult>) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const playerId = await requirePlayer(req, res)
  if (!playerId) return

  const body = parseBody(req.body)
  if (!body) {
    return res.status(400).json({ error: 'invalid_payload' })
  }
  const { claimId, txHash } = body

  const chainId = DEFAULT_EVM_CHAIN.id
  const mintClaimAddress = getContractAddress(chainId, 'qracingMintClaim')
  if (isZeroAddress(mintClaimAddress)) {
    return res.status(500).json({ error: 'mint_not_configured' })
  }
  const mintClaimLc = (mintClaimAddress as string).toLowerCase()

  try {
    const [claim] = await db
      .select()
      .from(mintClaims)
      .where(eq(mintClaims.id, claimId))
      .limit(1)

    if (!claim || claim.playerId !== playerId) {
      return res.status(404).json({ error: 'claim_not_found' })
    }

    // Idempotent replay: already settled — echo the result, never re-credit.
    if (claim.status === 'minted') {
      const [pet] = claim.petId
        ? await db.select({ tokenId: pets.tokenId }).from(pets).where(eq(pets.id, claim.petId)).limit(1)
        : [{ tokenId: null as string | null }]
      return res.status(200).json({
        status: 'minted',
        tokenId: pet?.tokenId ?? null,
        byteMinted: claim.byteAmount.toString(),
        mintTx: (claim.mintTx ?? txHash) as `0x${string}`,
        alreadyConfirmed: true,
      })
    }

    if (claim.status !== 'issued') {
      return res.status(409).json({ error: 'claim_not_open' })
    }

    // Verify the receipt on-chain. NEXT_PUBLIC_EVM_RPC_URL undefined => chain default (loopback).
    const publicClient = createPublicClient({
      chain: DEFAULT_EVM_CHAIN,
      transport: http(process.env.NEXT_PUBLIC_EVM_RPC_URL),
    })

    let receipt
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: txHash })
    } catch {
      return res.status(400).json({ error: 'receipt_not_found' })
    }

    if (receipt.status !== 'success') {
      return res.status(400).json({ error: 'tx_reverted' })
    }

    // The tx must have hit the MintClaim contract (as target or via one of its logs).
    const touchedMintClaim =
      receipt.to?.toLowerCase() === mintClaimLc ||
      receipt.logs.some((l) => l.address.toLowerCase() === mintClaimLc)
    if (!touchedMintClaim) {
      return res.status(400).json({ error: 'wrong_contract' })
    }

    // Parse the Claimed event and match it to THIS claim by nonce.
    const events = parseEventLogs({
      abi: mintClaimAbi,
      logs: receipt.logs,
      eventName: 'Claimed',
    })
    const expectedNonce = BigInt(claim.nonce)
    // Match by nonce AND require the event to originate from the real MintClaim contract, so a
    // same-signature event spoofed by another contract in the same tx can't settle the claim.
    const event = events.find(
      (e) => e.args.nonce === expectedNonce && e.address.toLowerCase() === mintClaimLc,
    )
    if (!event) {
      return res.status(400).json({ error: 'claim_event_mismatch' })
    }
    // Defensive: the minted BYTE must equal what we signed into the voucher.
    if (event.args.byteAmount !== claim.byteAmount) {
      return res.status(400).json({ error: 'byte_amount_mismatch' })
    }

    const voucher = claim.voucher as StoredVoucher
    const isPetClaim = voucher.petAttrsHash !== ZERO_HASH
    const tokenId = event.args.tokenId.toString()

    type Stmt = Parameters<typeof db.batch>[0][number]
    const stmts: Stmt[] = [
      db.update(mintClaims).set({ status: 'minted', mintTx: txHash }).where(eq(mintClaims.id, claim.id)),
    ]
    if (isPetClaim && claim.petId) {
      stmts.push(
        db
          .update(pets)
          .set({ status: 'minted', tokenId, mintTx: txHash })
          .where(and(eq(pets.id, claim.petId), eq(pets.status, 'claim_pending'))),
      )
    }
    if (claim.byteAmount !== 0n) {
      stmts.push(
        db.insert(byteLedger).values({
          playerId,
          delta: -claim.byteAmount,
          reason: 'mint_debit',
        }),
      )
    }
    await db.batch(stmts as [Stmt, ...Stmt[]])

    return res.status(200).json({
      status: 'minted',
      tokenId: isPetClaim ? tokenId : null,
      byteMinted: claim.byteAmount.toString(),
      mintTx: txHash,
    })
  } catch {
    return res.status(500).json({ error: 'confirm_failed' })
  }
}
