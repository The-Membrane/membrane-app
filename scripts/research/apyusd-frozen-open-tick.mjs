// One serial lane inside the existing Mac holder-exit campaign. The outer
// campaign owns the lock and hard 550-second child-process limit.
import { existsSync, statfsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls, publicRpcClients } from './carry-public-direct-exit-issue.mjs'
import { observeCurrent } from './apyusd-open-receipt-current.mjs'
import { captureContinuity } from './apyusd-open-receipt-continuity.mjs'
import {
  findPostcutoffBurn,
  capturePostcutoffPayout,
  verifyPostcutoffPayout,
  verifyPostcutoffPayoutLocal,
  OUT as PAYOUT_OUT,
} from './apyusd-open-receipt-postcutoff-payouts.mjs'
import {
  capturePostcutoff,
  verifyPostcutoff,
  OUT as SCAN_OUT,
} from './apyusd-open-receipt-postcutoff-transfers.mjs'
import { verifySource } from './apyusd-receipt-cohort-source.mjs'
import { verifyTransfers } from './apyusd-receipt-cohort-transfers.mjs'

const IDS = ['881', '891', '897', '906', '935', '941', '947']
const ZERO = `0x${'0'.repeat(64)}`
const MIN_FREE_BYTES = 1_073_741_824 + 262_144
const CURRENT_RPC_CALLS = 110
const CURRENT_WALL_MS = 180_000
const TICK_WALL_MS = 520_000
const SCAN_ALLOWANCE_MS = 160_000
const PAYOUT_ALLOWANCE_MS = 130_000
const fail = (condition, code) => {
  if (!condition) throw Error(code)
}

export function boundedCurrentObserver({
  urls = configuredPublicRpcUrls(readEnv()),
  clientsForUrls = publicRpcClients,
  observer = observeCurrent,
  clock = Date.now,
} = {}) {
  return async ({ sourceLoader }) => {
    const deadline = clock() + CURRENT_WALL_MS
    let calls = 0
    const boundedClients = (clientUrls) =>
      clientsForUrls(clientUrls).map((origin) => ({
        ...origin,
        async request(...args) {
          fail(calls < CURRENT_RPC_CALLS && clock() < deadline, 'apyusd_frozen_current_budget')
          calls++
          return origin.request(...args)
        },
        async send(...args) {
          fail(calls < CURRENT_RPC_CALLS && clock() < deadline, 'apyusd_frozen_current_budget')
          calls++
          return origin.send(...args)
        },
      }))
    const result = await observer({ urls, sourceLoader, clientsForUrls: boundedClients })
    fail(clock() < deadline, 'apyusd_frozen_current_budget')
    return result
  }
}

/** Attempt each independent stage once; a current-call failure cannot stop the scan. */
export async function runApyUsdFrozenOpen({
  continuity = captureContinuity,
  scan = capturePostcutoff,
  scanLoader = verifyPostcutoff,
  sourceLoader = verifySource,
  transfersLoader = verifyTransfers,
  payout = capturePostcutoffPayout,
  liveVerifier = verifyPostcutoffPayout,
  observer = null,
  storedPayout = async (tokenId) => {
    if (!existsSync(join(PAYOUT_OUT, `${tokenId}.json`))) return false
    await verifyPostcutoffPayoutLocal(tokenId)
    return true
  },
  freeBytes = () => {
    const disk = statfsSync(dirname(SCAN_OUT))
    return Number(disk.bavail) * Number(disk.bsize)
  },
  clock = Date.now,
} = {}) {
  fail(freeBytes() >= MIN_FREE_BYTES, 'apyusd_frozen_disk_reserve')
  const deadline = clock() + TICK_WALL_MS
  const startId = Math.floor(clock() / (2 * 3_600_000)) % IDS.length
  const orderedIds = [...IDS.slice(startId), ...IDS.slice(0, startId)]
  const result = { continuity: 'skipped', scan: 'skipped', payout: 'no_burn', errors: [] }

  try {
    const value = await continuity({ observer: observer ?? boundedCurrentObserver() })
    result.continuity = value.status
  } catch (error) {
    result.continuity = 'failed'
    result.errors.push('continuity')
  }

  if (clock() + SCAN_ALLOWANCE_MS < deadline) {
    try {
      const value = await scan({ maxWindows: 1 })
      result.scan = value.status
    } catch (error) {
      result.scan = 'failed'
      result.errors.push('scan')
    }
  }

  if (clock() + PAYOUT_ALLOWANCE_MS >= deadline) {
    result.payout = 'deferred'
    return result
  }
  let rows
  try {
    rows = await scanLoader()
  } catch (error) {
    result.payout = 'scan_unverified'
    result.errors.push('scan_verification')
    return result
  }
  const burned = new Set(
    rows.flatMap((row) =>
      row.transfers
        .filter((event) => event.topics[2] === ZERO)
        .map((event) => BigInt(event.topics[3]).toString()),
    ),
  )
  if (!burned.size) return result

  try {
    const [source, transfers] = await Promise.all([sourceLoader(), transfersLoader()])
    const savedIds = []
    for (const tokenId of orderedIds.filter((tokenId) => burned.has(tokenId))) {
      let candidate
      try {
        candidate = findPostcutoffBurn(tokenId, source, transfers, rows)
      } catch (error) {
        if (
          [
            'apyusd_postcutoff_payout_intermediate_transfer',
            'apyusd_postcutoff_payout_prior_transfer',
          ].includes(error.message)
        )
          continue
        throw error
      }
      if (!candidate) continue
      try {
        if (await storedPayout(tokenId)) {
          savedIds.push(tokenId)
          continue
        }
      } catch {
        result.errors.push('saved_payout_invalid')
        continue
      }
      if (clock() + PAYOUT_ALLOWANCE_MS >= deadline) {
        result.payout = 'deferred'
        return result
      }
      await payout(tokenId)
      result.payout = `captured:${tokenId}`
      return result
    }
    if (savedIds.length) {
      if (clock() + PAYOUT_ALLOWANCE_MS >= deadline) {
        result.payout = 'deferred'
        return result
      }
      await liveVerifier(savedIds[0])
      result.payout = `reverified:${savedIds[0]}`
    } else result.payout = 'no_original_holder_burn'
  } catch (error) {
    result.payout = 'failed'
    result.errors.push('payout')
  }
  return result
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    fail(process.argv.length === 2, 'apyusd_frozen_usage')
    const result = await runApyUsdFrozenOpen()
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.errors.length) process.exitCode = 1
  } catch (error) {
    process.stderr.write(
      `${/^apyusd_[a-z0-9_]+$/.test(error?.message) ? error.message : 'apyusd_frozen_failed'}\n`,
    )
    process.exitCode = 1
  }
}
