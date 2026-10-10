// Bounded event-schema viability for four frozen vault addresses, not holder exit evidence.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { encodeFunctionData, parseAbi } from 'viem'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import {
  TOPICS,
  compareOrigins,
  header,
  makeRpc,
  normalizeLogs,
  requireResult,
  selectCandidateOrigins,
  selectOrigins,
  verifyHeaderChain,
} from './carry-direct-vault-flow-preflight.mjs'

export const ROUTES = Object.freeze([
  {
    routeKeys: [
      'USDC → FluidBridgeAggregatorProxy [USDC]',
      'USDT → FluidBridgeAggregatorProxy [USDC]',
    ],
    vault: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    flowUnit: 'USDC',
  },
  {
    routeKeys: ['USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]'],
    vault: '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
    asset: '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',
    flowUnit: 'PT-srUSDe-22OCT2026',
    implementation: '0x41695d3304e38bc806f077a3541c5cd34f8f034b',
  },
  {
    routeKeys: ['USDe → Staked USDe [USDe]'],
    vault: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
    asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
    flowUnit: 'USDe',
  },
  {
    routeKeys: ['GHO → UmbrellaStakeToken [GHO]'],
    vault: '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
    asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    flowUnit: 'GHO',
    implementation: '0x75e8ac0c063b6966e2a9954adedf39bde9370197',
  },
])

export const RANGE_BLOCKS = 5
export const MAX_EXPECTED_RPC_CALLS = 42
export const MAX_CANDIDATE_BLOCKS = 1800
const ADDRESS_WORD = /^0x0{24}[0-9a-fA-F]{40}$/
const CODE = /^0x(?:[0-9a-fA-F]{2})+$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const QUANTITY = /^0x[0-9a-fA-F]+$/
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ASSET_DATA = encodeFunctionData({
  abi: parseAbi(['function asset() view returns (address)']),
  functionName: 'asset',
})
const hex = (value) => `0x${value.toString(16)}`
const sha = (value) => createHash('sha256').update(value).digest('hex')

function decodedAddress(receipt) {
  const value = requireResult(receipt)
  if (typeof value !== 'string' || !ADDRESS_WORD.test(value))
    throw Error('secondary_flow_address_invalid')
  return `0x${value.slice(-40).toLowerCase()}`
}

function candidateLogs(receipt, fromBlock, toBlock) {
  const raw = requireResult(receipt)
  if (!Array.isArray(raw) || raw.length > 1024) throw Error('secondary_flow_candidates_invalid')
  const vaults = new Set(ROUTES.map((route) => route.vault))
  const logs = raw.map((log) => {
    if (
      !vaults.has(log?.address?.toLowerCase()) ||
      !QUANTITY.test(log.blockNumber ?? '') ||
      !HASH.test(log.blockHash ?? '') ||
      !HASH.test(log.transactionHash ?? '') ||
      !QUANTITY.test(log.logIndex ?? '') ||
      !Array.isArray(log.topics) ||
      ![TOPICS.deposit, TOPICS.withdraw].includes(log.topics[0]?.toLowerCase()) ||
      log.topics.some((topic) => !HASH.test(topic)) ||
      !HEX.test(log.data ?? '') ||
      log.removed === true
    )
      throw Error('secondary_flow_candidates_invalid')
    const blockNumber = Number(BigInt(log.blockNumber))
    const logIndex = Number(BigInt(log.logIndex))
    if (
      !Number.isSafeInteger(blockNumber) ||
      !Number.isSafeInteger(logIndex) ||
      blockNumber < fromBlock ||
      blockNumber > toBlock
    )
      throw Error('secondary_flow_candidate_outside_range')
    return {
      address: log.address.toLowerCase(),
      blockNumber,
      blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      logIndex,
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(),
    }
  })
  logs.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.logIndex - b.logIndex ||
      a.transactionHash.localeCompare(b.transactionHash),
  )
  if (
    new Set(logs.map((log) => `${log.blockHash}:${log.transactionHash}:${log.logIndex}`)).size !==
    logs.length
  )
    throw Error('secondary_flow_candidate_duplicate')
  return logs
}

