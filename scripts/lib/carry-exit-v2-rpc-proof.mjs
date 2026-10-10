import {
  UMBRELLA_GHO_ROUTE,
  validateUmbrellaGhoProof,
} from './carry-exit-v2-umbrella-gho-proof.mjs'
// Deterministic decoder for stored eth_call envelopes. Route identities come
// from checked-in manifests and constants, never from the proof or caller.
import morphoIdentities from '../../lib/carry/morpho-v2-asset-identities.json' with { type: 'json' }
import seed from '../route-cohort/aug-2026-ab-vault-seed.json' with { type: 'json' }
import { GHO_SGHO } from '../route-rates/exact-leg-spread.mjs'

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const WORD = /^0x[0-9a-f]{64}$/
const MAX_UINT = (1n << 256n) - 1n
const KINDS = new Set([
  'umbrella_gho',
  'morpho',
  'susds',
  'usd3',
  'stusds',
  'fluid',
  'sgho',
  'aave',
  'spark',
  'comet',
])
const VAULT = new Set(['morpho', 'susds', 'usd3', 'stusds', 'fluid', 'sgho'])
const POOL = new Set(['aave', 'spark'])

const fixedRoutes = [
  ['sgho', 'GHO → sGho [GHO]', GHO_SGHO.destination, GHO_SGHO.borrowAsset],
  [
    'susds',
    'USDS → SUsds [USDS]',
    '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
    '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  ],
  [
    'usd3',
    'USDC → USD3 [USDC]',
    '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'stusds',
    'USDS → StUsds [USDS]',
    '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  ],
  [
    'fluid',
    'USDC → Fluid USD Coin [USDC]',
    '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'fluid',
    'USDT → fToken [USDT]',
    '0x5c20b550819128074fd538edf79791733ccedd18',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ],
  [
    'fluid',
    'GHO → fToken [GHO]',
    '0x6a29a46e21c730dca1d8b23d637c101cec605c5b',
    '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  ],
  [
    'fluid',
    'USDC → FluidBridgeAggregatorProxy [USDC]',
    '0x273da948aca9261043fbdb2a857bc255ecc29012',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'aave',
    'USDC → supply on Aave V3',
    '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  ],
  [
    'aave',
    'USDe → supply on Aave V3',
    '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
    '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
    '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  ],
  [
    'spark',
    'USDT → supply on Spark',
    '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
    '0xc13e21b648a5ee794902342038ff3adab66be987',
  ],
  [
    'comet',
    'USDC → supply on Compound v3',
    '0xc3d688b66703497daa19211eedff47f25384cdc3',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
]

function frozenRoutes() {
  if (
    seed.schemaVersion !== 1 ||
    seed.cohortId !== 'aug-2026-ab-vault-routes' ||
    morphoIdentities.schemaVersion !== 1 ||
    morphoIdentities.chainId !== 1 ||
    morphoIdentities.cohortId !== seed.cohortId ||
    morphoIdentities.entries.length !== 49
  )
    fail('invalid_frozen_manifest')
  if (
    GHO_SGHO.chainId !== 1 ||
    GHO_SGHO.destination !== '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d' ||
    GHO_SGHO.borrowAsset !== '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f' ||
    !seed.positions.some(
      (position) =>
        position.vault === GHO_SGHO.destination && position.routeIds.includes('GHO → sGho [GHO]'),
    )
  )
    fail('invalid_frozen_sgho_route')
  const identityByVault = new Map(
    morphoIdentities.entries.map((entry) => [entry.vault, entry.asset]),
  )
  if (identityByVault.size !== 49) fail('invalid_frozen_manifest')
  const morpho = new Map()
  for (const position of seed.positions) {
    const asset = identityByVault.get(position.vault)
    if (!asset) continue
    for (const routeKey of position.routeIds) {
      const key = `${routeKey}\u0000${position.vault}`
      morpho.set(
        key,
        Object.freeze({
          kind: 'morpho',
          routeKey,
          destination: position.vault,
          asset,
          withdrawTarget: position.vault,
          holderCoverageTarget: position.vault,
          requiredCoverageTarget: position.vault,
        }),
      )
    }
  }
  const routes = [...morpho.values()]
  for (const [kind, routeKey, destination, asset, pool] of fixedRoutes) {
    routes.push(
      Object.freeze({
        kind,
        routeKey,
        destination,
        asset,
        withdrawTarget: pool ?? destination,
        holderCoverageTarget: destination,
        ...(VAULT.has(kind) ? { requiredCoverageTarget: destination } : {}),
        ...(kind === 'usd3'
          ? { implementation: '0xd1f1c3f485063712873285bf4ef25ab068f13893' }
          : {}),
      }),
    )
  }
  return Object.freeze([...routes, UMBRELLA_GHO_ROUTE])
}

export const CARRY_EXIT_V2_FROZEN_ROUTES = frozenRoutes()

export class CarryExitV2RpcProofError extends Error {
  constructor(code) {
    super(code)
    this.name = 'CarryExitV2RpcProofError'
    this.code = code
  }
}

function fail(code) {
  throw new CarryExitV2RpcProofError(code)
}

function amount(value, code, positive = false) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail(code)
  const parsed = BigInt(value)
  if (parsed > MAX_UINT || (positive && parsed === 0n)) fail(code)
  return parsed
}

function word(value) {
  if (!WORD.test(value ?? '')) fail('invalid_result_word')
  return BigInt(value)
}

function addressWord(value) {
  return value.slice(2).padStart(64, '0')
}

function uintWord(value) {
  return value.toString(16).padStart(64, '0')
}

function exactCall(selector, words) {
  return `${selector}${words.join('')}`
}

function envelope(rpc, target, holder, blockHash, data, outcome) {
  if (!rpc || typeof rpc !== 'object' || rpc.callTarget !== target) fail('wrong_call_target')
  if (
    typeof rpc.provider !== 'string' ||
    !rpc.provider.trim() ||
    rpc.provider.length > 160 ||
    typeof rpc.source !== 'string' ||
    !rpc.source.trim() ||
    rpc.source.length > 160
  )
    fail('invalid_rpc_source')
  const request = rpc.request
  const response = rpc.response
  if (!request || !response || request.jsonrpc !== '2.0' || request.method !== 'eth_call')
    fail('invalid_rpc_envelope')
  if (
    !Array.isArray(request.params) ||
    request.params.length !== 2 ||
    !request.params[0] ||
    Object.keys(request.params[0]).sort().join(',') !== 'data,from,to' ||
    request.params[0].from !== holder ||
    request.params[0].to !== target ||
    request.params[0].data !== data ||
    !request.params[1] ||
    Object.keys(request.params[1]).sort().join(',') !== 'blockHash,requireCanonical' ||
    request.params[1].blockHash !== blockHash ||
    request.params[1].requireCanonical !== true
  )
    fail('wrong_rpc_call')
  if (
    (typeof request.id !== 'string' && !Number.isSafeInteger(request.id)) ||
    response.jsonrpc !== '2.0' ||
    response.id !== request.id
  )
    fail('wrong_rpc_response_id')
  if (outcome === 'success') {
    if (!Object.hasOwn(response, 'result') || Object.hasOwn(response, 'error'))
      fail('invalid_success_response')
    return response.result
  }
  if (
    Object.hasOwn(response, 'result') ||
    !response.error ||
    typeof response.error.code !== 'number' ||
    !Number.isSafeInteger(response.error.code) ||
    typeof response.error.message !== 'string' ||
    !/\b(?:execution reverted|revert(?:ed)?)\b/i.test(response.error.message) ||
    /gas required exceeds allowance|out of gas|exceeds block gas|intrinsic gas|gas limit/i.test(
      response.error.message,
    )
  )
    fail('invalid_revert_response')
  return null
}

function decoded(rpc, field, raw) {
  if (rpc[field] !== raw.toString()) fail('decoded_value_mismatch')
}

export function resolveCarryExitV2Route(routeKey, destination, asset) {
  const matches = CARRY_EXIT_V2_FROZEN_ROUTES.filter(
    (entry) =>
      entry.routeKey === routeKey && entry.destination === destination && entry.asset === asset,
  )
  if (matches.length !== 1) fail('unsupported_route')
  const route = matches[0]
  if (
    !KINDS.has(route.kind) ||
    !ADDRESS.test(route.withdrawTarget ?? '') ||
    !ADDRESS.test(route.holderCoverageTarget ?? '') ||
    (VAULT.has(route.kind) && route.withdrawTarget !== destination) ||
    (route.kind === 'comet' && route.withdrawTarget !== destination) ||
    (VAULT.has(route.kind) && route.holderCoverageTarget !== destination) ||
    (route.kind === 'comet' && route.holderCoverageTarget !== destination) ||
    (VAULT.has(route.kind) && route.requiredCoverageTarget !== destination) ||
    (POOL.has(route.kind) && route.holderCoverageTarget === route.withdrawTarget)
  )
    fail('invalid_frozen_route')
  return route
}

/** Validate a stored v2 proof against checked-in route identities and frozen case identity.
 */
export function validateCarryExitV2RpcProof({
  proof,
  routeKey,
  destination,
  asset,
  holder,
  assetsRaw,
  blockNumber,
  blockHash,
}) {
  if (
    !ADDRESS.test(destination ?? '') ||
    !ADDRESS.test(asset ?? '') ||
    !ADDRESS.test(holder ?? '') ||
    !HASH.test(blockHash ?? '')
  )
    fail('invalid_frozen_identity')
  const q = amount(assetsRaw, 'invalid_frozen_amount', true)
  amount(blockNumber, 'invalid_frozen_block', true)
  const route = resolveCarryExitV2Route(routeKey, destination, asset)
  if (route.kind === 'umbrella_gho')
    return validateUmbrellaGhoProof({
      proof,
      routeKey,
      destination,
      asset,
      holder,
      assetsRaw,
      blockNumber,
      blockHash,
    })
  const isVault = VAULT.has(route.kind)
  const coverageKind =
    route.kind === 'morpho' ? 'morpho_shares_claim' : isVault ? 'shares' : 'assets'
  if (
    !proof ||
    proof.schema !== 'carry_exit_v2_proof_v1' ||
    proof.chainId !== '1' ||
    proof.purpose !== 'call' ||
    proof.routeKey !== routeKey ||
    proof.destination !== destination ||
    proof.asset !== asset ||
    proof.holder !== holder ||
    proof.caller !== holder ||
    proof.assetsRaw !== assetsRaw ||
    proof.blockNumber !== blockNumber ||
    proof.blockHash !== blockHash ||
    proof.coverageKind !== coverageKind ||
    !['success', 'evm_revert'].includes(proof.simulationStatus)
  )
    fail('proof_identity_mismatch')

  const balanceBytes = envelope(
    proof.holderCoverageRpc,
    route.holderCoverageTarget,
    holder,
    blockHash,
    exactCall('0x70a08231', [addressWord(holder)]),
    'success',
  )
  const balance = word(balanceBytes)
  decoded(proof.holderCoverageRpc, 'decodedRaw', balance)
  if (proof.holderCoverageRaw !== balance.toString()) fail('decoded_value_mismatch')

  let required
  if (isVault) {
    const redeem = route.kind === 'morpho'
    const requiredBytes = envelope(
      proof.requiredCoverageRpc,
      route.requiredCoverageTarget,
      holder,
      blockHash,
      exactCall(redeem ? '0x4cdad506' : '0x0a28a477', [uintWord(redeem ? balance : q)]),
      'success',
    )
    required = word(requiredBytes)
    decoded(proof.requiredCoverageRpc, 'decodedRaw', required)
  } else {
    if (proof.requiredCoverageRpc != null) fail('unexpected_required_coverage_rpc')
    required = q
  }
  if (proof.requiredCoverageRaw !== required.toString()) fail('decoded_value_mismatch')

  const withdrawData = isVault
    ? exactCall('0xb460af94', [uintWord(q), addressWord(holder), addressWord(holder)])
    : POOL.has(route.kind)
      ? exactCall('0x69328dec', [addressWord(asset), uintWord(q), addressWord(holder)])
      : exactCall('0xf3fef3a3', [addressWord(asset), uintWord(q)])
  const output = envelope(
    proof.withdrawRpc,
    route.withdrawTarget,
    holder,
    blockHash,
    withdrawData,
    proof.simulationStatus,
  )
  if (proof.withdrawRpc.decodedAssetsRaw !== q.toString()) fail('decoded_value_mismatch')
  let consumed = null
  if (proof.simulationStatus === 'success') {
    if (isVault) {
      consumed = word(output)
      if (consumed === 0n || consumed > balance) fail('invalid_consumed_shares')
    } else if (POOL.has(route.kind)) {
      if (word(output) !== q) fail('withdraw_amount_mismatch')
    } else if (output !== '0x') {
      fail('invalid_comet_result')
    }
  }
  if (
    proof.withdrawRpc.decodedConsumedRaw !== (consumed === null ? null : consumed.toString()) ||
    proof.actualConsumedRaw !== (consumed === null ? null : consumed.toString())
  )
    fail('decoded_value_mismatch')
  const covered =
    proof.simulationStatus === 'evm_revert' &&
    (route.kind === 'morpho' ? required >= q : isVault ? required <= balance : balance >= q)
  return {
    routeKind: route.kind,
    holderCoverageRaw: balance.toString(),
    requiredCoverageRaw: required.toString(),
    actualConsumedRaw: consumed === null ? null : consumed.toString(),
    ...(route.kind === 'morpho'
      ? {
          holderSharesRaw: balance.toString(),
          previewRedeemAssetsRaw: required.toString(),
          requiredAssetsRaw: q.toString(),
          sharesBurnedRaw: consumed === null ? null : consumed.toString(),
        }
      : {}),
    simulationStatus: proof.simulationStatus,
    coveredRevert: covered,
  }
}
