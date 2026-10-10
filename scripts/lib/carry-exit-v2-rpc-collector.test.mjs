import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'
import {
  CarryExitV2RpcCollectionError,
  collectCarryExitV2RpcProof,
} from './carry-exit-v2-rpc-collector.mjs'

const holder = `0x${'1'.repeat(40)}`
const hash = (digit) => `0x${digit.repeat(64)}`
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const route = (kind) => CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.kind === kind)
const exitCalls = (calls) =>
  calls.filter(
    (request) =>
      request.method === 'eth_call' &&
      ['0x70a08231', '0x0a28a477', '0x4cdad506', '0xb460af94', '0x69328dec', '0xf3fef3a3'].includes(
        request.params[0].data.slice(0, 10),
      ),
  )
const code = (wanted, stage) => (error) =>
  error instanceof CarryExitV2RpcCollectionError && error.code === wanted && error.stage === stage

function fixture(kind = 'susds', options = {}) {
  const chosen = route(kind)
  assert(chosen, `missing checked-in ${kind} route`)
  const target = {
    targetBlock: '400',
    targetHash: hash('c'),
    targetBlockAt: '2026-09-30T00:00:12.000Z',
    targetParentBlock: '399',
    targetParentHash: hash('b'),
    parentHeaderHash: hash('b'),
    targetParentBlockAt: '2026-09-30T00:00:00.000Z',
    targetObservedAt: '2026-09-30T00:00:15.000Z',
    canonicalityEvidenceDoc: {
      schema: 'carry_exit_v2_headers_v1',
      chainId: '1',
      finalityTag: 'finalized',
      targetAt: '2026-09-30T00:00:00.000001Z',
      observedAt: '2026-09-30T00:00:15.000Z',
      targetHeader: {
        number: '400',
        hash: hash('c'),
        parentHash: hash('b'),
        timestamp: '2026-09-30T00:00:12.000Z',
      },
      parentHeader: { number: '399', hash: hash('b'), timestamp: '2026-09-30T00:00:00.000Z' },
      finalizedHead: { number: '402', hash: hash('d') },
    },
  }
  const calls = []
  const send = async (request) => {
    calls.push(request)
    if (options.throwAt === calls.length) throw new Error('network failed')
    if (request.method === 'eth_getCode') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: request.params[0] === holder ? '0x' : '0x6001',
      }
    }
    if (request.method === 'eth_getStorageAt') {
      return { jsonrpc: '2.0', id: request.id, result: word(BigInt(chosen.implementation)) }
    }
    const selector = request.params[0].data.slice(0, 10)
    let result
    if (['0x38d52e0f', '0xb16a19de', '0xc55dae63'].includes(selector)) {
      result = word(BigInt(options.identityAsset ?? chosen.asset))
    } else if (selector === '0x35ea6a75') {
      const fields = Array.from({ length: 15 }, (_, index) =>
        word(index === 8 ? BigInt(options.reserveAToken ?? chosen.destination) : 0n).slice(2),
      )
      result = `0x${fields.join('')}`
    } else if (selector === '0x70a08231') result = word(options.balance ?? 2_000_000)
    else if (selector === '0x0a28a477' || selector === '0x4cdad506')
      result = word(options.preview ?? 1_200_000)
    else if (options.withdrawError) {
      return { jsonrpc: '2.0', id: request.id, error: options.withdrawError }
    } else if (kind === 'comet') result = '0x'
    else if (kind === 'aave' || kind === 'spark') result = word(1_000_000)
    else result = word(options.burn ?? 1_000_000)
    return { jsonrpc: '2.0', id: request.id, result }
  }
  const args = {
    routeKey: chosen.routeKey,
    destination: chosen.destination,
    asset: chosen.asset,
    holder,
    assetsRaw: '1000000',
    target,
    provider: 'test-rpc',
    source: 'test-collector',
    send,
    now: () => new Date('2026-09-30T00:00:20.000Z'),
  }
  return { args, calls, chosen }
}

test('collects three exact ERC-4626 calls at the EIP-1898 block hash', async () => {
  const { args, calls } = fixture('susds')
  const result = await collectCarryExitV2RpcProof(args)
  const exit = exitCalls(calls)
  assert.equal(result.status, 'raw_rpc_collected')
  assert.equal(result.routeKind, 'susds')
  assert.equal(result.proof.simulationStatus, 'success')
  assert.equal(result.proof.actualConsumedRaw, '1000000')
  assert.equal(result.proof.holderCoverageRpc.decodedRaw, '2000000')
  assert.equal(result.proof.requiredCoverageRpc.decodedRaw, '1200000')
  assert.equal(result.proof.coveredRevert, undefined)
  assert.equal(exit.length, 3)
  for (const request of exit) {
    assert.equal(request.method, 'eth_call')
    assert.deepEqual(request.params[1], { blockHash: hash('c'), requireCanonical: true })
    assert.equal(request.params[0].from, holder)
  }
  assert.equal(exit[2].params[0].to, args.destination)
  assert.equal(exit[2].params[0].data.slice(0, 10), '0xb460af94')
  assert.equal(
    result.identityEvidence.checks.find((row) => row.stage === 'vault_asset').decodedAddress,
    args.asset,
  )
  assert.equal(result.identityEvidence.holder, holder)
  assert.equal(result.identityEvidence.blockNumber, '400')
})

