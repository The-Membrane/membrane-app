import { umbrellaGhoCalldata, umbrellaGhoStateCalls } from './carry-exit-v2-umbrella-gho-proof.mjs'
// Read-only, bounded raw eth_call capture for frozen Carry exit v2 cases.
// The decoder owns route identities and outcome interpretation. This module
// does not issue/score a ledger case or classify a covered exit restriction.
import { createHash } from 'node:crypto'
import { decodeFunctionResult, parseAbi } from 'viem'
import { resolveCarryExitV2Route, validateCarryExitV2RpcProof } from './carry-exit-v2-rpc-proof.mjs'
import { exactUtcMicros } from './carry-exit-v2-block-auditor.mjs'

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const WORD = /^0x[0-9a-f]{64}$/
const MAX_UINT = (1n << 256n) - 1n
const MAX_RESPONSE_BYTES = 16_384
const MAX_PROOF_BYTES = 32_768
const MAX_IDENTITY_BYTES = 32_768
const MAX_CODE_RESPONSE_BYTES = 65_536
const MAX_TIMEOUT_MS = 30_000
const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
// Same deployed Pool ABI shape used by lib/carry/directSupplyExitQuote.ts.
const POOL_IDENTITY_ABI = parseAbi([
  'function getReserveData(address) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
])
const VAULT = new Set(['umbrella_gho', 'morpho', 'susds', 'usd3', 'stusds', 'fluid', 'sgho'])
const POOL = new Set(['aave', 'spark'])

export class CarryExitV2RpcCollectionError extends Error {
  constructor(code, stage, cause) {
    super(code, { cause })
    this.name = 'CarryExitV2RpcCollectionError'
    this.code = code
    this.stage = stage
  }
}

function fail(code, stage, cause) {
  throw new CarryExitV2RpcCollectionError(code, stage, cause)
}

function amount(value) {
  if (
    typeof value !== 'string' ||
    !DECIMAL.test(value) ||
    BigInt(value) === 0n ||
    BigInt(value) > MAX_UINT
  )
    fail('invalid_frozen_q', 'input')
  return BigInt(value)
}

function uintWord(value) {
  return value.toString(16).padStart(64, '0')
}

function addressWord(value) {
  return value.slice(2).padStart(64, '0')
}

function auditedBlock(target) {
  const headers = target?.canonicalityEvidenceDoc
  const number = String(target?.targetBlock ?? '')
  const hash = target?.targetHash
  if (
    !DECIMAL.test(number) ||
    BigInt(number) <= 0n ||
    !HASH.test(hash ?? '') ||
    headers?.schema !== 'carry_exit_v2_headers_v1' ||
    headers.chainId !== '1' ||
    headers.finalityTag !== 'finalized' ||
    headers.targetHeader?.number !== number ||
    headers.targetHeader?.hash !== hash ||
    headers.targetHeader?.parentHash !== target.targetParentHash ||
    headers.targetHeader?.timestamp !== target.targetBlockAt ||
    headers.parentHeader?.number !== String(target.targetParentBlock) ||
    headers.parentHeader?.hash !== target.parentHeaderHash ||
    headers.parentHeader?.timestamp !== target.targetParentBlockAt ||
    target.targetParentHash !== target.parentHeaderHash ||
    BigInt(number) !== BigInt(target.targetParentBlock ?? 0) + 1n ||
    !DECIMAL.test(headers.finalizedHead?.number ?? '') ||
    BigInt(headers.finalizedHead.number) < BigInt(number) ||
    exactUtcMicros(target.targetParentBlockAt) >= exactUtcMicros(headers.targetAt) ||
    exactUtcMicros(target.targetBlockAt) < exactUtcMicros(headers.targetAt) ||
    exactUtcMicros(target.targetObservedAt) < exactUtcMicros(target.targetBlockAt) ||
    exactUtcMicros(target.targetObservedAt) !== exactUtcMicros(headers.observedAt)
  )
    fail('audited_target_invalid', 'input')
  return { number, hash }
}

