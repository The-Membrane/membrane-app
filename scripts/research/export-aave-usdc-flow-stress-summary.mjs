import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildHistoricalFlowSummary,
  replayFullArchiveJoin,
} from './aave-usdc-flow-shadow-forecast.mjs'
import { createVerifiedJoinSession } from './aave-usdc-cash-direct-flow-join.mjs'

export const OUTPUT = resolve('data/research/venue-signals/aave-usdc-flow-stress-summary-v1.json')
export const DURATION_OUTPUT = resolve(
  'data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json',
)
// Fixed to the Aave USDC entry in lib/carry/directSupplyMarketConstants.ts.
const IDENTITY = {
  chainId: 1,
  marketKey: 'aaveV3Usdc',
  routeKey: 'USDC → supply on Aave V3',
  destination: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  decimals: 6,
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function serializeFullReplaySummary(joined) {
  const summary = buildHistoricalFlowSummary({ joined })
  return `${JSON.stringify({ ...summary, identity: IDENTITY, sourceVerification: 'full_sealed_replay' })}\n`
}

/** Versioned time overlay; the legacy cash join and source digest stay byte-identical. */
export function serializeDurationReplaySummary(joined, timedJoined) {
  const summary = JSON.parse(serializeFullReplaySummary(joined))
  const withoutTimes = timedJoined.slices.map(({ verifiedTimeHeaders, ...slice }) => slice)
  if (JSON.stringify(withoutTimes) !== JSON.stringify(joined.slices))
    throw new Error('flow_duration_cash_overlay_mismatch')
  const headers = new Map()
  for (const slice of timedJoined.slices) {
    if (!Array.isArray(slice.verifiedTimeHeaders)) throw new Error('flow_duration_headers_missing')
    for (const header of slice.verifiedTimeHeaders) {
      const prior = headers.get(header.blockNumber)
      if (prior && JSON.stringify(prior) !== JSON.stringify(header))
        throw new Error('flow_duration_header_disagreement')
      headers.set(header.blockNumber, header)
    }
  }
  const orderedHeaders = [...headers.values()].sort((a, b) => a.blockNumber - b.blockNumber)
  if (orderedHeaders.length < 2) throw new Error('flow_duration_headers_missing')
  const pairedWindows = summary.pairedWindows.map((window) => {
    const slices = timedJoined.slices.filter(
      (slice) =>
        slice.fromExclusive >= window.originBlock && slice.toInclusive <= window.targetBlock,
    )
    if (
      slices[0]?.fromExclusive !== window.originBlock ||
      slices.at(-1)?.toInclusive !== window.targetBlock
    )
      throw new Error('flow_duration_window_path_missing')
    const points = [
      {
        blockNumber: window.originBlock,
        blockHash: slices[0].fromHash,
        cashAfterRaw: window.sourceCashRaw,
      },
    ]
    for (const slice of slices) {
      if (!Array.isArray(slice.blockFlows)) throw new Error('flow_duration_window_path_missing')
      points.push(
        ...slice.blockFlows.map((row) => ({
          blockNumber: row.blockNumber,
          blockHash: row.blockHash,
          cashAfterRaw: row.cashAfterRaw,
        })),
      )
    }
    if (points.at(-1).blockNumber !== window.targetBlock)
      points.push({
        blockNumber: window.targetBlock,
        blockHash: slices.at(-1).toHash,
        cashAfterRaw: window.targetCashRaw,
      })
    const before = orderedHeaders.filter((row) => row.blockNumber < window.originBlock).at(-1)
    const after = orderedHeaders.find((row) => row.blockNumber > window.targetBlock)
    const timeHeaders = [
      ...(before ? [before] : []),
      ...orderedHeaders.filter(
        (row) => row.blockNumber >= window.originBlock && row.blockNumber <= window.targetBlock,
      ),
      ...(after ? [after] : []),
    ]
    return {
      ...window,
      durationPath: {
        originBlock: window.originBlock,
        targetBlock: window.targetBlock,
        sourceJoinSha256: summary.source.joinContentSha256,
        coverage: 'complete_end_of_block_transfer_path',
        timestampProvenance: 'verified_two_origin_direct_headers_hash_join',
        points,
        timeHeaders,
        gaps: [],
      },
    }
  })
  return `${JSON.stringify({
    ...summary,
    pairedWindows,
    pairedWindowsSha256: digest(pairedWindows),
    durationOverlay: {
      schema: 'carry_historical_flow_duration_overlay_v1',
      sourceJoinSha256: summary.source.joinContentSha256,
      timedJoinSha256: digest(timedJoined),
      pathsSha256: digest(pairedWindows.map((window) => window.durationPath)),
    },
    identity: IDENTITY,
    sourceVerification: 'full_sealed_replay',
  })}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (
    args.length > 1 ||
    (args.length === 1 && !['--verify', '--duration', '--verify-duration'].includes(args[0]))
  ) {
    throw new Error('flow_summary_invalid_mode')
  }
  const session = createVerifiedJoinSession()
  const joined = replayFullArchiveJoin(session)
  const duration = args[0]?.includes('duration')
  const content = duration
    ? serializeDurationReplaySummary(
        joined,
        replayFullArchiveJoin({
          ...session,
          at: (endpoint) => session.at(endpoint, { retainVerifiedTimes: true }),
        }),
      )
    : serializeFullReplaySummary(joined)
  const output = duration ? DURATION_OUTPUT : OUTPUT
  if (duration && readFileSync(OUTPUT, 'utf8') !== serializeFullReplaySummary(joined))
    throw new Error('flow_duration_legacy_source_changed')
  if (args[0]?.startsWith('--verify')) {
    if (readFileSync(output, 'utf8') !== content) throw new Error('flow_summary_artifact_mismatch')
    process.stdout.write('flow_summary_verified\n')
  } else {
    writeFileSync(output, content)
    process.stdout.write(`${output}\n`)
  }
}
