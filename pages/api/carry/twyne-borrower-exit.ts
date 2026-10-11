import { createHash } from 'node:crypto'

import type { NextApiRequest, NextApiResponse } from 'next'
import { createPublicClient, http, type Address } from 'viem'
import { mainnet } from 'viem/chains'

import {
  readTwyneBorrowerExit,
  TWYNE_PT_BORROWER_DEPLOYMENT,
  type TwyneBorrowerExitRequest,
} from '@/lib/carry/twyneBorrowerExit'
import { TWYNE_PT_ROUTE } from '@/lib/carry/twynePtExit'
import { checkRateLimit, getClientIp, type RateLimitResult } from '@/lib/game/rateLimit'
import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
// The frozen August route cohort records these Twyne CVs as `owner`.
const FROZEN_COLLATERAL_VAULTS = new Set([
  '0x259b9f78382febfb76d02d6243ee4f12af7f0c37',
  '0x288b523115e674fa1ac1c2315ae2874065ee7699',
  '0x2cc58a703ad070f6668abaaa19411e0f4ad544b0',
  '0x3db976e1a0beed360a5726bcde9c6d9e17067e06',
  '0x3f937b0a560ebf4621d736fe32b1525940bbfdb0',
  '0x47e2daf6cdda5a164d335985f1cc2731e6c5d53e',
  '0x70162c6c8fe764c2be751a39ea69d4335c4bb8cd',
  '0x78a06d662ba80b94b2462a5cbe04dd234ac5a119',
  '0x8336afcd93fb330650999e45e432a6a4c949850c',
  '0x948eda8a21f16dc7cbbf63d96ffe038866192ad7',
  '0xa732374d0d959085c8eb581fa6abc4064b4c6ab1',
  '0xaea34a8690a5f38ba864ceb461f1f78b971db577',
  '0xbcd26a5819561efa80652b1a02863eb08fa156d8',
  '0xd91c40fe9007083e26768f012f6074090cf44c6a',
  '0xf3ccafb91013e3b6005b3ff0df8bc417bacf7d46',
  '0xf4c8687cbbb2a55657a4cf955df2dd91637ef217',
])

const MAX_BODY_BYTES = 512
const MAX_RPC_HOSTS = 2
const RATE_LIMIT = 12
const RATE_WINDOW_SECONDS = 60
const LOCAL_LIMIT_MAX_CALLERS = 256
const localLimitWindows = new Map<string, { startedAt: number; count: number }>()

function localDevelopmentRateLimit(req: NextApiRequest): RateLimitResult | null {
  const remoteAddress = req.socket?.remoteAddress
  if (
    process.env.NODE_ENV !== 'development' ||
    (remoteAddress !== '127.0.0.1' &&
      remoteAddress !== '::1' &&
      remoteAddress !== '::ffff:127.0.0.1')
  ) {
    return null
  }

  const key = createHash('sha256').update(remoteAddress).digest('hex').slice(0, 32)
  const now = Date.now()
  const windowMs = RATE_WINDOW_SECONDS * 1_000
  let window = localLimitWindows.get(key)
  if (!window || now - window.startedAt >= windowMs) {
    if (!window && localLimitWindows.size >= LOCAL_LIMIT_MAX_CALLERS) {
      for (const [candidate, value] of localLimitWindows) {
        if (now - value.startedAt >= windowMs) localLimitWindows.delete(candidate)
      }
    }
    if (!window && localLimitWindows.size >= LOCAL_LIMIT_MAX_CALLERS) {
      return { allowed: false, retryAfterSeconds: RATE_WINDOW_SECONDS }
    }
    window = { startedAt: now, count: 0 }
    localLimitWindows.set(key, window)
  }
  window.count += 1
  if (window.count > RATE_LIMIT) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1_000)),
    }
  }
  return { allowed: true }
}

function rpcCandidates(): string[] {
  const configured = [
    ...String(process.env.RECORDER_RPC_URL ?? '').split(','),
    process.env.NEXT_PUBLIC_MAINNET_RPC_URL ?? '',
  ]
    .map((url) => url.trim())
    .filter(Boolean)
  return [...new Set([...configured, ...PUBLIC_MAINNET_RPCS])].slice(0, MAX_RPC_HOSTS)
}

export function parseTwyneBorrowerExitBody(body: unknown): TwyneBorrowerExitRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) => !['routeKey', 'collateralVault', 'requestedPtRaw', 'chainId'].includes(key),
    ) ||
    (value.chainId !== undefined && value.chainId !== 1) ||
    value.routeKey !== TWYNE_PT_ROUTE ||
    typeof value.collateralVault !== 'string' ||
    !ADDRESS.test(value.collateralVault) ||
    !FROZEN_COLLATERAL_VAULTS.has(value.collateralVault.toLowerCase()) ||
    typeof value.requestedPtRaw !== 'string' ||
    !RAW_AMOUNT.test(value.requestedPtRaw) ||
    BigInt(value.requestedPtRaw) > MAX_UINT256
  ) {
    return null
  }
  return {
    routeKey: TWYNE_PT_ROUTE,
    collateralVault: value.collateralVault.toLowerCase() as Address,
    requestedPtRaw: value.requestedPtRaw,
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const declaredLength = Number(req.headers['content-length'] ?? 0)
  let bodyLength = Number.POSITIVE_INFINITY
  try {
    bodyLength = Buffer.byteLength(JSON.stringify(req.body ?? null))
  } catch {
    // Reject malformed bodies before chain access.
  }
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > MAX_BODY_BYTES ||
    bodyLength > MAX_BODY_BYTES
  ) {
    return res.status(413).json({ error: 'request_too_large' })
  }
  const input = parseTwyneBorrowerExitBody(req.body)
  if (!input) return res.status(400).json({ error: 'invalid_exit_request' })

  try {
    const ipHash = createHash('sha256').update(getClientIp(req)).digest('hex').slice(0, 32)
    const limit = await checkRateLimit(
      `twyne-borrower-exit:${ipHash}`,
      RATE_LIMIT,
      RATE_WINDOW_SECONDS,
    )
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      return res
        .status(429)
        .json({ error: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds })
    }
  } catch {
    const limit = localDevelopmentRateLimit(req)
    if (!limit) return res.status(503).json({ error: 'exit_check_unavailable' })
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      return res
        .status(429)
        .json({ error: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds })
    }
  }

  // Keep every pinned read on one origin. A failed origin contributes no partial data.
  for (const url of rpcCandidates()) {
    try {
      const client = createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 8_000, retryCount: 0 }),
      })
      const reading = await readTwyneBorrowerExit(client, input, TWYNE_PT_BORROWER_DEPLOYMENT)
      return res.status(200).json({
        ...reading,
        scope: {
          simulatedPtFirstLegOnly: true,
          borrowerKeyControl: 'unassessed',
          finalUsdePayout: 'unassessed',
        },
      })
    } catch {
      // Provider errors may contain credential-bearing URLs. Never log or return them.
    }
  }
  return res.status(503).json({ error: 'exit_check_unavailable' })
}
