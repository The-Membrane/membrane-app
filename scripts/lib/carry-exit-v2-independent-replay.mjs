import {
  carryExitV2ProofRpcFields,
  UMBRELLA_GHO_DECODED_FIELDS,
} from './carry-exit-v2-umbrella-gho-proof.mjs'
// Read-only, two-origin replay of a stored carry exit call proof. The transports
// accept and return complete JSON-RPC envelopes; neither endpoint is trusted
// to identify the other or to supply the frozen case identity.
import { createHash } from 'node:crypto'
import { decodeFunctionResult, parseAbi } from 'viem'

import { resolveCarryExitV2Route, validateCarryExitV2RpcProof } from './carry-exit-v2-rpc-proof.mjs'

const HASH = /^0x[0-9a-f]{64}$/
const HEX = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
// Leave most of the 32 KiB enclosing proof budget for identity/call evidence.
const MAX_EVIDENCE_BYTES = 12 * 1024
const MAX_IDENTITY_BYTES = 32 * 1024
const MAX_CODE_BYTES = 65_536
const ADDRESS = /^0x[0-9a-f]{40}$/
const CODE = /^0x(?:[0-9a-f]{2})*$/
const WORD = /^0x[0-9a-f]{64}$/
const VAULT = new Set(['umbrella_gho', 'morpho', 'susds', 'usd3', 'stusds', 'fluid', 'sgho'])
const POOL = new Set(['aave', 'spark'])
const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const POOL_IDENTITY_ABI = parseAbi([
  'function getReserveData(address) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
])

function unavailable(reason) {
  return { status: 'unavailable', reason }
}

function origin(url) {
  if (typeof url !== 'string') throw new Error('invalid_origin')
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname)
    throw new Error('invalid_origin')
  // URL.hostname lowercases DNS names and canonicalizes IP literals. Remove a
  // DNS root dot and common loopback aliases before comparing hosts.
  const hostname = parsed.hostname.replace(/\.$/, '').replace(/^www\./, '')
  const hostKey = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(hostname)
    ? 'loopback'
    : hostname
  return { identifier: `${parsed.protocol}//${parsed.host}`, hostKey }
}

async function rpc(request, method, params, id) {
  const envelope = { jsonrpc: '2.0', id, method, params }
  const response = await request(envelope)
  if (
    !response ||
    typeof response !== 'object' ||
    response.jsonrpc !== '2.0' ||
    response.id !== id ||
    Object.hasOwn(response, 'error') ||
    !Object.hasOwn(response, 'result')
  )
    throw new Error('rpc_unavailable')
  return response.result
}

function header(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !HEX.test(raw.number ?? '') ||
    !HASH.test(raw.hash ?? '') ||
    !HASH.test(raw.parentHash ?? '') ||
    !HEX.test(raw.timestamp ?? '')
  )
    throw new Error('header_mismatch')
  return {
    number: raw.number,
    hash: raw.hash,
    parentHash: raw.parentHash,
    timestamp: raw.timestamp,
  }
}

async function checkChain(request, targetNumber, targetHash, prefix) {
  const blockTag = `0x${targetNumber.toString(16)}`
  const finalized = header(
    await rpc(request, 'eth_getBlockByNumber', ['finalized', false], `${prefix}-head`),
  )
  if (BigInt(finalized.number) < targetNumber) throw new Error('unfinalized_target')
  const target = header(
    await rpc(request, 'eth_getBlockByNumber', [blockTag, false], `${prefix}-target`),
  )
  if (BigInt(target.number) !== targetNumber || target.hash !== targetHash)
    throw new Error('header_mismatch')
  return { finalized, target }
}

async function replayCall(request, stored) {
  const call = stored.request
  const response = await request(structuredClone(call))
  if (
    !response ||
    typeof response !== 'object' ||
    response.jsonrpc !== '2.0' ||
    response.id !== call.id ||
    Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')
  )
    throw new Error('invalid_replay_response')
  return response
}

