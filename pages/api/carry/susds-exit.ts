import { createHash } from 'node:crypto'

import type { NextApiRequest, NextApiResponse } from 'next'
import { createPublicClient, http, type Address } from 'viem'
import { mainnet } from 'viem/chains'

import {
  readSusdsExitQuote,
  resolveSusdsExitTarget,
  type SusdsExitRequest,
} from '@/lib/carry/susdsExitQuote'
import { checkRateLimit, getClientIp } from '@/lib/game/rateLimit'
import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_BODY_BYTES = 512
const MAX_RPC_HOSTS = 2
const RATE_LIMIT = 12
const RATE_WINDOW_SECONDS = 60

function rpcCandidates(): string[] {
  const configured = [
    ...String(process.env.RECORDER_RPC_URL ?? '').split(','),
    process.env.NEXT_PUBLIC_MAINNET_RPC_URL ?? '',
  ]
    .map((url) => url.trim())
    .filter(Boolean)
  return [...new Set([...configured, ...PUBLIC_MAINNET_RPCS])].slice(0, MAX_RPC_HOSTS)
}

function requestBody(body: unknown): SusdsExitRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const fields = Object.keys(body)
  if (
    fields.some(
      (field) =>
        field !== 'routeKey' &&
        field !== 'destinationAddress' &&
        field !== 'owner' &&
        field !== 'assetsRaw' &&
        field !== 'chainId',
    )
  ) {
    return null
  }
  const { routeKey, destinationAddress, owner, assetsRaw, chainId } = body as Record<
    string,
    unknown
  >
  if (
    (chainId !== undefined && chainId !== 1) ||
    typeof routeKey !== 'string' ||
    !routeKey ||
    routeKey.length > 160 ||
    typeof destinationAddress !== 'string' ||
    !ADDRESS.test(destinationAddress) ||
    typeof owner !== 'string' ||
    !ADDRESS.test(owner) ||
    typeof assetsRaw !== 'string' ||
    !RAW_AMOUNT.test(assetsRaw) ||
    BigInt(assetsRaw) > MAX_UINT256
  ) {
    return null
  }
  return {
    routeKey,
    destinationAddress: destinationAddress.toLowerCase() as Address,
    owner: owner.toLowerCase() as Address,
    assetsRaw,
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
    // A malformed body is bounded before any RPC or registry access.
  }
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > MAX_BODY_BYTES ||
    bodyLength > MAX_BODY_BYTES
  ) {
    return res.status(413).json({ error: 'request_too_large' })
  }
  const input = requestBody(req.body)
  if (!input) return res.status(400).json({ error: 'invalid_exit_request' })

  try {
    resolveSusdsExitTarget(input.routeKey, input.destinationAddress)
  } catch (error) {
    if (error instanceof Error && error.message === 'susds_exit_target_unknown') {
      return res.status(404).json({ error: 'unknown_susds_route_destination' })
    }
    return res.status(503).json({ error: 'exit_check_unavailable' })
  }

  try {
    const ipHash = createHash('sha256').update(getClientIp(req)).digest('hex').slice(0, 32)
    const limit = await checkRateLimit(`susds-exit:${ipHash}`, RATE_LIMIT, RATE_WINDOW_SECONDS)
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds))
      return res
        .status(429)
        .json({ error: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds })
    }
  } catch {
    return res.status(503).json({ error: 'exit_check_unavailable' })
  }

  // Keep each attempt on one RPC so block identity and values cannot mix providers.
  for (const url of rpcCandidates()) {
    try {
      const client = createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: 8_000, retryCount: 0 }),
      })
      const reading = await readSusdsExitQuote(client, input)
      return res.status(200).json(reading)
    } catch {
      // Provider errors may include credential-bearing URLs. Never log or return them.
    }
  }
  return res.status(503).json({ error: 'exit_check_unavailable' })
}
