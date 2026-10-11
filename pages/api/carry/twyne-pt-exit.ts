import { createHash } from 'node:crypto'

import type { NextApiRequest, NextApiResponse } from 'next'
import { createPublicClient, fallback, http, type Address } from 'viem'
import { mainnet } from 'viem/chains'

import {
  readTwynePtExit,
  TWYNE_PT_ROUTE,
  TWYNE_PT_WRAPPER,
  type TwynePtExitRequest,
} from '@/lib/carry/twynePtExit'
import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW = /^[1-9][0-9]{0,77}$/
const MAX_U256 = (1n << 256n) - 1n
const localRates = new Map<string, { startedAt: number; count: number }>()
function checkLocalRateLimit(key: string) {
  const now = Date.now()
  const prior = localRates.get(key)
  if (!prior || now - prior.startedAt >= 60_000) {
    localRates.set(key, { startedAt: now, count: 1 })
    if (localRates.size > 10_000) {
      for (const [candidate, entry] of localRates) {
        if (now - entry.startedAt >= 60_000) localRates.delete(candidate)
      }
      while (localRates.size > 10_000) localRates.delete(localRates.keys().next().value!)
    }
    return true
  }
  prior.count += 1
  return prior.count <= 12
}

export function parseTwynePtExitBody(body: unknown): TwynePtExitRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) => !['routeKey', 'destinationAddress', 'holder', 'assetsRaw', 'chainId'].includes(key),
    ) ||
    (value.chainId !== undefined && value.chainId !== 1) ||
    value.routeKey !== TWYNE_PT_ROUTE ||
    typeof value.destinationAddress !== 'string' ||
    value.destinationAddress.toLowerCase() !== TWYNE_PT_WRAPPER ||
    typeof value.holder !== 'string' ||
    !ADDRESS.test(value.holder) ||
    typeof value.assetsRaw !== 'string' ||
    !RAW.test(value.assetsRaw) ||
    BigInt(value.assetsRaw) > MAX_U256
  )
    return null
  return {
    routeKey: TWYNE_PT_ROUTE,
    destinationAddress: TWYNE_PT_WRAPPER,
    holder: value.holder.toLowerCase() as Address,
    assetsRaw: value.assetsRaw,
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
    // Reject malformed bodies before chain access.
  }
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > 512 ||
    actualLength > 512
  )
    return res.status(413).json({ error: 'request_too_large' })
  const input = parseTwynePtExitBody(req.body)
  if (!input) return res.status(400).json({ error: 'invalid_exit_request' })
  try {
    const key = createHash('sha256')
      .update(req.socket.remoteAddress ?? 'unknown')
      .digest('hex')
      .slice(0, 32)
    const allowed =
      process.env.NODE_ENV === 'production' && process.env.CARRY_FORECAST_STORAGE !== 'local'
        ? await (async () => {
            const { checkRateLimit, getClientIp } = await import('@/lib/game/rateLimit')
            const ipHash = createHash('sha256').update(getClientIp(req)).digest('hex').slice(0, 32)
            return checkRateLimit(`twyne-pt-exit:${ipHash}`, 12, 60)
          })()
        : { allowed: checkLocalRateLimit(key) }
    if (!allowed.allowed) return res.status(429).json({ error: 'rate_limited' })
    const override = process.env.NEXT_PUBLIC_MAINNET_RPC_URL
    const urls = override ? [override, ...PUBLIC_MAINNET_RPCS] : [...PUBLIC_MAINNET_RPCS]
    const client = createPublicClient({
      chain: mainnet,
      transport: fallback(
        urls.slice(0, 6).map((url) => http(url, { timeout: 8_000, retryCount: 0 })),
        { rank: false, retryCount: 0 },
      ),
    })
    return res.status(200).json(await readTwynePtExit(client, input))
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const reason = message.startsWith('twyne_pt_exit_') ? message : 'twyne_pt_exit_read_failed'
    return res.status(503).json({ error: reason })
  }
}
