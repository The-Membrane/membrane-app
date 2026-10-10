import type { NextApiRequest, NextApiResponse } from 'next'
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

import {
  readStakedUsdatQueuePressure,
  type StakedUsdatQueuePressure,
} from '@/lib/carry/stakedUsdatQueuePressure'
import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'

let cached: { at: number; value: StakedUsdatQueuePressure } | null = null
let pending: Promise<StakedUsdatQueuePressure> | null = null

function independentRpcUrls(): string[] {
  const urls = [
    ...String(process.env.RECORDER_RPC_URL ?? '').split(','),
    process.env.NEXT_PUBLIC_MAINNET_RPC_URL ?? '',
    ...PUBLIC_MAINNET_RPCS,
  ]
  const byHost = new Map<string, string>()
  for (const raw of urls) {
    try {
      const url = new URL(raw.trim())
      if (url.protocol !== 'https:') continue
      const host = url.hostname.toLowerCase()
      if (!byHost.has(host)) byHost.set(host, url.toString())
    } catch {
      // Ignore malformed optional RPC configuration.
    }
  }
  return [...byHost.values()].slice(0, 8)
}

async function currentQueuePressure(): Promise<StakedUsdatQueuePressure> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value
  if (pending) return pending
  const urls = independentRpcUrls()
  if (urls.length < 2) throw new Error('independent_rpc_origins_unavailable')
  const clients = urls.map((url) =>
    createPublicClient({
      chain: mainnet,
      transport: http(url, { timeout: 15_000, retryCount: 0 }),
    }),
  )
  pending = (async () => {
    const health = await Promise.allSettled(clients.map((client) => client.getChainId()))
    const healthy = clients.filter((_, index) => {
      const result = health[index]
      return result.status === 'fulfilled' && result.value === 1
    })
    if (healthy.length < 2) throw new Error('independent_rpc_origins_unavailable')
    let attempts = 0
    for (let first = 0; first < healthy.length - 1 && attempts < 6; first++) {
      for (let second = first + 1; second < healthy.length && attempts < 6; second++) {
        attempts++
        try {
          return await readStakedUsdatQueuePressure([healthy[first], healthy[second]])
        } catch {
          // A health check can pass while finalized reads or Multicall are rate limited.
        }
      }
    }
    throw new Error('independent_rpc_queue_read_unavailable')
  })()
  try {
    const value = await pending
    cached = { at: Date.now(), value }
    return value
  } finally {
    pending = null
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  try {
    return res.status(200).json(await currentQueuePressure())
  } catch {
    return res.status(503).json({ error: 'queue_pressure_unavailable' })
  }
}
