// Pet wraps — player-made car wraps for the on-chain Pocket GP game.
//
// The game UI (membrane-solidity/q-racing/ui, served from its own origin with
// no membrane-app session) publishes a wrap here and rivals fetch it back, so:
//   • POST is authenticated by an EIP-191 signature ALONE (no requirePlayer /
//     cookie — cookie-less means no CSRF surface either), verified against the
//     pet's on-chain owner when PGP_NFT_ADDRESS is configured.
//   • GET is public by design — wraps exist to be shown to other players.
//   • CORS is open ('*'): auth rides in the signed body, never in credentials.
//
// The signed message is rebuilt SERVER-SIDE (client only supplies the parts),
// binds the skin bytes via sha256, and carries a timestamp checked to ±10min —
// a replay inside the window can only re-upsert the identical content.
//
// Table applied via manual DDL (indexer_cursor precedent), NOT drizzle-kit push:
//
//   CREATE TABLE IF NOT EXISTS pet_wraps (
//     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
//     chain_id integer NOT NULL,
//     token_id text NOT NULL,
//     owner_address text NOT NULL,
//     skin text NOT NULL,
//     body text, accent text, glow text,
//     updated_at timestamptz NOT NULL DEFAULT now()
//   );
//   CREATE UNIQUE INDEX IF NOT EXISTS pet_wraps_chain_token_idx ON pet_wraps (chain_id, token_id);
//   CREATE INDEX IF NOT EXISTS pet_wraps_owner_idx ON pet_wraps (owner_address);

import { createHash } from 'crypto'

import type { NextApiRequest, NextApiResponse } from 'next'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createPublicClient, http, verifyMessage } from 'viem'

import { db } from '@/db'
import { petWraps } from '@/db/schema'
import { checkRateLimit, getClientIp } from '@/lib/game/rateLimit'

const RATE_LIMIT = 12
const RATE_WINDOW_SECONDS = 10 * 60
const MAX_SKIN_BYTES = 12_000 // dataURL string length; client emits ~2-4KB
const TS_SKEW_MS = 10 * 60 * 1000
const MAX_BATCH = 24

const HEX_COLOR = /^(#[0-9a-fA-F]{6}|rgb\(\d{1,3},\d{1,3},\d{1,3}\))$/

type PublishBody = {
  address: string
  tokenId: string
  skin: string // data:image/jpeg;base64,… or '' to unpublish
  body?: string
  accent?: string
  glow?: string
  ts: number
  signature: string
}

// Rebuilt identically in q-racing/ui/app.js (publishWrap) — keep in sync.
export function buildWrapMessage(
  chainId: number,
  tokenId: string,
  skinSha256Hex: string,
  ts: number,
): string {
  return `Pocket GP wrap for pet #${tokenId} on chain ${chainId}: ${skinSha256Hex} @ ${ts}`
}

function parseBody(body: unknown): PublishBody | null {
  if (typeof body !== 'object' || body === null) return null
  const { address, tokenId, skin, ts, signature } = body as Record<string, unknown>
  const { body: c1, accent: c2, glow: c3 } = body as Record<string, unknown>
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null
  if (typeof tokenId !== 'string' || !/^\d{1,78}$/.test(tokenId)) return null
  if (typeof skin !== 'string' || skin.length > MAX_SKIN_BYTES) return null
  if (skin !== '' && !skin.startsWith('data:image/jpeg;base64,')) return null
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
  if (typeof signature !== 'string' || signature.length === 0) return null
  for (const c of [c1, c2, c3]) {
    if (c !== undefined && (typeof c !== 'string' || !HEX_COLOR.test(c))) return null
  }
  return {
    address,
    tokenId,
    skin,
    ts,
    signature,
    body: c1 as string | undefined,
    accent: c2 as string | undefined,
    glow: c3 as string | undefined,
  }
}

/**
 * When PGP_NFT_ADDRESS is set, the signer must be ownerOf(tokenId) on the pet
 * NFT — the source of truth for who may dress a pet. Unset (early dev, or a
 * pre-NFT deployment) degrades to signature-only: still a real key holder,
 * just not ownership-checked. Never trusts anything client-supplied.
 */
async function verifyOnChainOwner(tokenId: string, address: string): Promise<boolean | null> {
  const nft = process.env.PGP_NFT_ADDRESS
  const rpcUrl = process.env.NEXT_PUBLIC_EVM_RPC_URL
  if (!nft || !/^0x[a-fA-F0-9]{40}$/.test(nft) || !rpcUrl) return null // check not configured
  try {
    const client = createPublicClient({ transport: http(rpcUrl) })
    const owner = (await client.readContract({
      address: nft as `0x${string}`,
      abi: [
        {
          name: 'ownerOf',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'tokenId', type: 'uint256' }],
          outputs: [{ name: '', type: 'address' }],
        },
      ] as const,
      functionName: 'ownerOf',
      args: [BigInt(tokenId)],
    })) as string
    return owner.toLowerCase() === address.toLowerCase()
  } catch {
    return false // token doesn't exist / RPC down → refuse rather than accept blind
  }
}