/** Search leads only; validate candidate blocks with preflightSecondaryVaultEvents({toBlock}). */
export async function findSecondaryHistoricalCandidates({
  urls,
  fromBlock,
  toBlock,
  fetchImpl = fetch,
  nowMs = Date.now,
} = {}) {
  if (
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlock) ||
    fromBlock < 0 ||
    toBlock < fromBlock ||
    toBlock - fromBlock + 1 > MAX_CANDIDATE_BLOCKS
  )
    throw Error('secondary_flow_candidate_range_invalid')
  const origins = selectCandidateOrigins(urls ?? configuredPublicRpcUrls(readEnv()).slice(0, 2))
  const { rpc, budget } = makeRpc(fetchImpl, nowMs)
  const filter = {
    address: ROUTES.map((route) => route.vault),
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
    topics: [[TOPICS.deposit, TOPICS.withdraw]],
  }
  const receipts = []
  const normalized = []
  for (const origin of origins) {
    const receipt = await rpc(origin, 'eth_getLogs', [filter])
    receipts.push(receipt)
    normalized.push(candidateLogs(receipt, fromBlock, toBlock))
  }
  if (normalized.length === 2) compareOrigins(normalized[0], normalized[1])
  const routes = ROUTES.map((route) => {
    const rows = normalized[0].filter((row) => row.address === route.vault)
    return {
      routeKeys: route.routeKeys,
      vault: route.vault,
      status: rows.length ? 'unverified_candidate' : 'no_candidate_in_sampled_range',
      candidateBlocks: [...new Set(rows.map((row) => row.blockNumber))],
      logCount: rows.length,
    }
  })
  return {
    schema: 'carry_secondary_vault_historical_candidate_v1',
    range: { fromBlock, toBlock },
    topics: TOPICS,
    routes,
    receipts,
    sourceAgreement:
      normalized.length === 2 ? 'two_hostname_agreed_unverified' : 'single_hostname_unverified',
    normalizedLogSha256: sha(JSON.stringify(normalized[0])),
    limits: {
      maxBlocks: MAX_CANDIDATE_BLOCKS,
      maxRpcCalls: origins.length,
      maxResponseBytes: 256 * 1024,
      maxTotalResponseBytes: 2 * 1024 * 1024,
      maxRunMs: 90_000,
      actual: budget(),
    },
    limitation:
      'Candidate logs are unverified leads, not canonical blocks, strict event proof, complete history, vault identity, holder payout, USDT conversion, PT redemption, or cooldown completion.',
  }
}