test('sGHO captures GHO identity and exact ERC-4626 preview/withdraw calls', async () => {
  const { args, calls, chosen } = fixture('sgho')
  const result = await collectCarryExitV2RpcProof(args)
  assert.equal(result.routeKind, 'sgho')
  assert.equal(result.proof.asset, chosen.asset)
  assert.deepEqual(
    exitCalls(calls).map((request) => request.params[0].data.slice(0, 10)),
    ['0x70a08231', '0x0a28a477', '0xb460af94'],
  )
  assert.equal(result.proof.coverageKind, 'shares')
})

test('Morpho previewRedeem uses actual holder shares, then exact frozen Q withdrawal', async () => {
  const { args, calls } = fixture('morpho', { balance: 2_345_678, preview: 1_400_000 })
  const result = await collectCarryExitV2RpcProof(args)
  const exit = exitCalls(calls)
  assert.equal(result.proof.coverageKind, 'morpho_shares_claim')
  assert.equal(exit[1].params[0].data, `0x4cdad506${word(2_345_678).slice(2)}`)
  assert.equal(result.proof.requiredCoverageRaw, '1400000')
  assert.equal(result.proof.assetsRaw, '1000000')
})

test('Aave holder balance uses aToken while exact withdrawal uses frozen Pool', async () => {
  const { args, calls, chosen } = fixture('aave')
  const result = await collectCarryExitV2RpcProof(args)
  const exit = exitCalls(calls)
  assert.equal(exit.length, 2)
  assert.equal(exit[0].params[0].to, chosen.holderCoverageTarget)
  assert.equal(exit[1].params[0].to, chosen.withdrawTarget)
  assert.notEqual(chosen.withdrawTarget, chosen.destination)
  assert.equal(exit[1].params[0].data.slice(0, 10), '0x69328dec')
  assert.equal(result.proof.requiredCoverageRpc, null)
  assert.equal(result.proof.requiredCoverageRaw, '1000000')
})

test('Spark holder balance also uses aToken while withdrawal uses pinned Pool', async () => {
  const { args, calls, chosen } = fixture('spark')
  await collectCarryExitV2RpcProof(args)
  const exit = exitCalls(calls)
  assert.equal(exit[0].params[0].to, chosen.destination)
  assert.equal(exit[1].params[0].to, chosen.withdrawTarget)
  assert.notEqual(chosen.withdrawTarget, chosen.destination)
})

test('Compound Comet uses its exact withdraw selector and empty successful return', async () => {
  const { args, calls } = fixture('comet')
  const result = await collectCarryExitV2RpcProof(args)
  const exit = exitCalls(calls)
  assert.equal(exit.length, 2)
  assert.equal(exit[1].params[0].data.slice(0, 10), '0xf3fef3a3')
  assert.equal(result.proof.withdrawRpc.response.result, '0x')
  assert.equal(result.proof.simulationStatus, 'success')
})

test('USD3 requires pinned EIP-1967 implementation slot and live implementation code', async () => {
  const { args, chosen } = fixture('usd3')
  const result = await collectCarryExitV2RpcProof(args)
  assert.equal(result.identityEvidence.blockNumber, '400')
  assert.equal(
    result.identityEvidence.checks.find((row) => row.stage === 'usd3_implementation')
      .decodedAddress,
    chosen.implementation,
  )
  assert(
    result.identityEvidence.checks.some(
      (row) => row.stage === 'usd3_implementation_code' && row.codeBytes > 0,
    ),
  )
})

test('execution revert is captured raw without declaring a covered restriction', async () => {
  const { args } = fixture('susds', {
    withdrawError: { code: 3, message: 'execution reverted: paused' },
  })
  const result = await collectCarryExitV2RpcProof(args)
  assert.equal(result.proof.simulationStatus, 'evm_revert')
  assert.equal(result.proof.actualConsumedRaw, null)
  assert.equal(result.proof.coveredRevert, undefined)
  assert.deepEqual(result.proof.withdrawRpc.response.error, {
    code: 3,
    message: 'execution reverted: paused',
  })
})

test('transport failure and provider failure cannot become exit outcomes', async () => {
  const transport = fixture('susds', { throwAt: 1 })
  await assert.rejects(
    collectCarryExitV2RpcProof(transport.args),
    code('transport_failure', 'holder_eoa'),
  )
  const provider = fixture('susds', {
    withdrawError: { code: -32000, message: 'missing trie node' },
  })
  await assert.rejects(
    collectCarryExitV2RpcProof(provider.args),
    code('provider_failure', 'withdraw'),
  )
})

