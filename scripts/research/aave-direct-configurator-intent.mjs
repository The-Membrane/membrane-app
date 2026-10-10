import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toBytes,
} from 'viem'

// Ethereum Aave V3 Core PoolConfigurator. A matching address is necessary but
// insufficient: the caller must separately attest its code at the pinned block.
export const AAVE_CORE_POOL_CONFIGURATOR = '0x64b761D848206f447Fe2dd461b0c635Ec39EbB27'

const SPECS = [
  ['setSupplyCap(address,uint256)', 'supply_cap', 'cap'],
  ['setBorrowCap(address,uint256)', 'borrow_cap', 'cap'],
  ['setReserveFreeze(address,bool)', 'reserve_freeze', 'flag'],
  ['setReservePause(address,bool)', 'reserve_pause', 'flag'],
  ['setReservePause(address,bool,uint40)', 'reserve_pause_with_grace_period', 'flag'],
].map(([signature, kind, valueType]) => {
  const abi = parseAbi([`function ${signature}`])
  return {
    signature,
    kind,
    valueType,
    abi,
    selector: keccak256(toBytes(signature)).slice(0, 10),
    inputs: abi[0].inputs,
  }
})

const BY_SIGNATURE = new Map(SPECS.map((spec) => [spec.signature, spec]))
const BY_SELECTOR = new Map(SPECS.map((spec) => [spec.selector, spec]))
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`
const MAX_CAP = (1n << 36n) - 1n
const MAX_LIQUIDATION_GRACE_SECONDS = 4n * 60n * 60n

const lower = (value) => value.toLowerCase()
const same = (a, b) => ADDRESS.test(a ?? '') && ADDRESS.test(b ?? '') && lower(a) === lower(b)
const unknown = (reason) => ({ status: 'unknown', reason, alertEligible: false })

function decodeAction(action) {
  if (typeof action.signature !== 'string' || typeof action.callData !== 'string')
    return unknown('malformed_action')
  if (!HEX.test(action.callData)) return unknown('malformed_calldata')
  const signature = action.signature
  const spec = signature
    ? BY_SIGNATURE.get(signature)
    : BY_SELECTOR.get(action.callData.slice(0, 10).toLowerCase())
  if (!spec) return unknown('unsupported_function')
  try {
    let args
    if (signature) {
      // Governance V3 Executor prepends selector(signature); callData is only ABI args.
      args = decodeAbiParameters(spec.inputs, action.callData)
      if (lower(encodeAbiParameters(spec.inputs, args)) !== lower(action.callData))
        return unknown('noncanonical_calldata')
    } else {
      const decoded = decodeFunctionData({ abi: spec.abi, data: action.callData })
      args = decoded.args
      if (
        lower(encodeFunctionData({ abi: spec.abi, functionName: decoded.functionName, args })) !==
        lower(action.callData)
      )
        return unknown('noncanonical_calldata')
    }
    if (!Array.isArray(args) || !ADDRESS.test(args[0] ?? '')) return unknown('malformed_calldata')
    if (same(args[0], ZERO_ADDRESS)) return unknown('zero_reserve_address')
    return { spec, args }
  } catch {
    return unknown('malformed_calldata')
  }
}

function hasVerifiedContext(context, action, asset) {
  const targetCode = context?.verifiedTargetCode
  const reserve = context?.recognizedReserve
  return (
    (action.lifecycle === 'created' || action.lifecycle === 'queued') &&
    HASH.test(action.observationBlockHash ?? '') &&
    targetCode?.verified === true &&
    targetCode?.chainId === 1 &&
    same(targetCode.target, action.target) &&
    HASH.test(targetCode.blockHash ?? '') &&
    lower(targetCode.blockHash) === lower(action.observationBlockHash) &&
    HASH.test(targetCode.codeSha256 ?? '') &&
    reserve?.verified === true &&
    same(reserve.asset, asset) &&
    HASH.test(reserve.blockHash ?? '') &&
    lower(reserve.blockHash) === lower(targetCode.blockHash)
  )
}

function verifiedPrior(context, asset, kind) {
  const prior = context?.verifiedPriorValue
  const blockHash = context?.verifiedTargetCode?.blockHash
  if (
    prior?.verified !== true ||
    prior.kind !== kind ||
    !same(prior.asset, asset) ||
    !HASH.test(prior.blockHash ?? '') ||
    lower(prior.blockHash) !== lower(blockHash ?? '')
  )
    return null
  if (
    typeof prior.value !== 'bigint' &&
    !(typeof prior.value === 'string' && DECIMAL.test(prior.value))
  )
    return null
  try {
    const value = BigInt(prior.value)
    return value >= 0n && value <= (1n << 256n) - 1n ? value : null
  } catch {
    return null
  }
}

function verifiedPriorFreeze(context, asset) {
  const prior = context?.verifiedPriorFreeze
  const blockHash = context?.verifiedTargetCode?.blockHash
  return prior?.verified === true &&
    same(prior.asset, asset) &&
    HASH.test(prior.blockHash ?? '') &&
    lower(prior.blockHash) === lower(blockHash ?? '') &&
    typeof prior.value === 'boolean'
    ? prior.value
    : null
}

/**
 * Pure syntax/context classifier, never a capacity or alert claim. The
 * context is caller-supplied, not chain-verified here; downstream consumers
 * must independently check finality, code identity, reserve identity, and
 * before/after state before promoting any claim.
 */
export function classifyAaveDirectConfiguratorAction(action, context = {}) {
  if (!action || !same(action.target, AAVE_CORE_POOL_CONFIGURATOR))
    return unknown('unrecognized_target')
  if (action.withDelegateCall !== false) return unknown('delegatecall_or_missing_flag')
  if (
    typeof action.value !== 'bigint' &&
    !(typeof action.value === 'string' && DECIMAL.test(action.value))
  )
    return unknown('malformed_value')
  if (BigInt(action.value) !== 0n) return unknown('nonzero_value')
  const decoded = decodeAction(action)
  if (decoded.status === 'unknown') return decoded
  const { spec, args } = decoded
  const asset = args[0]
  const candidate = {
    status: 'candidate',
    kind: spec.kind,
    target: AAVE_CORE_POOL_CONFIGURATOR,
    asset,
    signature: spec.signature,
    selector: spec.selector,
    source: 'direct_pool_configurator_action',
    context: 'unverified',
    alertEligible: false,
    executableExitCapacity: 'not_inferred',
  }
  if (spec.valueType === 'cap') {
    candidate.proposedValue = args[1].toString()
    candidate.direction = 'unknown'
    if (args[1] > MAX_CAP) candidate.referenceCodeWarning = 'cap_exceeds_v3_origin_limit'
  } else {
    candidate.proposedValue = args[1]
    candidate.withdrawalImpact = 'not_inferred'
    if (args.length === 3 && args[1] === false)
      candidate.liquidationGracePeriodSeconds = args[2].toString()
    if (
      spec.kind === 'reserve_pause_with_grace_period' &&
      args[1] === false &&
      args[2] > MAX_LIQUIDATION_GRACE_SECONDS
    )
      candidate.referenceCodeWarning = 'unpause_grace_exceeds_v3_origin_limit'
  }
  if (!hasVerifiedContext(context, action, asset)) return candidate
  candidate.context = 'caller_attested_same_block'
  if (spec.kind === 'reserve_freeze' && verifiedPriorFreeze(context, asset) === args[1])
    candidate.referenceCodeWarning = 'unchanged_freeze_reverts_in_v3_origin'
  if (spec.valueType === 'cap') {
    if (candidate.referenceCodeWarning) return candidate
    const prior = verifiedPrior(context, asset, spec.kind)
    if (prior === null) return candidate
    candidate.priorValue = prior.toString()
    // Both Aave caps use zero to mean uncapped, not a ceiling of zero.
    candidate.direction =
      args[1] === prior
        ? 'unchanged'
        : args[1] === 0n || (prior !== 0n && args[1] > prior)
          ? 'increase'
          : 'decrease'
    candidate.capTransition =
      args[1] === prior
        ? 'unchanged'
        : args[1] === 0n
          ? 'removed'
          : prior === 0n
            ? 'introduced'
            : args[1] > prior
              ? 'raised'
              : 'lowered'
  }
  return candidate
}
