import type { NextApiRequest, NextApiResponse } from 'next'

import {
  observeApyUsdOpenReceiptCurrent,
  type ApyUsdOpenReceiptObservation,
} from '@/lib/carry/observeApyUsdOpenReceiptCurrent'

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
const SOURCE_HOSTS = ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'] as const
const CACHE_MS = 30_000
const MAX_BLOCK_AGE_MS = 45 * 60_000
const MAX_FUTURE_SKEW_MS = 120_000
const HEX_HASH = /^0x[0-9a-f]{64}$/
const POSITIVE_RAW = /^[1-9][0-9]*$/

type Summary = {
  status: 'fresh'
  scope: 'historical_open_receipts'
  prospectiveQForecast: false
  block: { number: number; hash: string; timestamp: number }
  observedAtUtc: string
  openReceiptCount: number
  noCurrentOwnerCount: number
  holderChangedCount: number
  claimSimulationPassCount: number
  fullEscrowSimulationCount: number
  noCodeHolderCount: number
  delegatedEoaHolderCount: number
  contractHolderCount: number
  sourceHosts: typeof SOURCE_HOSTS
}

let cache: { summary: Summary; until: number } | null = null
let loading: Promise<Summary> | null = null

function isLocalDevelopment(req: NextApiRequest): boolean {
  if (process.env.NODE_ENV !== 'development' || CLOUD_MARKERS.some((name) => process.env[name]))
    return false
  if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) return false
  const host = req.headers.host
  if (typeof host !== 'string' || !LOCAL_HOST.test(host)) return false
  const port = host.match(/:(\d+)$/)?.[1]
  if (port && Number(port) > 65535) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const url = new URL(origin)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.host.toLowerCase() === host.toLowerCase()
    )
  } catch {
    return false
  }
}

function freshBlock(block: Summary['block'], now: number): boolean {
  const age = now - block.timestamp * 1000
  return age >= -MAX_FUTURE_SKEW_MS && age <= MAX_BLOCK_AGE_MS
}

function summarize(row: ApyUsdOpenReceiptObservation, now: number): Summary {
  if (
    !row ||
    row.observationStatus !== 'unsealed' ||
    row.scope !== 'current_status_of_frozen_historical_open_receipts' ||
    row.prospectiveQForecast !== false ||
    row.holderCodeChecked !== true ||
    JSON.stringify(row.origins) !== JSON.stringify(SOURCE_HOSTS) ||
    !Number.isSafeInteger(row.block?.number) ||
    row.block.number < 0 ||
    !Number.isSafeInteger(row.block?.timestamp) ||
    !HEX_HASH.test(row.block.hash) ||
    !freshBlock(row.block, now) ||
    !Array.isArray(row.subjects) ||
    row.subjects.length !== 7 ||
    !Array.isArray(row.proofs) ||
    row.proofs.length !== 7
  )
    throw Error('invalid_observation')

  const observedAt = Date.parse(row.observedAtUtc)
  if (
    !Number.isSafeInteger(observedAt) ||
    new Date(observedAt).toISOString() !== row.observedAtUtc ||
    observedAt - now > MAX_FUTURE_SKEW_MS ||
    now - observedAt > CACHE_MS
  )
    throw Error('stale_observation')

  const ids = new Set<string>()
  let openReceiptCount = 0
  let noCurrentOwnerCount = 0
  let holderChangedCount = 0
  let claimSimulationPassCount = 0
  let fullEscrowSimulationCount = 0
  let noCodeHolderCount = 0
  let delegatedEoaHolderCount = 0
  let contractHolderCount = 0
  for (let index = 0; index < 7; index++) {
    const subject = row.subjects[index]
    const proof = row.proofs[index]
    if (
      typeof subject?.tokenId !== 'string' ||
      !POSITIVE_RAW.test(subject.tokenId) ||
      ids.has(subject.tokenId) ||
      typeof subject.receiptEscrowRaw !== 'string' ||
      !POSITIVE_RAW.test(subject.receiptEscrowRaw) ||
      proof?.tokenId !== subject.tokenId ||
      !['no_code', 'eip7702_delegated', 'contract_code'].includes(proof.holderCodeStatus ?? '')
    )
      throw Error('invalid_observation')
    ids.add(subject.tokenId)
    if (proof.status === 'no_current_owner') {
      if (
        proof.claimStatus !== undefined ||
        proof.claimAmountRaw !== undefined ||
        proof.currentOwner !== undefined
      )
        throw Error('invalid_observation')
      noCurrentOwnerCount++
      continue
    }
    if (proof.status === 'holder_changed') {
      if (
        typeof proof.currentOwner !== 'string' ||
        !/^0x[0-9a-f]{40}$/.test(proof.currentOwner) ||
        proof.currentOwner === subject.holder.toLowerCase() ||
        proof.claimStatus !== undefined ||
        proof.claimAmountRaw !== undefined
      )
        throw Error('invalid_observation')
      holderChangedCount++
      continue
    }
    if (
      proof.status !== 'same_holder' ||
      typeof proof.isClaimable !== 'boolean' ||
      !['success', 'evm_revert'].includes(proof.claimStatus) ||
      (proof.claimStatus === 'success' &&
        (!proof.isClaimable ||
          typeof proof.claimAmountRaw !== 'string' ||
          !POSITIVE_RAW.test(proof.claimAmountRaw) ||
          BigInt(proof.claimAmountRaw) > BigInt(subject.receiptEscrowRaw))) ||
      (proof.claimStatus === 'evm_revert' && proof.claimAmountRaw !== null)
    )
      throw Error('invalid_observation')
    openReceiptCount++
    if (proof.holderCodeStatus === 'no_code') noCodeHolderCount++
    else if (proof.holderCodeStatus === 'eip7702_delegated') delegatedEoaHolderCount++
    else contractHolderCount++
    if (proof.claimStatus === 'success') claimSimulationPassCount++
    if (
      proof.claimStatus === 'success' &&
      BigInt(proof.claimAmountRaw) === BigInt(subject.receiptEscrowRaw)
    )
      fullEscrowSimulationCount++
  }

  return {
    status: 'fresh',
    scope: 'historical_open_receipts',
    prospectiveQForecast: false,
    block: {
      number: row.block.number,
      hash: row.block.hash,
      timestamp: row.block.timestamp,
    },
    observedAtUtc: row.observedAtUtc,
    openReceiptCount,
    noCurrentOwnerCount,
    holderChangedCount,
    claimSimulationPassCount,
    fullEscrowSimulationCount,
    noCodeHolderCount,
    delegatedEoaHolderCount,
    contractHolderCount,
    sourceHosts: SOURCE_HOSTS,
  }
}

async function currentSummary(): Promise<Summary> {
  const now = Date.now()
  if (cache && now < cache.until && freshBlock(cache.summary.block, now)) return cache.summary
  cache = null
  if (loading) return loading
  loading = observeApyUsdOpenReceiptCurrent().then((row) => summarize(row, Date.now()))
  try {
    const summary = await loading
    cache = { summary, until: Date.now() + CACHE_MS }
    return summary
  } finally {
    loading = null
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!isLocalDevelopment(req))
    return res.status(503).json({ status: 'unavailable', reason: 'local_only' })
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ status: 'unavailable', reason: 'get_only' })
  }
  if (Object.keys(req.query).length !== 0)
    return res.status(400).json({ status: 'unavailable', reason: 'invalid_query' })
  try {
    return res.status(200).json(await currentSummary())
  } catch {
    return res.status(503).json({ status: 'unavailable', reason: 'observation_unavailable' })
  }
}
