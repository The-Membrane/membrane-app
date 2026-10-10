import { createHash } from 'node:crypto'

import type { NextApiRequest, NextApiResponse } from 'next'
import { createPublicClient, http, type Address } from 'viem'
import { mainnet } from 'viem/chains'

import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'
import { readSghoExit } from '@/lib/carry/sghoExit'
import { checkRateLimit, getClientIp, type RateLimitResult } from '@/lib/game/rateLimit'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_BODY_BYTES = 256
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

  // The socket address is controlled by the connection, unlike x-forwarded-for.
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

function requestInput(body: unknown): { owner: Address; assetsRaw: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const fields = Object.keys(body)
  if (fields.some((field) => field !== 'address' && field !== 'assetsRaw' && field !== 'chainId'))
    return null
  const { address, assetsRaw, chainId } = body as Record<string, unknown>
  if (chainId !== undefined && chainId !== 1) return null
  if (typeof address !== 'string' || !ADDRESS.test(address)) return null
  if (
    typeof assetsRaw !== 'string' ||
    !RAW_AMOUNT.test(assetsRaw) ||
    BigInt(assetsRaw) > MAX_UINT256
  )
    return null
  return { owner: address.toLowerCase() as Address, assetsRaw }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const declaredLength = Number(req.headers['content-length'] ?? 0)
  if (declaredLength > MAX_BODY_BYTES || JSON.stringify(req.body ?? null).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'request_too_large' })
  }
  const input = requestInput(req.body)
  if (!input) return res.status(400).json({ error: 'invalid_exit_request' })

  try {
    // Persist only a fixed-window hash of the caller IP, never the wallet address.
    const ipHash = createHash('sha256').update(getClientIp(req)).digest('hex').slice(0, 32)
    const limit = await checkRateLimit(`sgho-exit:${ipHash}`, RATE_LIMIT, RATE_WINDOW_SECONDS)
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

  // A whole reading stays on one RPC host. A failed host never contributes
  // partial wallet values to another host's finalized block.
  for (const url of rpcCandidates()) {
    try {
      const client = createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 6_000, retryCount: 0 }),
      })
      const reading = await readSghoExit(client, input.owner, input.assetsRaw)
      return res.status(200).json(reading)
    } catch {
      // Provider errors may contain credential-bearing URLs. Never log or return them.
    }
  }
  return res.status(503).json({ error: 'exit_check_unavailable' })
}