async function replayProof(request, proof, identity) {
  const replay = structuredClone(proof)
  const responses = {}
  for (const field of carryExitV2ProofRpcFields(proof)) {
    if (replay[field] != null) {
      replay[field].response = await replayCall(request, replay[field])
      responses[field] = replay[field].response
    }
  }
  return { decoded: validateCarryExitV2RpcProof({ proof: replay, ...identity }), responses }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function identityPlan(route, holder, asset, blockHash) {
  const pin = { blockHash, requireCanonical: true }
  const plan = []
  const code = (stage, address, empty = false) =>
    plan.push({ stage, method: 'eth_getCode', address, params: [address, pin], empty })
  const call = (stage, to, data, method = 'eth_call') =>
    plan.push({
      stage,
      method,
      params: method === 'eth_call' ? [{ from: holder, to, data }, pin] : [to, data, pin],
    })
  code('holder_eoa', holder, true)
  code('destination_code', route.destination)
  if (route.withdrawTarget !== route.destination) code('withdraw_target_code', route.withdrawTarget)
  code('asset_code', asset)
  call(
    VAULT.has(route.kind)
      ? 'vault_asset'
      : POOL.has(route.kind)
        ? 'atoken_underlying'
        : 'comet_base_token',
    route.destination,
    VAULT.has(route.kind) ? '0x38d52e0f' : POOL.has(route.kind) ? '0xb16a19de' : '0xc55dae63',
  )
  if (POOL.has(route.kind))
    call('pool_reserve', route.withdrawTarget, `0x35ea6a75${asset.slice(2).padStart(64, '0')}`)
  if (['usd3', 'umbrella_gho'].includes(route.kind)) {
    call(
      `${route.kind}_implementation`,
      route.destination,
      EIP1967_IMPLEMENTATION_SLOT,
      'eth_getStorageAt',
    )
    code(`${route.kind}_implementation_code`, route.implementation)
  }
  return plan
}

function addressFromWord(result) {
  if (!WORD.test(result ?? '') || result.slice(2, 26) !== '0'.repeat(24))
    throw new Error('identity_address_invalid')
  const address = `0x${result.slice(-40)}`
  if (!ADDRESS.test(address)) throw new Error('identity_address_invalid')
  return address
}

function identityDecoded(stage, result) {
  if (stage === 'pool_reserve') {
    const decoded = decodeFunctionResult({
      abi: POOL_IDENTITY_ABI,
      functionName: 'getReserveData',
      data: result,
    }).aTokenAddress.toLowerCase()
    if (!ADDRESS.test(decoded)) throw new Error('identity_address_invalid')
    return decoded
  }
  return addressFromWord(result)
}

export function validateIdentityPlan(evidence, identity, route) {
  if (
    !evidence ||
    evidence.schema !== 'carry_exit_v2_identity_v1' ||
    evidence.chainId !== '1' ||
    evidence.blockNumber !== identity.blockNumber ||
    evidence.blockHash !== identity.blockHash ||
    evidence.routeKey !== identity.routeKey ||
    evidence.destination !== identity.destination ||
    evidence.asset !== identity.asset ||
    evidence.holder !== identity.holder ||
    evidence.kind !== route.kind ||
    typeof evidence.provider !== 'string' ||
    !evidence.provider.trim() ||
    typeof evidence.source !== 'string' ||
    !evidence.source.trim() ||
    !Array.isArray(evidence.checks) ||
    Buffer.byteLength(canonical(evidence)) > MAX_IDENTITY_BYTES
  )
    throw new Error('identity_unverified')
  const plan = identityPlan(route, identity.holder, identity.asset, identity.blockHash)
  if (evidence.checks.length !== plan.length) throw new Error('identity_stages_invalid')
  for (const [index, expected] of plan.entries()) {
    const check = evidence.checks[index]
    const request = {
      jsonrpc: '2.0',
      id: 10 + index,
      method: expected.method,
      params: expected.params,
    }
    if (
      !check ||
      check.stage !== expected.stage ||
      check.method !== expected.method ||
      canonical(check.request) !== canonical(request) ||
      (expected.method === 'eth_getCode' && check.address !== expected.address)
    )
      throw new Error('identity_stages_invalid')
    if (expected.method === 'eth_getCode') {
      if (
        !Number.isSafeInteger(check.codeBytes) ||
        check.codeBytes < 0 ||
        (expected.empty ? check.codeBytes !== 0 : check.codeBytes === 0) ||
        !/^[0-9a-f]{64}$/.test(check.codeSha256 ?? '')
      )
        throw new Error('identity_code_invalid')
      continue
    }
    const response = check.response
    if (
      !response ||
      typeof response !== 'object' ||
      response.jsonrpc !== '2.0' ||
      response.id !== request.id ||
      Object.hasOwn(response, 'error') ||
      !Object.hasOwn(response, 'result')
    )
      throw new Error('identity_response_invalid')
    const decoded = identityDecoded(expected.stage, response.result)
    const expectedAddress =
      expected.stage === `${route.kind}_implementation`
        ? route.implementation
        : expected.stage === 'pool_reserve'
          ? route.destination
          : identity.asset
    if (
      decoded !== expectedAddress ||
      (expected.stage === 'pool_reserve'
        ? check.decodedAToken !== decoded
        : check.decodedAddress !== decoded)
    )
      throw new Error('identity_address_disagreement')
  }
  return plan
}

async function replayIdentity(request, evidence, plan, route, asset) {
  const summary = []
  for (const [index, expected] of plan.entries()) {
    const check = evidence.checks[index]
    const response = await request(structuredClone(check.request))
    if (
      !response ||
      response.jsonrpc !== '2.0' ||
      response.id !== check.request.id ||
      Object.hasOwn(response, 'error') ||
      !Object.hasOwn(response, 'result')
    )
      throw new Error('identity_rpc_unavailable')
    if (expected.method === 'eth_getCode') {
      const raw = response.result
      if (
        !CODE.test(raw ?? '') ||
        raw.length > 2 + MAX_CODE_BYTES * 2 ||
        (expected.empty ? raw !== '0x' : raw === '0x')
      )
        throw new Error('identity_code_invalid')
      const bytes = Buffer.from(raw.slice(2), 'hex')
      const codeSha256 = createHash('sha256').update(bytes).digest('hex')
      if (check.codeBytes !== bytes.length || check.codeSha256 !== codeSha256)
        throw new Error('identity_code_disagreement')
      summary.push({ stage: expected.stage, codeBytes: bytes.length, codeSha256 })
    } else {
      if (canonical(response) !== canonical(check.response))
        throw new Error('identity_response_disagreement')
      const decoded = identityDecoded(expected.stage, response.result)
      const expectedAddress =
        expected.stage === `${route.kind}_implementation`
          ? route.implementation
          : expected.stage === 'pool_reserve'
            ? route.destination
            : asset
      if (
        decoded !== expectedAddress ||
        (expected.stage === 'pool_reserve'
          ? check.decodedAToken !== decoded
          : check.decodedAddress !== decoded)
      )
        throw new Error('identity_address_disagreement')
      summary.push({ stage: expected.stage, response, decodedAddress: decoded })
    }
  }
  return summary
}

function sameDecoded(left, right) {
  return (
    left.holderCoverageRaw === right.holderCoverageRaw &&
    left.requiredCoverageRaw === right.requiredCoverageRaw &&
    left.actualConsumedRaw === right.actualConsumedRaw &&
    left.simulationStatus === right.simulationStatus &&
    left.coveredRevert === right.coveredRevert &&
    (left.gate === undefined ||
      UMBRELLA_GHO_DECODED_FIELDS.every((field) => left[field] === right[field]))
  )
}

/**
 * Verify a stored call proof against a second, distinct RPC origin.
 * Transports take a full JSON-RPC request and return a full response. A
 * transport failure, malformed response, or disagreement yields unavailable.
 * The only positive output is a status verdict; holder values stay internal.
 * Target timestamp and parentHash must agree across sources and rereads, but
 * their relationship to an issuance target comes from the separate block auditor.
 */
export async function verifyCarryExitV2IndependentReplay(args) {
  const {
    proof,
    identityEvidence,
    primary,
    secondary,
    now = () => new Date(),
    ...identity
  } = args ?? {}
  let original
  try {
    original = validateCarryExitV2RpcProof({ proof, ...identity })
  } catch {
    return unavailable('invalid_primary_proof')
  }
  let plan
  let route
  try {
    route = resolveCarryExitV2Route(identity.routeKey, identity.destination, identity.asset)
    plan = validateIdentityPlan(identityEvidence, identity, route)
  } catch {
    return unavailable('identity_unverified')
  }

  let first
  let second
  try {
    first = origin(primary?.url)
    second = origin(secondary?.url)
    if (
      first.identifier === second.identifier ||
      first.hostKey === second.hostKey ||
      typeof primary.request !== 'function' ||
      typeof secondary.request !== 'function' ||
      primary.request === secondary.request
    )
      return unavailable('non_independent_origins')
  } catch {
    return unavailable('invalid_origins')
  }

  const targetNumber = BigInt(identity.blockNumber)
  try {
    const before = await Promise.all([
      checkChain(primary.request, targetNumber, identity.blockHash, 'primary-before'),
      checkChain(secondary.request, targetNumber, identity.blockHash, 'secondary-before'),
    ])
    if (canonical(before[0].target) !== canonical(before[1].target))
      return unavailable('header_disagreement')
    if (
      route.kind === 'umbrella_gho' &&
      BigInt(before[0].target.timestamp).toString() !== proof.blockTimestampSeconds
    )
      return unavailable('header_timestamp_mismatch')

    const primaryReplay = await replayProof(primary.request, proof, identity)
    const secondaryReplay = await replayProof(secondary.request, proof, identity)
    if (
      !sameDecoded(original, primaryReplay.decoded) ||
      !sameDecoded(primaryReplay.decoded, secondaryReplay.decoded)
    )
      return unavailable('replay_disagreement')
    const primaryIdentity = await replayIdentity(
      primary.request,
      identityEvidence,
      plan,
      route,
      identity.asset,
    )
    const secondaryIdentity = await replayIdentity(
      secondary.request,
      identityEvidence,
      plan,
      route,
      identity.asset,
    )
    if (canonical(primaryIdentity) !== canonical(secondaryIdentity))
      return unavailable('identity_disagreement')

    const after = await Promise.all([
      checkChain(primary.request, targetNumber, identity.blockHash, 'primary-after'),
      checkChain(secondary.request, targetNumber, identity.blockHash, 'secondary-after'),
    ])
    if (
      canonical(after[0].target) !== canonical(before[0].target) ||
      canonical(after[1].target) !== canonical(before[1].target)
    )
      return unavailable('header_disagreement')
    if (
      route.kind === 'umbrella_gho' &&
      BigInt(before[0].target.timestamp).toString() !== proof.blockTimestampSeconds
    )
      return unavailable('header_timestamp_mismatch')
    const observedAt = now().toISOString()
    const replayEvidenceDoc = {
      schema: 'carry_exit_v2_independent_replay_v1',
      blockNumber: identity.blockNumber,
      blockHash: identity.blockHash,
      observedAt,
      origins: { primary: first.identifier, secondary: second.identifier },
      headers: {
        primary: { before: before[0], after: after[0] },
        secondary: { before: before[1], after: after[1] },
      },
      responses: { primary: primaryReplay.responses, secondary: secondaryReplay.responses },
      identityReplay: { primary: primaryIdentity, secondary: secondaryIdentity },
      decoded: {
        ...(route.kind === 'umbrella_gho'
          ? Object.fromEntries(
              UMBRELLA_GHO_DECODED_FIELDS.map((field) => [field, secondaryReplay.decoded[field]]),
            )
          : {}),
        holderCoverageRaw: secondaryReplay.decoded.holderCoverageRaw,
        requiredCoverageRaw: secondaryReplay.decoded.requiredCoverageRaw,
        actualConsumedRaw: secondaryReplay.decoded.actualConsumedRaw,
        simulationStatus: secondaryReplay.decoded.simulationStatus,
        coveredRevert: secondaryReplay.decoded.coveredRevert,
      },
    }
    const json = canonical(replayEvidenceDoc)
    if (Buffer.byteLength(json) > MAX_EVIDENCE_BYTES) return unavailable('evidence_too_large')
    return {
      status: 'verified',
      verdict: {
        simulationStatus: secondaryReplay.decoded.simulationStatus,
        coveredRevert: secondaryReplay.decoded.coveredRevert,
      },
      replayEvidenceDoc,
      replayEvidenceSha256: createHash('sha256').update(json).digest('hex'),
    }
  } catch {
    return unavailable('rpc_unavailable_or_disagreement')
  }
}