test('unknown route and unverified target are refused before RPC', async () => {
  const unknown = fixture()
  unknown.args.destination = `0x${'f'.repeat(40)}`
  await assert.rejects(collectCarryExitV2RpcProof(unknown.args))
  assert.equal(unknown.calls.length, 0)
  const badTarget = fixture()
  badTarget.args.target.canonicalityEvidenceDoc.finalityTag = 'latest'
  await assert.rejects(
    collectCarryExitV2RpcProof(badTarget.args),
    code('audited_target_invalid', 'input'),
  )
  assert.equal(badTarget.calls.length, 0)
})

test('malformed provider output is refused rather than treated as a successful call', async () => {
  const { args } = fixture()
  args.send = async (request) => ({ jsonrpc: '2.0', id: request.id, result: '0x' })
  await assert.rejects(
    collectCarryExitV2RpcProof(args),
    code('identity_code_missing', 'destination_code'),
  )
})

test('bounded transport and proof sizes fail before a stored score can be prepared', async () => {
  const timeout = fixture()
  timeout.args.timeoutMs = 1
  timeout.args.send = () => new Promise(() => {})
  await assert.rejects(
    collectCarryExitV2RpcProof(timeout.args),
    code('transport_timeout', 'holder_eoa'),
  )
  const huge = fixture()
  const originalSend = huge.args.send
  huge.args.send = async (request) => ({
    ...(await originalSend(request)),
    pad: 'x'.repeat(12_000),
  })
  await assert.rejects(
    collectCarryExitV2RpcProof(huge.args),
    code('proof_too_large', 'verification'),
  )
})

test('a target parent timestamp after the DB target fails before any RPC', async () => {
  const bad = fixture()
  bad.args.target.targetParentBlockAt = '2026-09-30T00:00:01.000Z'
  bad.args.target.canonicalityEvidenceDoc.parentHeader.timestamp = '2026-09-30T00:00:01.000Z'
  await assert.rejects(
    collectCarryExitV2RpcProof(bad.args),
    code('audited_target_invalid', 'input'),
  )
  assert.equal(bad.calls.length, 0)
})

test('noncanonical ABI address word and mismatched Pool reserve fail identity checks', async () => {
  const badWord = fixture('susds')
  const originalSend = badWord.args.send
  badWord.args.send = async (request) =>
    request.method === 'eth_call' && request.params[0].data === '0x38d52e0f'
      ? {
          jsonrpc: '2.0',
          id: request.id,
          result: `0x${'f'.repeat(24)}${badWord.args.asset.slice(2)}`,
        }
      : originalSend(request)
  await assert.rejects(
    collectCarryExitV2RpcProof(badWord.args),
    code('identity_result_invalid', 'vault_asset'),
  )
  const reserve = fixture('aave', { reserveAToken: `0x${'f'.repeat(40)}` })
  await assert.rejects(
    collectCarryExitV2RpcProof(reserve.args),
    code('reserve_atoken_mismatch', 'pool_reserve'),
  )
})

test('contract holder and wrong vault asset fail before withdrawal simulation', async () => {
  const contract = fixture('susds')
  const originalSend = contract.args.send
  contract.args.send = async (request) =>
    request.method === 'eth_getCode' && request.params[0] === holder
      ? { jsonrpc: '2.0', id: request.id, result: '0x6001' }
      : originalSend(request)
  await assert.rejects(
    collectCarryExitV2RpcProof(contract.args),
    code('contract_holder_unavailable', 'holder_eoa'),
  )
  const wrongAsset = fixture('susds', { identityAsset: `0x${'f'.repeat(40)}` })
  await assert.rejects(
    collectCarryExitV2RpcProof(wrongAsset.args),
    code('identity_asset_mismatch', 'identity'),
  )
})

test('identity evidence over 32 KiB is rejected without truncating RPC responses', async () => {
  const oversized = fixture('aave')
  const originalSend = oversized.args.send
  oversized.args.send = async (request) => {
    const response = await originalSend(request)
    const selector = request.method === 'eth_call' ? request.params[0].data.slice(0, 10) : null
    return ['0xb16a19de', '0x35ea6a75'].includes(selector)
      ? { ...response, pad: 'x'.repeat(15_300) }
      : response
  }
  await assert.rejects(
    collectCarryExitV2RpcProof(oversized.args),
    code('identity_evidence_too_large', 'identity'),
  )
})

test('combined proof and identity payload must fit the 32 KiB DB evidence bound', async () => {
  const combined = fixture('susds')
  const originalSend = combined.args.send
  combined.args.send = async (request) => {
    const response = await originalSend(request)
    const selector = request.method === 'eth_call' ? request.params[0].data.slice(0, 10) : null
    if (selector === '0x38d52e0f') return { ...response, pad: 'x'.repeat(12_000) }
    if (['0x70a08231', '0x0a28a477', '0xb460af94'].includes(selector))
      return { ...response, pad: 'x'.repeat(7_000) }
    return response
  }
  await assert.rejects(
    collectCarryExitV2RpcProof(combined.args),
    code('combined_evidence_too_large', 'verification'),
  )
})