export async function preflightSecondaryVaultEvents({
  urls,
  fetchImpl = fetch,
  nowMs = Date.now,
  toBlock,
  vaults,
} = {}) {
  if (toBlock !== undefined && (!Number.isSafeInteger(toBlock) || toBlock < RANGE_BLOCKS - 1))
    throw Error('secondary_flow_target_invalid')
  const selected =
    vaults === undefined
      ? ROUTES
      : Array.isArray(vaults) && vaults.length > 0 && vaults.length <= ROUTES.length
        ? vaults.map((vault) => ROUTES.find((route) => route.vault === vault))
        : null
  if (!selected || selected.some((route) => !route) || new Set(selected).size !== selected.length)
    throw Error('secondary_flow_selection_invalid')
  const origins = selectOrigins(urls ?? configuredPublicRpcUrls(readEnv()))
  const { rpc, budget } = makeRpc(fetchImpl, nowMs)
  const receipts = []
  const get = async (origin, method, params) => {
    const receipt = await rpc(origin, method, params)
    receipts.push(receipt)
    return receipt
  }
  for (const origin of origins) {
    const chain = requireResult(await get(origin, 'eth_chainId', []))
    if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chain) || BigInt(chain) !== 1n)
      throw Error('secondary_flow_wrong_chain')
  }
  const heads = []
  for (const origin of origins)
    heads.push(header(await get(origin, 'eth_getBlockByNumber', ['finalized', false])))
  const finalizedLimit = Math.min(...heads.map((head) => head.number))
  if (toBlock !== undefined && toBlock > finalizedLimit)
    throw Error('secondary_flow_target_not_finalized')
  const to = toBlock ?? finalizedLimit
  if (to < RANGE_BLOCKS - 1) throw Error('secondary_flow_head_invalid')
  const from = to - RANGE_BLOCKS + 1
  const headerChains = []
  for (const origin of origins) {
    const chain = []
    for (let number = from; number <= to; number++)
      chain.push(header(await get(origin, 'eth_getBlockByNumber', [hex(number), false])))
    verifyHeaderChain(chain, from, to)
    headerChains.push(chain)
  }
  compareOrigins(headerChains[0], headerChains[1])
  const commonHeaders = headerChains[0]
  const pin = { blockHash: commonHeaders.at(-1).hash, requireCanonical: true }
  const routes = []
  for (const route of selected) {
    const witnesses = []
    for (const origin of origins) {
      const code = requireResult(await get(origin, 'eth_getCode', [route.vault, pin]))
      if (typeof code !== 'string' || !CODE.test(code))
        throw Error('secondary_flow_runtime_missing')
      const asset = decodedAddress(
        await get(origin, 'eth_call', [{ to: route.vault, data: ASSET_DATA }, pin]),
      )
      if (asset !== route.asset) throw Error('secondary_flow_asset_mismatch')
      let implementation = null
      if (route.implementation) {
        implementation = decodedAddress(
          await get(origin, 'eth_getStorageAt', [route.vault, IMPL_SLOT, pin]),
        )
        if (implementation !== route.implementation)
          throw Error('secondary_flow_implementation_mismatch')
      }
      const logs = normalizeLogs(
        await get(origin, 'eth_getLogs', [
          {
            address: route.vault,
            fromBlock: hex(from),
            toBlock: hex(to),
            topics: [[TOPICS.deposit, TOPICS.withdraw]],
          },
        ]),
        route.vault,
        from,
        to,
        commonHeaders,
      ).map((log) => ({
        ...log,
        identityAtPinnedBlock: log.blockNumber === to ? 'verified' : 'unverified_earlier_block',
      }))
      witnesses.push({
        origin: origin.host,
        runtime: { bytes: (code.length - 2) / 2, sha256: sha(Buffer.from(code.slice(2), 'hex')) },
        asset,
        implementation,
        logs,
      })
    }
    compareOrigins({ ...witnesses[0], origin: null }, { ...witnesses[1], origin: null })
    const pinned = witnesses[0].logs.filter((log) => log.blockNumber === to)
    const earlier = witnesses[0].logs.length - pinned.length
    routes.push({
      routeKeys: route.routeKeys,
      vault: route.vault,
      asset: route.asset,
      flowUnit: route.flowUnit,
      status: pinned.length
        ? 'standard_events_observed'
        : earlier
          ? 'earlier_events_unverified_identity'
          : 'no_events_in_sampled_range',
      pinnedDepositCount: pinned.filter((log) => log.eventName === 'Deposit').length,
      pinnedWithdrawCount: pinned.filter((log) => log.eventName === 'Withdraw').length,
      earlierUnverifiedEventCount: earlier,
      witnesses,
    })
  }
  const actual = budget()
  if (actual.calls > MAX_EXPECTED_RPC_CALLS) throw Error('secondary_flow_rpc_budget_exhausted')
  return {
    schema: 'carry_secondary_vault_event_preflight_v1',
    observedAtUtc: new Date(nowMs()).toISOString(),
    selectedVaults: selected.map((route) => route.vault),
    range: { from, to, fromHash: commonHeaders[0].hash, toHash: commonHeaders.at(-1).hash },
    finalizedHeads: heads.map((head, i) => ({ origin: origins[i].host, ...head })),
    headerChains: headerChains.map((headers, i) => ({ origin: origins[i].host, headers })),
    routes,
    topics: TOPICS,
    receipts,
    limits: {
      maxRangeBlocks: RANGE_BLOCKS,
      maxExpectedRpcCalls: MAX_EXPECTED_RPC_CALLS,
      maxRpcCalls: 44,
      maxResponseBytes: 256 * 1024,
      maxTotalResponseBytes: 2 * 1024 * 1024,
      maxRunMs: 90_000,
      actual,
    },
    limitation:
      'Gross event schema at a pinned vault address is not holder payout, USDT conversion, PT-to-USDe delivery, cooldown resolution, or complete flow history. Same-block implementation attribution is unproved without transaction-order evidence.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2)
    throw Error('usage: node carry-secondary-vault-event-preflight.mjs')
  preflightSecondaryVaultEvents()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${String(error?.message ?? error)}\n`)
      process.exitCode = 1
    })
}