function routeCalls(route, holder, q, holderShares) {
  const calls = [
    {
      stage: 'holder_coverage',
      target: route.holderCoverageTarget,
      data: `0x70a08231${addressWord(holder)}`,
    },
  ]
  if (VAULT.has(route.kind)) {
    calls.push({
      stage: 'required_coverage',
      target: route.requiredCoverageTarget,
      data:
        route.kind === 'umbrella_gho'
          ? umbrellaGhoCalldata('previewWithdraw', [q])
          : route.kind === 'morpho'
            ? `0x4cdad506${uintWord(holderShares)}`
            : `0x0a28a477${uintWord(q)}`,
    })
  }
  const withdrawData =
    route.kind === 'umbrella_gho'
      ? umbrellaGhoCalldata('redeem', [holderShares, holder, holder])
      : VAULT.has(route.kind)
        ? `0xb460af94${uintWord(q)}${addressWord(holder)}${addressWord(holder)}`
        : POOL.has(route.kind)
          ? `0x69328dec${addressWord(route.asset)}${uintWord(q)}${addressWord(holder)}`
          : `0xf3fef3a3${addressWord(route.asset)}${uintWord(q)}`
  calls.push({ stage: 'withdraw', target: route.withdrawTarget, data: withdrawData })
  return calls
}

function requestFor(stage, index, holder, target, data, blockHash) {
  return {
    jsonrpc: '2.0',
    id: index,
    method: 'eth_call',
    params: [
      { from: holder, to: target, data },
      { blockHash, requireCanonical: true },
    ],
  }
}

function responseKind(response, request, stage, maxResponseBytes = MAX_RESPONSE_BYTES) {
  if (
    !response ||
    typeof response !== 'object' ||
    response.jsonrpc !== '2.0' ||
    response.id !== request.id ||
    Buffer.byteLength(JSON.stringify(response), 'utf8') > maxResponseBytes
  )
    fail('provider_response_invalid', stage)
  const hasResult = Object.hasOwn(response, 'result')
  const hasError = Object.hasOwn(response, 'error')
  if (hasResult === hasError) fail('provider_response_invalid', stage)
  if (hasResult) return 'success'
  const error = response.error
  if (
    stage === 'withdraw' &&
    typeof error?.code === 'number' &&
    Number.isSafeInteger(error.code) &&
    typeof error.message === 'string' &&
    /\b(?:execution reverted|revert(?:ed)?)\b/i.test(error.message) &&
    !/gas required exceeds allowance|out of gas|exceeds block gas|intrinsic gas|gas limit/i.test(
      error.message,
    )
  )
    return 'evm_revert'
  fail('provider_failure', stage)
}

async function capture(send, request, stage, timeoutMs, maxResponseBytes = MAX_RESPONSE_BYTES) {
  let timer
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => send(request)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('rpc_timeout')), timeoutMs)
      }),
    ])
    const kind = responseKind(response, request, stage, maxResponseBytes)
    return { request, response, kind }
  } catch (error) {
    if (error instanceof CarryExitV2RpcCollectionError) throw error
    fail(error?.message === 'rpc_timeout' ? 'transport_timeout' : 'transport_failure', stage, error)
  } finally {
    clearTimeout(timer)
  }
}

function identityRequest(id, method, params) {
  return { jsonrpc: '2.0', id, method, params }
}

function pinnedTag(blockHash) {
  return { blockHash, requireCanonical: true }
}

function addressResult(captureResult, stage) {
  const value = captureResult.response.result
  if (
    !WORD.test(value ?? '') ||
    value.slice(2, 26) !== '0'.repeat(24) ||
    !ADDRESS.test(`0x${value.slice(-40)}`)
  )
    fail('identity_result_invalid', stage)
  return `0x${value.slice(-40)}`
}

