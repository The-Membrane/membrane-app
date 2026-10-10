import { createHash } from 'node:crypto'

import type { NextApiRequest, NextApiResponse } from 'next'

import flowSummary from '@/data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import {
  projectHistoricalGrossFlowStress,
  isFreshHistoricalCashBlock,
  type HistoricalGrossFlowSummary,
} from '@/lib/carry/historicalGrossFlowStress'
import {
  localDevelopmentRequest,
  readCurrentDirectCashOrigins,
} from '@/pages/api/carry/forecast-observations'
import { buildSubjectManifest } from '@/scripts/record-carry-cash-issues.mjs'

const AAVE = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
const RAW = /^[1-9][0-9]{0,77}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SUMMARY_SHA256 = '234e6875376ff9978d2d7f019b83e93250455959b5a95ef1fcfcbbe588a86f62'

export function parseHistoricalFlowStressQuery(query: Record<string, unknown>) {
  const { routeKey, destination, requestedRaw } = query
  if (
    typeof routeKey !== 'string' ||
    routeKey.length < 1 ||
    routeKey.length > 200 ||
    typeof destination !== 'string' ||
    !ADDRESS.test(destination) ||
    typeof requestedRaw !== 'string' ||
    !RAW.test(requestedRaw)
  )
    return null
  return { routeKey, destination: destination.toLowerCase(), requestedRaw }
}

function verifiedSummary(): HistoricalGrossFlowSummary {
  const digest = createHash('sha256')
    .update(`${JSON.stringify(flowSummary)}\n`)
    .digest('hex')
  const pairedDigest = createHash('sha256')
    .update(JSON.stringify(flowSummary.pairedWindows))
    .digest('hex')
  const pathsDigest = createHash('sha256')
    .update(JSON.stringify(flowSummary.pairedWindows.map((window) => window.durationPath)))
    .digest('hex')
  if (
    digest !== SUMMARY_SHA256 ||
    flowSummary.schema !== 'carry_historical_paired_flow_summary_v1' ||
    pairedDigest !== flowSummary.pairedWindowsSha256 ||
    flowSummary.durationOverlay.schema !== 'carry_historical_flow_duration_overlay_v1' ||
    flowSummary.durationOverlay.sourceJoinSha256 !== flowSummary.source.joinContentSha256 ||
    pathsDigest !== flowSummary.durationOverlay.pathsSha256 ||
    flowSummary.sourceVerification !== 'full_sealed_replay' ||
    flowSummary.identity.chainId !== 1 ||
    flowSummary.identity.marketKey !== 'aaveV3Usdc' ||
    flowSummary.identity.routeKey !== AAVE.routeKey ||
    flowSummary.identity.destination.toLowerCase() !== AAVE.destination.toLowerCase() ||
    flowSummary.identity.asset.toLowerCase() !== AAVE.underlying.toLowerCase() ||
    flowSummary.identity.decimals !== AAVE.decimals
  )
    throw new Error('flow_summary_identity_or_digest_mismatch')
  return flowSummary as HistoricalGrossFlowSummary
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  if (!localDevelopmentRequest(req))
    return res.status(503).json({ error: 'local_flow_stress_unavailable' })
  const query = parseHistoricalFlowStressQuery(req.query)
  if (!query) return res.status(400).json({ error: 'invalid_historical_flow_request' })

  try {
    const manifest = await buildSubjectManifest()
    const tracked = manifest.subjects.some(
      (subject) =>
        subject.route_key === query.routeKey && subject.destination === query.destination,
    )
    if (!tracked) return res.status(404).json({ error: 'subject_not_tracked' })
    if (query.routeKey !== AAVE.routeKey || query.destination !== AAVE.destination.toLowerCase())
      return res.status(200).json({
        status: 'gross_flow_unverified',
        routeKey: query.routeKey,
        destination: query.destination,
        requestedRaw: query.requestedRaw,
      })

    const current = await readCurrentDirectCashOrigins(AAVE.routeKey)
    if (current.status !== 'observed' || current.originValidation !== 'multi_rpc_host_match')
      return res.status(200).json({
        status: 'current_cash_unverified',
        routeKey: query.routeKey,
        destination: query.destination,
        requestedRaw: query.requestedRaw,
        currentCashStatus: current.status,
      })
    const { reading } = current
    if (
      reading.source.chainId !== 1 ||
      reading.source.finality !== 'finalized' ||
      !Number.isSafeInteger(reading.source.blockNumber) ||
      reading.source.blockNumber < 0 ||
      !/^0x[0-9a-fA-F]{64}$/.test(reading.source.blockHash) ||
      !isFreshHistoricalCashBlock(reading.source.blockTimestamp, Date.now()) ||
      reading.route.routeKey !== query.routeKey ||
      reading.route.destination.toLowerCase() !== query.destination ||
      reading.asset.address.toLowerCase() !== AAVE.underlying.toLowerCase() ||
      reading.asset.decimals !== AAVE.decimals
    )
      return res.status(503).json({ error: 'current_cash_identity_mismatch' })

    const stress = projectHistoricalGrossFlowStress(
      verifiedSummary(),
      reading.route.cashRaw,
      query.requestedRaw,
    )
    const responseAtMs = Date.now()
    if (!isFreshHistoricalCashBlock(reading.source.blockTimestamp, responseAtMs))
      return res.status(503).json({ error: 'current_cash_identity_mismatch' })
    const ageSeconds = Math.max(
      0,
      Math.floor((responseAtMs - Date.parse(reading.source.blockTimestamp)) / 1000),
    )
    return res.status(200).json({
      status: 'historical_flow_stress',
      chainId: reading.source.chainId,
      marketKey: 'aaveV3Usdc',
      routeKey: query.routeKey,
      destination: query.destination,
      requestedRaw: query.requestedRaw,
      asset: reading.asset.address.toLowerCase(),
      assetDecimals: reading.asset.decimals,
      currentCash: {
        cashRaw: reading.route.cashRaw,
        blockNumber: reading.source.blockNumber,
        blockHash: reading.source.blockHash,
        blockTimestamp: reading.source.blockTimestamp,
        ageSeconds,
        rpcHostAgreement: current.originValidation,
      },
      archiveVerification: 'full_sealed_replay',
      archiveArtifactSha256: SUMMARY_SHA256,
      stress,
    })
  } catch {
    return res.status(503).json({ error: 'historical_flow_stress_unavailable' })
  }
}