function setCors(res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const chainId = Number(process.env.NEXT_PUBLIC_EVM_CHAIN_ID)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return res.status(500).json({ error: 'chain_not_configured' })
  }

  // ------------------------------------------------------------- GET (public)
  if (req.method === 'GET') {
    const tokens = typeof req.query.tokens === 'string' ? req.query.tokens.split(',') : []
    const owners =
      typeof req.query.owners === 'string'
        ? req.query.owners.split(',').map((o) => o.toLowerCase())
        : []
    const tokenIds = tokens.filter((t) => /^\d{1,78}$/.test(t)).slice(0, MAX_BATCH)
    const ownerAddrs = owners.filter((o) => /^0x[a-f0-9]{40}$/.test(o)).slice(0, MAX_BATCH)
    if (tokenIds.length === 0 && ownerAddrs.length === 0) {
      return res.status(400).json({ error: 'no_query' })
    }
    try {
      const rows = await db
        .select({
          tokenId: petWraps.tokenId,
          ownerAddress: petWraps.ownerAddress,
          skin: petWraps.skin,
          body: petWraps.body,
          accent: petWraps.accent,
          glow: petWraps.glow,
        })
        .from(petWraps)
        .where(
          and(
            eq(petWraps.chainId, chainId),
            tokenIds.length > 0 && ownerAddrs.length > 0
              ? sql`(${inArray(petWraps.tokenId, tokenIds)} or ${inArray(petWraps.ownerAddress, ownerAddrs)})`
              : tokenIds.length > 0
                ? inArray(petWraps.tokenId, tokenIds)
                : inArray(petWraps.ownerAddress, ownerAddrs),
          ),
        )
        .limit(MAX_BATCH)
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=300')
      return res.status(200).json({ wraps: rows })
    } catch {
      return res.status(500).json({ error: 'wrap_read_failed' })
    }
  }

  // ------------------------------------------------- POST (signature-gated)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const body = parseBody(req.body)
  if (!body) return res.status(400).json({ error: 'invalid_payload' })

  const rateLimit = await checkRateLimit(
    `wrap_publish:${getClientIp(req)}:${body.address.toLowerCase()}`,
    RATE_LIMIT,
    RATE_WINDOW_SECONDS,
  )
  if (!rateLimit.allowed) {
    return res
      .status(429)
      .json({ error: 'rate_limited', retryAfterSeconds: rateLimit.retryAfterSeconds })
  }

  if (Math.abs(Date.now() - body.ts) > TS_SKEW_MS) {
    return res.status(400).json({ error: 'stale_timestamp' })
  }

  const skinHash = createHash('sha256').update(body.skin).digest('hex')
  const message = buildWrapMessage(chainId, body.tokenId, skinHash, body.ts)

  let signatureValid: boolean
  try {
    signatureValid = await verifyMessage({
      address: body.address as `0x${string}`,
      message,
      signature: body.signature as `0x${string}`,
    })
  } catch {
    signatureValid = false
  }
  if (!signatureValid) return res.status(401).json({ error: 'invalid_signature' })

  const ownerOk = await verifyOnChainOwner(body.tokenId, body.address)
  if (ownerOk === false) return res.status(403).json({ error: 'not_pet_owner' })

  const lowerAddress = body.address.toLowerCase()
  try {
    if (body.skin === '') {
      // Unpublish — only the (signature-proven) owner address that published it.
      await db
        .delete(petWraps)
        .where(
          and(
            eq(petWraps.chainId, chainId),
            eq(petWraps.tokenId, body.tokenId),
            eq(petWraps.ownerAddress, lowerAddress),
          ),
        )
      return res.status(200).json({ removed: true })
    }
    await db
      .insert(petWraps)
      .values({
        chainId,
        tokenId: body.tokenId,
        ownerAddress: lowerAddress,
        skin: body.skin,
        body: body.body ?? null,
        accent: body.accent ?? null,
        glow: body.glow ?? null,
      })
      .onConflictDoUpdate({
        target: [petWraps.chainId, petWraps.tokenId],
        set: {
          ownerAddress: lowerAddress,
          skin: body.skin,
          body: body.body ?? null,
          accent: body.accent ?? null,
          glow: body.glow ?? null,
          updatedAt: new Date(),
        },
      })
    return res.status(200).json({ published: true })
  } catch {
    return res.status(500).json({ error: 'wrap_write_failed' })
  }
}
