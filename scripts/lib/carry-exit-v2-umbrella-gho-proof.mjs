import { encodeFunctionData, parseAbi } from 'viem'

export const UMBRELLA_GHO_ROUTE = Object.freeze({
  kind: 'umbrella_gho',
  routeKey: 'GHO → UmbrellaStakeToken [GHO]',
  destination: '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
  asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  implementation: '0x75e8ac0c063b6966e2a9954adedf39bde9370197',
  withdrawTarget: '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
  holderCoverageTarget: '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
  requiredCoverageTarget: '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
})
export const UMBRELLA_GHO_ABI = parseAbi([
  'function paused() view returns (bool)',
  'function getCooldown() view returns (uint256)',
  'function getUnstakeWindow() view returns (uint256)',
  'function getStakerCooldown(address) view returns (uint192 amount,uint32 endOfCooldown,uint32 withdrawalWindow)',
  'function maxRedeem(address) view returns (uint256)',
  'function getMaxSlashableAssets() view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function redeem(uint256,address,address) returns (uint256)',
  'function decimals() view returns (uint8)',
])
export function umbrellaGhoCalldata(functionName, args = []) {
  return encodeFunctionData({ abi: UMBRELLA_GHO_ABI, functionName, args })
}
export const UMBRELLA_GHO_DECODED_FIELDS = Object.freeze([
  'gate',
  'holderClaimRaw',
  'payoutAssetsRaw',
  'slashableAssetsRaw',
  'cooldownSeconds',
  'unstakeWindowSeconds',
  'cooldownEndSeconds',
  'windowEndInclusiveSeconds',
])
export const UMBRELLA_GHO_STATE_FIELDS = Object.freeze([
  'pausedRpc',
  'cooldownRpc',
  'unstakeWindowRpc',
  'stakerCooldownRpc',
  'maxRedeemRpc',
  'slashableAssetsRpc',
  'previewRedeemRpc',
  'holderClaimRpc',
  'assetDecimalsRpc',
  'shareDecimalsRpc',
])
export function carryExitV2ProofRpcFields(proof) {
  return [
    'holderCoverageRpc',
    'requiredCoverageRpc',
    'withdrawRpc',
    ...(proof?.routeKey === UMBRELLA_GHO_ROUTE.routeKey ? UMBRELLA_GHO_STATE_FIELDS : []),
  ]
}
export function umbrellaGhoStateCalls(holder, required, balance) {
  return [
    ['pausedRpc', 'paused', []],
    ['cooldownRpc', 'getCooldown', []],
    ['unstakeWindowRpc', 'getUnstakeWindow', []],
    ['stakerCooldownRpc', 'getStakerCooldown', [holder]],
    ['maxRedeemRpc', 'maxRedeem', [holder]],
    ['slashableAssetsRpc', 'getMaxSlashableAssets', []],
    ['previewRedeemRpc', 'previewRedeem', [required]],
    ['holderClaimRpc', 'previewRedeem', [balance]],
    ['assetDecimalsRpc', 'decimals', []],
    ['shareDecimalsRpc', 'decimals', []],
  ].map(([field, name, args]) => ({
    field,
    data: umbrellaGhoCalldata(name, args),
    target:
      field === 'assetDecimalsRpc' ? UMBRELLA_GHO_ROUTE.asset : UMBRELLA_GHO_ROUTE.destination,
  }))
}
const WORD = /^0x[0-9a-f]{64}$/
const MAX = (1n << 256n) - 1n
const fail = (code) => {
  throw Error(`umbrella_gho_${code}`)
}
const raw = (value) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? '') || BigInt(value) > MAX) fail('invalid_raw')
  return BigInt(value)
}
function result(rpc, identity, target, data, outcome = 'success') {
  const request = rpc?.request,
    response = rpc?.response
  if (
    rpc?.callTarget !== target ||
    !rpc.provider?.trim() ||
    rpc.provider.length > 160 ||
    !rpc.source?.trim() ||
    rpc.source.length > 160 ||
    request?.jsonrpc !== '2.0' ||
    request.method !== 'eth_call' ||
    request.params?.length !== 2 ||
    Object.keys(request.params[0] ?? {})
      .sort()
      .join(',') !== 'data,from,to' ||
    request.params[0].from !== identity.holder ||
    request.params[0].to !== target ||
    request.params[0].data !== data ||
    Object.keys(request.params[1] ?? {})
      .sort()
      .join(',') !== 'blockHash,requireCanonical' ||
    request.params[1].blockHash !== identity.blockHash ||
    request.params[1].requireCanonical !== true ||
    !(typeof request.id === 'string' || Number.isSafeInteger(request.id)) ||
    response?.jsonrpc !== '2.0' ||
    response.id !== request.id
  )
    fail('raw_envelope_invalid')
  if (outcome === 'success') {
    if (Object.hasOwn(response, 'error') || !Object.hasOwn(response, 'result'))
      fail('raw_response_invalid')
    return response.result
  }
  if (
    Object.hasOwn(response, 'result') ||
    !Number.isSafeInteger(response.error?.code) ||
    !/\b(?:execution reverted|revert(?:ed)?)\b/i.test(response.error?.message ?? '') ||
    /out of gas|gas required exceeds allowance|exceeds block gas|intrinsic gas|gas limit/i.test(
      response.error.message,
    )
  )
    fail('raw_revert_invalid')
  return null
}
function scalar(rpc, identity, target, data) {
  const value = result(rpc, identity, target, data)
  if (!WORD.test(value ?? '')) fail('result_word_invalid')
  const decoded = BigInt(value)
  if (rpc.decodedRaw !== decoded.toString()) fail('decoded_mutation')
  return decoded
}
/** Original GHO Q is fixed; only the required shares are recalculated at this block. */
export function validateUmbrellaGhoProof({ proof, ...identity }) {
  const route = UMBRELLA_GHO_ROUTE,
    q = raw(identity.assetsRaw)
  if (
    q === 0n ||
    identity.routeKey !== route.routeKey ||
    identity.destination !== route.destination ||
    identity.asset !== route.asset ||
    proof?.schema !== 'carry_exit_v2_proof_v1' ||
    proof.purpose !== 'call' ||
    proof.sharesRaw !== undefined ||
    proof.chainId !== '1' ||
    proof.coverageKind !== 'shares' ||
    proof.caller !== identity.holder ||
    !['success', 'evm_revert'].includes(proof.simulationStatus) ||
    ['routeKey', 'destination', 'asset', 'holder', 'assetsRaw', 'blockNumber', 'blockHash'].some(
      (k) => proof[k] !== identity[k],
    )
  )
    fail('identity_mismatch')
  const balance = scalar(
    proof.holderCoverageRpc,
    identity,
    route.destination,
    `0x70a08231${identity.holder.slice(2).padStart(64, '0')}`,
  )
  const required = scalar(
    proof.requiredCoverageRpc,
    identity,
    route.destination,
    umbrellaGhoCalldata('previewWithdraw', [q]),
  )
  if (required === 0n) fail('amount_unconvertible')
  const state = {}
  for (const call of umbrellaGhoStateCalls(identity.holder, required, balance)) {
    if (call.field === 'stakerCooldownRpc') {
      const bytes = result(proof[call.field], identity, call.target, call.data)
      if (!/^0x[0-9a-f]{192}$/.test(bytes ?? '')) fail('snapshot_invalid')
      state.snapshot = [0, 1, 2].map((i) => BigInt(`0x${bytes.slice(2 + i * 64, 66 + i * 64)}`))
      if (
        JSON.stringify(proof[call.field].decodedRaw) !== JSON.stringify(state.snapshot.map(String))
      )
        fail('decoded_mutation')
    } else state[call.field] = scalar(proof[call.field], identity, call.target, call.data)
  }
  const [coveredShares, end, window] = state.snapshot
  const blockSeconds = BigInt(proof.blockTimestampSeconds)
  if (
    !/^[1-9][0-9]*$/.test(proof.blockTimestampSeconds ?? '') ||
    state.pausedRpc > 1n ||
    coveredShares >= 1n << 192n ||
    end >= 1n << 32n ||
    window >= 1n << 32n ||
    state.cooldownRpc >= 1n << 32n ||
    state.unstakeWindowRpc >= 1n << 32n ||
    state.assetDecimalsRpc !== 18n ||
    state.shareDecimalsRpc !== 18n ||
    state.maxRedeemRpc > balance ||
    (blockSeconds <= end + window && coveredShares > balance)
  )
    fail('state_invalid')
  const inWindow =
    coveredShares > 0n && end > 0n && blockSeconds >= end && blockSeconds <= end + window
  if (
    state.maxRedeemRpc !== (inWindow ? coveredShares : 0n) &&
    !(state.pausedRpc === 1n && state.maxRedeemRpc === 0n)
  )
    fail('max_redeem_mismatch')
  const gate =
    state.pausedRpc === 1n
      ? 'paused'
      : balance === 0n
        ? 'no_shares'
        : coveredShares === 0n || end === 0n
          ? 'cooldown_not_started'
          : blockSeconds < end
            ? 'waiting'
            : blockSeconds > end + window
              ? 'window_expired'
              : required > balance ||
                  required > coveredShares ||
                  required > state.maxRedeemRpc ||
                  state.previewRedeemRpc < q
                ? 'insufficient_covered_q'
                : 'window_open'
  const payout = result(
    proof.withdrawRpc,
    identity,
    route.destination,
    umbrellaGhoCalldata('redeem', [required, identity.holder, identity.holder]),
    proof.simulationStatus,
  )
  let consumed = null,
    payoutRaw = null
  if (proof.simulationStatus === 'success') {
    if (!WORD.test(payout ?? '')) fail('payout_invalid')
    payoutRaw = BigInt(payout)
    if (gate !== 'window_open' || payoutRaw < q || state.previewRedeemRpc < q)
      fail('payout_q_mismatch')
    consumed = required.toString()
  }
  if (
    proof.holderCoverageRaw !== balance.toString() ||
    proof.requiredCoverageRaw !== required.toString() ||
    proof.actualConsumedRaw !== consumed ||
    proof.withdrawRpc.decodedConsumedRaw !== consumed ||
    proof.withdrawRpc.decodedAssetsRaw !== (payoutRaw === null ? null : payoutRaw.toString())
  )
    fail('decoded_mutation')
  return {
    routeKind: route.kind,
    holderCoverageRaw: balance.toString(),
    requiredCoverageRaw: required.toString(),
    actualConsumedRaw: consumed,
    simulationStatus: proof.simulationStatus,
    coveredRevert: proof.simulationStatus === 'evm_revert' && gate === 'window_open',
    gate,
    holderClaimRaw: state.holderClaimRpc.toString(),
    payoutAssetsRaw: payoutRaw?.toString() ?? null,
    slashableAssetsRaw: state.slashableAssetsRpc.toString(),
    cooldownSeconds: state.cooldownRpc.toString(),
    unstakeWindowSeconds: state.unstakeWindowRpc.toString(),
    cooldownEndSeconds: end.toString(),
    windowEndInclusiveSeconds: (end + window).toString(),
    projection: 'conditional_mechanical_gate_if_snapshot_unchanged',
    minedPayoutProven: false,
  }
}