async function collectIdentity(
  send,
  route,
  holder,
  blockNumber,
  blockHash,
  provider,
  source,
  timeoutMs,
) {
  const evidence = []
  let nextId = 10
  const code = async (address, stage, expectEmpty = false) => {
    const request = identityRequest(nextId++, 'eth_getCode', [address, pinnedTag(blockHash)])
    const result = await capture(send, request, stage, timeoutMs, MAX_CODE_RESPONSE_BYTES)
    const value = result.response.result
    if (
      typeof value !== 'string' ||
      !/^0x(?:[0-9a-f]{2})*$/.test(value) ||
      (expectEmpty ? value !== '0x' : value === '0x')
    )
      fail(expectEmpty ? 'contract_holder_unavailable' : 'identity_code_missing', stage)
    const bytes = Buffer.from(value.slice(2), 'hex')
    evidence.push({
      stage,
      method: 'eth_getCode',
      address,
      request,
      codeBytes: bytes.length,
      codeSha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const callAddress = async (to, data, stage) => {
    const request = identityRequest(nextId++, 'eth_call', [
      { from: holder, to, data },
      pinnedTag(blockHash),
    ])
    const result = await capture(send, request, stage, timeoutMs)
    const address = addressResult(result, stage)
    evidence.push({
      stage,
      method: 'eth_call',
      request,
      response: result.response,
      decodedAddress: address,
    })
    return address
  }

  await code(holder, 'holder_eoa', true)
  await code(route.destination, 'destination_code')
  if (route.withdrawTarget !== route.destination)
    await code(route.withdrawTarget, 'withdraw_target_code')
  await code(route.asset, 'asset_code')
  let liveAsset
  if (VAULT.has(route.kind))
    liveAsset = await callAddress(route.destination, '0x38d52e0f', 'vault_asset')
  else if (POOL.has(route.kind))
    liveAsset = await callAddress(route.destination, '0xb16a19de', 'atoken_underlying')
  else liveAsset = await callAddress(route.destination, '0xc55dae63', 'comet_base_token')
  if (liveAsset !== route.asset) fail('identity_asset_mismatch', 'identity')

  if (POOL.has(route.kind)) {
    const request = identityRequest(nextId++, 'eth_call', [
      { from: holder, to: route.withdrawTarget, data: `0x35ea6a75${addressWord(route.asset)}` },
      pinnedTag(blockHash),
    ])
    const result = await capture(send, request, 'pool_reserve', timeoutMs)
    const raw = result.response.result
    if (typeof raw !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(raw))
      fail('reserve_result_invalid', 'pool_reserve')
    let aToken
    try {
      aToken = decodeFunctionResult({
        abi: POOL_IDENTITY_ABI,
        functionName: 'getReserveData',
        data: raw,
      }).aTokenAddress.toLowerCase()
    } catch (error) {
      fail('reserve_result_invalid', 'pool_reserve', error)
    }
    if (aToken !== route.destination) fail('reserve_atoken_mismatch', 'pool_reserve')
    evidence.push({
      stage: 'pool_reserve',
      method: 'eth_call',
      request,
      response: result.response,
      decodedAToken: aToken,
    })
  }
  if (['usd3', 'umbrella_gho'].includes(route.kind)) {
    if (!ADDRESS.test(route.implementation ?? ''))
      fail('implementation_identity_unavailable', `${route.kind}_implementation`)
    const request = identityRequest(nextId++, 'eth_getStorageAt', [
      route.destination,
      EIP1967_IMPLEMENTATION_SLOT,
      pinnedTag(blockHash),
    ])
    const result = await capture(send, request, `${route.kind}_implementation`, timeoutMs)
    const implementation = addressResult(result, `${route.kind}_implementation`)
    if (implementation !== route.implementation)
      fail('implementation_identity_mismatch', `${route.kind}_implementation`)
    evidence.push({
      stage: `${route.kind}_implementation`,
      method: 'eth_getStorageAt',
      request,
      response: result.response,
      decodedAddress: implementation,
    })
    await code(route.implementation, `${route.kind}_implementation_code`)
  }
  const identityEvidence = {
    schema: 'carry_exit_v2_identity_v1',
    provider,
    source,
    chainId: '1',
    blockNumber,
    blockHash,
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder,
    kind: route.kind,
    checks: evidence,
  }
  if (Buffer.byteLength(JSON.stringify(identityEvidence), 'utf8') > MAX_IDENTITY_BYTES)
    fail('identity_evidence_too_large', 'identity')
  return identityEvidence
}

function proofRpc(capture, route, provider, source, decoded) {
  return {
    provider,
    source,
    callTarget: route,
    request: capture.request,
    response: capture.response,
    ...decoded,
  }
}

/**
 * @param {object} args Frozen route/holder/Q and a target returned by the v2 block auditor.
 * @param {(request: object) => Promise<object>} args.send Injected JSON-RPC transport returning
 *   the complete response envelope. Only `eth_call` is sent.
 */
export async function collectCarryExitV2RpcProof({
  routeKey,
  destination,
  asset,
  holder,
  assetsRaw,
  target,
  provider,
  source,
  send,
  timeoutMs = 15_000,
  now = () => new Date(),
}) {
  if (
    !ADDRESS.test(holder ?? '') ||
    typeof send !== 'function' ||
    typeof provider !== 'string' ||
    !provider.trim() ||
    provider.length > 160 ||
    typeof source !== 'string' ||
    !source.trim() ||
    source.length > 160 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    fail('invalid_collector_input', 'input')
  const q = amount(assetsRaw)
  const block = auditedBlock(target)
  // The route resolver reads only checked-in identities, including the Aave
  // and Spark Pool target and Compound Comet target.
  let route
  try {
    route = resolveCarryExitV2Route(routeKey, destination, asset)
  } catch (error) {
    fail('frozen_route_unavailable', 'input', error)
  }
  const identityEvidence = await collectIdentity(
    send,
    route,
    holder,
    block.number,
    block.hash,
    provider,
    source,
    timeoutMs,
  )
  const first = routeCalls(route, holder, q, 0n)[0]
  const balanceCapture = await capture(
    send,
    requestFor(first.stage, 1, holder, first.target, first.data, block.hash),
    first.stage,
    timeoutMs,
  )
  if (balanceCapture.kind !== 'success' || !WORD.test(balanceCapture.response.result ?? ''))
    fail('balance_result_invalid', 'holder_coverage')
  const holderRaw = BigInt(balanceCapture.response.result)
  const calls = routeCalls(route, holder, q, holderRaw)
  let requiredCapture = null
  let requiredRaw = q
  if (VAULT.has(route.kind)) {
    const call = calls[1]
    requiredCapture = await capture(
      send,
      requestFor(call.stage, 2, holder, call.target, call.data, block.hash),
      call.stage,
      timeoutMs,
    )
    if (requiredCapture.kind !== 'success' || !WORD.test(requiredCapture.response.result ?? ''))
      fail('required_result_invalid', 'required_coverage')
    requiredRaw = BigInt(requiredCapture.response.result)
  }
  const extra = {}
  if (route.kind === 'umbrella_gho') {
    for (const [index, call] of umbrellaGhoStateCalls(holder, requiredRaw, holderRaw).entries()) {
      const result = await capture(
        send,
        requestFor(call.field, 30 + index, holder, call.target, call.data, block.hash),
        call.field,
        timeoutMs,
      )
      const bytes = result.response.result
      const decodedRaw =
        call.field === 'stakerCooldownRpc'
          ? /^0x[0-9a-f]{192}$/.test(bytes ?? '')
            ? [0, 1, 2].map((i) => BigInt(`0x${bytes.slice(2 + i * 64, 66 + i * 64)}`).toString())
            : null
          : WORD.test(bytes ?? '')
            ? BigInt(bytes).toString()
            : null
      if (decodedRaw === null) fail('umbrella_state_invalid', call.field)
      extra[call.field] = proofRpc(result, call.target, provider, source, { decodedRaw })
    }
    extra.blockTimestampSeconds = String(Date.parse(target.targetBlockAt) / 1000)
  }
  const withdraw =
    route.kind === 'umbrella_gho'
      ? {
          stage: 'withdraw',
          target: route.destination,
          data: umbrellaGhoCalldata('redeem', [requiredRaw, holder, holder]),
        }
      : calls[calls.length - 1]
  const withdrawalCapture = await capture(
    send,
    requestFor(withdraw.stage, 3, holder, withdraw.target, withdraw.data, block.hash),
    withdraw.stage,
    timeoutMs,
  )
  let consumed = null
  if (withdrawalCapture.kind === 'success') {
    const result = withdrawalCapture.response.result
    if (VAULT.has(route.kind)) {
      if (!WORD.test(result ?? '')) fail('withdraw_result_invalid', 'withdraw')
      consumed = route.kind === 'umbrella_gho' ? requiredRaw : BigInt(result)
    } else if (POOL.has(route.kind)) {
      if (!WORD.test(result ?? '') || BigInt(result) !== q)
        fail('withdraw_result_invalid', 'withdraw')
    } else if (result !== '0x') fail('withdraw_result_invalid', 'withdraw')
  }
  const simulationStatus = withdrawalCapture.kind === 'evm_revert' ? 'evm_revert' : 'success'
  const proof = {
    ...extra,
    schema: 'carry_exit_v2_proof_v1',
    purpose: 'call',
    chainId: '1',
    routeKey,
    destination,
    asset,
    holder,
    caller: holder,
    assetsRaw,
    blockNumber: block.number,
    blockHash: block.hash,
    coverageKind:
      route.kind === 'morpho' ? 'morpho_shares_claim' : VAULT.has(route.kind) ? 'shares' : 'assets',
    holderCoverageRaw: holderRaw.toString(),
    requiredCoverageRaw: requiredRaw.toString(),
    actualConsumedRaw: consumed === null ? null : consumed.toString(),
    simulationStatus,
    holderCoverageRpc: proofRpc(balanceCapture, first.target, provider, source, {
      decodedRaw: holderRaw.toString(),
    }),
    requiredCoverageRpc: requiredCapture
      ? proofRpc(requiredCapture, route.requiredCoverageTarget, provider, source, {
          decodedRaw: requiredRaw.toString(),
        })
      : null,
    withdrawRpc: proofRpc(withdrawalCapture, withdraw.target, provider, source, {
      decodedAssetsRaw:
        route.kind === 'umbrella_gho'
          ? simulationStatus === 'success'
            ? BigInt(withdrawalCapture.response.result).toString()
            : null
          : q.toString(),
      decodedConsumedRaw: consumed === null ? null : consumed.toString(),
    }),
  }
  // Cross-check our collector against the independently-owned route decoder.
  // Do not turn `coveredRevert` into a scorer status here.
  if (Buffer.byteLength(JSON.stringify(proof), 'utf8') > MAX_PROOF_BYTES)
    fail('proof_too_large', 'verification')
  if (Buffer.byteLength(JSON.stringify({ ...proof, identityEvidence }), 'utf8') > MAX_PROOF_BYTES)
    fail('combined_evidence_too_large', 'verification')
  try {
    validateCarryExitV2RpcProof({
      proof,
      routeKey,
      destination,
      asset,
      holder,
      assetsRaw,
      blockNumber: block.number,
      blockHash: block.hash,
    })
  } catch (error) {
    fail('decoder_rejected', 'verification', error)
  }
  const capturedAt = now().toISOString()
  if (exactUtcMicros(capturedAt) < exactUtcMicros(target.targetObservedAt))
    fail('capture_clock_before_audit', 'verification')
  return {
    status: 'raw_rpc_collected',
    capturedAt,
    provider,
    source,
    blockNumber: block.number,
    blockHash: block.hash,
    routeKind: route.kind,
    identityEvidence,
    proof,
  }
}
