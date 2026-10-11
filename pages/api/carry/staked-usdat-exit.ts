import { createHash } from 'node:crypto'

import type { NextApiRequest, NextApiResponse } from 'next'
import { createPublicClient, http, type Address } from 'viem'
import { mainnet } from 'viem/chains'

import {
  readStakedUsdatExit,
  STAKED_USDAT_ROUTE,
  STAKED_USDAT_VAULT,
  type StakedUsdatExitRequest,
} from '@/lib/carry/stakedUsdatExit'
import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW = /^[1-9][0-9]{0,77}$/
const TOKEN_ID = /^(0|[1-9][0-9]{0,77})$/
const MAX_U256 = (1n << 256n) - 1n
const localRates = new Map<string, { startedAt: number; count: number }>()

export function stakedUsdatRequestBody(body: unknown): StakedUsdatExitRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const fields = Object.keys(body)
  if (
    fields.some(
      (field) =>
        ![
          'routeKey',
          'destinationAddress',
          'holder',
          'sharesRaw',
          'requestTokenId',
          'chainId',
        ].includes(field),
    )
  )
    return null
  const { routeKey, destinationAddress, holder, sharesRaw, requestTokenId, chainId } =
    body as Record<string, unknown>
  if (
    routeKey !== STAKED_USDAT_ROUTE ||
    typeof destinationAddress !== 'string' ||
    destinationAddress.toLowerCase() !== STAKED_USDAT_VAULT ||
    typeof holder !== 'string' ||
    !ADDRESS.test(holder) ||
    typeof sharesRaw !== 'string' ||
    !RAW.test(sharesRaw) ||
    BigInt(sharesRaw) > MAX_U256 ||
    (requestTokenId !== undefined &&
      (typeof requestTokenId !== 'string' ||
        !TOKEN_ID.test(requestTokenId) ||
        BigInt(requestTokenId) > MAX_U256)) ||
    (chainId !== undefined && chainId !== 1)
  )
    return null
  return {
    routeKey,
    destinationAddress: STAKED_USDAT_VAULT,
    holder: holder.toLowerCase() as Address,
    sharesRaw,
    ...(requestTokenId === undefined ? {} : { requestTokenId }),
  }
}

function localLimit(
  key: string,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now()
  const previous = localRates.get(key)
  if (!previous || now - previous.startedAt >= 60_000) {
    localRates.set(key, { startedAt: now, count: 1 })
    if (localRates.size > 10_000) {
      for (const [candidate, value] of localRates) {
        if (now - value.startedAt >= 60_000) localRates.delete(candidate)
      }
      while (localRates.size > 10_000) {
        const oldest = localRates.keys().next().value
        if (!oldest) break
        localRates.delete(oldest)
      }
    }
    return { allowed: true }
  }
  previous.count += 1
  return previous.count <= 12
    ? { allowed: true }
    : {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - previous.startedAt)) / 1000)),
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
    // Reject malformed input without reaching public RPCs.
  }
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > 512 ||
    bodyLength > 512
  )
    return res.status(413).json({ error: 'request_too_large' })
  const input = stakedUsdatRequestBody(req.body)
  if (!input) return res.status(400).json({ error: 'invalid_exit_request' })

  try {
    const key = createHash('sha256')
      .update(req.socket?.remoteAddress ?? 'unknown')
      .digest('hex')
      .slice(0, 32)
    const limit =
      process.env.NODE_ENV === 'production' && process.env.CARRY_FORECAST_STORAGE !== 'local'
        ? await (async () => {
            const { checkRateLimit, getClientIp } = await import('@/lib/game/rateLimit')
            const ipHash = createHash('sha256').update(getClientIp(req)).digest('hex').slice(0, 32)
            return checkRateLimit(`staked-usdat-exit:${ipHash}`, 12, 60)
          })()
        : localLimit(key)
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      return res
        .status(429)
        .json({ error: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds })
    }
  } catch {
    return res.status(503).json({ error: 'exit_check_unavailable' })
  }

  const urls = [
    ...new Set(
      [
        ...String(process.env.RECORDER_RPC_URL ?? '').split(','),
        process.env.NEXT_PUBLIC_MAINNET_RPC_URL ?? '',
        ...PUBLIC_MAINNET_RPCS,
      ]
        .map((url) => url.trim())
        .filter(Boolean),
    ),
  ].slice(0, 4)
  for (const url of urls) {
    try {
      const client = createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 8_000, retryCount: 0 }),
      })
      const result = await readStakedUsdatExit(client, input)
      return res.status(200).json(result)
    } catch {
      // Never return configured RPC URLs, errors, or holder information.
    }
  }
  return res.status(503).json({ error: 'exit_check_unavailable' })
}
