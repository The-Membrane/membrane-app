import type { NextApiRequest, NextApiResponse } from 'next'

import { enqueue, statusForRequest } from '@/scripts/research/carry-morpho-requested-native.mjs'

export const config = { api: { bodyParser: { sizeLimit: '1kb' } } }

const MAX_BODY_BYTES = 768
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL = /^[1-9][0-9]{0,77}$/
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i
const CLOUD_MARKERS = [
  'VERCEL',
  'VERCEL_ENV',
  'AWS_LAMBDA_FUNCTION_NAME',
  'K_SERVICE',
  'FLY_APP_NAME',
  'RAILWAY_ENVIRONMENT',
  'RENDER',
] as const
const localRates = new Map<string, { start: number; count: number }>()

type WatchRequest = {
  action: 'enqueue' | 'status'
  routeKey: string
  destinationAddress: string
  owner: string
  assetsRaw: string
  horizonHours?: 1 | 24
}

export function parseWatchRequest(body: unknown): WatchRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'action',
          'routeKey',
          'destinationAddress',
          'owner',
          'assetsRaw',
          'horizonHours',
        ].includes(key),
    ) ||
    (value.action !== 'enqueue' && value.action !== 'status') ||
    typeof value.routeKey !== 'string' ||
    !value.routeKey ||
    value.routeKey.length > 160 ||
    typeof value.destinationAddress !== 'string' ||
    !ADDRESS.test(value.destinationAddress) ||
    typeof value.owner !== 'string' ||
    !ADDRESS.test(value.owner) ||
    typeof value.assetsRaw !== 'string' ||
    !DECIMAL.test(value.assetsRaw) ||
    (value.horizonHours !== undefined && value.horizonHours !== 1 && value.horizonHours !== 24)
  )
    return null
  return {
    action: value.action,
    routeKey: value.routeKey,
    destinationAddress: value.destinationAddress.toLowerCase(),
    owner: value.owner.toLowerCase(),
    assetsRaw: value.assetsRaw,
    ...(value.horizonHours === undefined ? {} : { horizonHours: value.horizonHours }),
  }
}

function allowLocalRequest(remote: string) {
  const now = Date.now()
  const prior = localRates.get(remote)
  if (!prior || now - prior.start >= 60_000) {
    localRates.set(remote, { start: now, count: 1 })
    return true
  }
  prior.count++
  return prior.count <= 12
}

function sameDeviceOrigin(req: NextApiRequest) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const url = new URL(origin)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

function localHost(req: NextApiRequest) {
  const host = req.headers.host
  if (typeof host !== 'string' || !LOCAL_HOST.test(host)) return false
  const port = host.match(/:(\d+)$/)?.[1]
  return port === undefined || Number(port) <= 65535
}

function localRuntimeEnabled() {
  if (CLOUD_MARKERS.some((name) => Boolean(process.env[name]))) return false
  return (
    process.env.NODE_ENV === 'development' ||
    process.env.MEMBRANE_LOCAL_HOLDER_WATCH_ENABLED === '1'
  )
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!localRuntimeEnabled()) return res.status(403).json({ error: 'local_only' })
  const remote = req.socket?.remoteAddress ?? ''
  if (!LOOPBACK.has(remote) || !localHost(req) || !sameDeviceOrigin(req))
    return res.status(403).json({ error: 'local_only' })
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'post_only' })
  }
  const declared = Number(req.headers['content-length'] ?? 0)
  let actual = Number.POSITIVE_INFINITY
  try {
    actual = Buffer.byteLength(JSON.stringify(req.body ?? null))
  } catch {
    // Invalid input receives the same bounded-body response.
  }
  if (
    !Number.isSafeInteger(declared) ||
    declared < 0 ||
    declared > MAX_BODY_BYTES ||
    actual > MAX_BODY_BYTES
  )
    return res.status(413).json({ error: 'request_too_large' })
  const input = parseWatchRequest(req.body)
  if (!input) return res.status(400).json({ error: 'invalid_watch_request' })
  if (!allowLocalRequest(remote)) return res.status(429).json({ error: 'rate_limited' })
  const request = {
    routeKey: input.routeKey,
    destinationAddress: input.destinationAddress,
    owner: input.owner,
    assetsRaw: input.assetsRaw,
  }
  try {
    if (input.action === 'enqueue') {
      const result = await enqueue(request)
      return res.status(200).json({ id: result.id, state: result.status, forecastValidated: false })
    }
    const state = await statusForRequest(request)
    return res.status(200).json({
      id: state.id,
      state: state.state,
      horizons:
        input.horizonHours === undefined
          ? state.horizons
          : state.horizons.filter(
              (x: { horizonHours: number }) => x.horizonHours === input.horizonHours,
            ),
      forecastValidated: false,
    })
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (
      /^(requested_holder_request_invalid|requested_holder_subject_unknown|requested_native_request_invalid)$/.test(
        code,
      )
    )
      return res.status(400).json({ error: 'invalid_watch_request' })
    if (
      /^(requested_native_queue_limit|requested_native_issue_limit|requested_native_active_limit)$/.test(
        code,
      )
    )
      return res.status(429).json({ error: 'watch_limit_reached' })
    return res.status(503).json({ error: 'watch_unavailable' })
  }
}
