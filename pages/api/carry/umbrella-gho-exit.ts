import { createHash } from 'node:crypto'

import type { NextApiRequest, NextApiResponse } from 'next'
import { createPublicClient, http, type Address } from 'viem'
import { mainnet } from 'viem/chains'

import {
  readUmbrellaGhoExit,
  UMBRELLA_GHO_ROUTE,
  UMBRELLA_STKGHO,
  type UmbrellaGhoExitRequest,
} from '@/lib/carry/umbrellaGhoExit'
import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
const LOCAL_RATE_LIMIT = 12
const LOCAL_WINDOW_MS = 60_000
const localRates = new Map<string, { startedAt: number; count: number }>()

function checkLocalRateLimit(
  key: string,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now()
  const prior = localRates.get(key)
  if (!prior || now - prior.startedAt >= LOCAL_WINDOW_MS) {
    localRates.set(key, { startedAt: now, count: 1 })
    if (localRates.size > 10_000) {
      for (const [candidate, entry] of localRates) {
        if (now - entry.startedAt >= LOCAL_WINDOW_MS) localRates.delete(candidate)
      }
      while (localRates.size > 10_000) {
        const oldest = localRates.keys().next().value
        if (!oldest) break
        localRates.delete(oldest)
      }
    }
    return { allowed: true }
  }
  prior.count += 1
  return prior.count <= LOCAL_RATE_LIMIT
    ? { allowed: true }
    : {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((LOCAL_WINDOW_MS - (now - prior.startedAt)) / 1000),
        ),
      }
}
function requestBody(body: unknown): UmbrellaGhoExitRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const fields = Object.keys(body)
  if (
    fields.some(
      (field) =>
        !['routeKey', 'destinationAddress', 'holder', 'assetsRaw', 'sharesRaw', 'chainId'].includes(
          field,
        ),
    )
  )
    return null
  const { routeKey, destinationAddress, holder, assetsRaw, sharesRaw, chainId } = body as Record<
    string,
    unknown
  >
  if (chainId !== undefined && chainId !== 1) return null
  if (
    routeKey !== UMBRELLA_GHO_ROUTE ||
    typeof destinationAddress !== 'string' ||
    destinationAddress.toLowerCase() !== UMBRELLA_STKGHO ||
    typeof holder !== 'string' ||
    !ADDRESS.test(holder)
  )
    return null
  if ((assetsRaw === undefined) === (sharesRaw === undefined)) return null
  const amount = assetsRaw ?? sharesRaw
  if (typeof amount !== 'string' || !RAW_AMOUNT.test(amount) || BigInt(amount) > MAX_UINT256)
    return null
  return {
    routeKey,
    destinationAddress: UMBRELLA_STKGHO,
    holder: holder.toLowerCase() as Address,
    ...(assetsRaw !== undefined ? { assetsRaw: amount } : { sharesRaw: amount }),
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const declaredLength = Number(req.headers['content-length'] ?? 0)
  let actualLength = Number.POSITIVE_INFINITY
  try {
    actualLength = Buffer.byteLength(JSON.stringify(req.body ?? null))
  } catch {
    // Reject malformed input before RPC access.
  }
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > 512 ||
    actualLength > 512
  ) {
    return res.status(413).json({ error: 'request_too_large' })
  }
  const input = requestBody(req.body)
  if (!input) return res.status(400).json({ error: 'invalid_exit_request' })
  try {
    // The explicit local-storage mode runs on one Mac process even with a production build.
    // Distributed production keeps the atomic DB limit.
    const limit =
      process.env.NODE_ENV === 'production' && process.env.CARRY_FORECAST_STORAGE !== 'local'
        ? await (async () => {
            const { checkRateLimit, getClientIp } = await import('@/lib/game/rateLimit')
            const ipHash = createHash('sha256').update(getClientIp(req)).digest('hex').slice(0, 32)
            return checkRateLimit(`umbrella-gho-exit:${ipHash}`, 12, 60)
          })()
        : checkLocalRateLimit(
            createHash('sha256')
              .update(req.socket?.remoteAddress ?? 'unknown')
              .digest('hex')
              .slice(0, 32),
          )
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
  ].slice(0, 2)
  for (const url of urls) {
    try {
      const client = createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 8_000, retryCount: 0 }),
      })
      const result = await readUmbrellaGhoExit(client, input)
      return res.status(200).json(result)
    } catch {
      // Provider errors may contain credentials; never return them.
    }
  }
  return res.status(503).json({ error: 'exit_check_unavailable' })
}
