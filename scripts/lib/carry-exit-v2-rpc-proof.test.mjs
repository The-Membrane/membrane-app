import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  resolveCarryExitV2Route,
  validateCarryExitV2RpcProof,
} from './carry-exit-v2-rpc-proof.mjs'

const holder = '0x1111111111111111111111111111111111111111'
const token = '0x5555555555555555555555555555555555555555'
const blockHash = `0x${'a'.repeat(64)}`
const blockNumber = '26086000'
const word = (n) => BigInt(n).toString(16).padStart(64, '0')
const addressWord = (address) => address.slice(2).padStart(64, '0')

function rpc(target, data, result, id) {
  return {
    provider: 'test-provider',
    source: 'test-source',
    callTarget: target,
    request: {
      jsonrpc: '2.0',
      id,
      method: 'eth_call',
      params: [
        { from: holder, to: target, data },
        { blockHash, requireCanonical: true },
      ],
    },
    response: { jsonrpc: '2.0', id, result },
  }
}

function fixture(
  kind,
  { balance = 120n, required = 80n, q = 100n, consumed = 70n, status = 'success' } = {},
) {
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.kind === kind)
  assert.ok(route, `pinned ${kind} route exists`)
  const { destination, asset, routeKey } = route
  const isVault = ['morpho', 'susds', 'usd3', 'stusds', 'fluid', 'sgho'].includes(kind)
  const isPool = kind === 'aave' || kind === 'spark'
  const holderCoverageRpc = rpc(
    route.holderCoverageTarget,
    `0x70a08231${addressWord(holder)}`,
    `0x${word(balance)}`,
    1,
  )
  holderCoverageRpc.decodedRaw = balance.toString()
  const requiredCoverageRpc = isVault
    ? rpc(
        destination,
        `${kind === 'morpho' ? '0x4cdad506' : '0x0a28a477'}${word(kind === 'morpho' ? balance : q)}`,
        `0x${word(required)}`,
        2,
      )
    : null
  if (requiredCoverageRpc) requiredCoverageRpc.decodedRaw = required.toString()
  const data = isVault
    ? `0xb460af94${word(q)}${addressWord(holder)}${addressWord(holder)}`
    : isPool
      ? `0x69328dec${addressWord(asset)}${word(q)}${addressWord(holder)}`
      : `0xf3fef3a3${addressWord(asset)}${word(q)}`
  const withdrawRpc = rpc(
    route.withdrawTarget,
    data,
    isVault ? `0x${word(consumed)}` : isPool ? `0x${word(q)}` : '0x',
    3,
  )
  if (status === 'evm_revert') {
    delete withdrawRpc.response.result
    withdrawRpc.response.error = { code: 3, message: 'execution reverted: liquidity' }
  }
  withdrawRpc.decodedAssetsRaw = q.toString()
  withdrawRpc.decodedConsumedRaw = status === 'success' && isVault ? consumed.toString() : null
  const proof = {
    schema: 'carry_exit_v2_proof_v1',
    purpose: 'call',
    chainId: '1',
    routeKey,
    destination,
    asset,
    holder,
    caller: holder,
    assetsRaw: q.toString(),
    blockNumber,
    blockHash,
    coverageKind: kind === 'morpho' ? 'morpho_shares_claim' : isVault ? 'shares' : 'assets',
    holderCoverageRaw: balance.toString(),
    requiredCoverageRaw: isVault ? required.toString() : q.toString(),
    actualConsumedRaw: status === 'success' && isVault ? consumed.toString() : null,
    simulationStatus: status,
    holderCoverageRpc,
    requiredCoverageRpc,
    withdrawRpc,
  }
  return {
    proof,
    routeKey,
    destination,
    asset,
    holder,
    assetsRaw: q.toString(),
    blockNumber,
    blockHash,
  }
}

test('all supported route classes decode exact raw successful responses', () => {
  for (const kind of [
    'morpho',
    'susds',
    'usd3',
    'stusds',
    'fluid',
    'sgho',
    'aave',
    'spark',
    'comet',
  ]) {
    const result = validateCarryExitV2RpcProof(fixture(kind))
    assert.equal(result.simulationStatus, 'success')
    assert.equal(
      result.actualConsumedRaw,
      ['morpho', 'susds', 'usd3', 'stusds', 'fluid', 'sgho'].includes(kind) ? '70' : null,
    )
  }
})

test('route resolver returns immutable code-owned targets and rejects unknown identity', () => {
  const pinned = CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.kind === 'aave')
  assert.equal(resolveCarryExitV2Route(pinned.routeKey, pinned.destination, pinned.asset), pinned)
  assert.equal(Object.isFrozen(pinned), true)
  assert.throws(() => resolveCarryExitV2Route(pinned.routeKey, token, pinned.asset))
  const usd3 = CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.kind === 'usd3')
  assert.equal(
    resolveCarryExitV2Route(usd3.routeKey, usd3.destination, usd3.asset).implementation,
    '0xd1f1c3f485063712873285bf4ef25ab068f13893',
  )
  const sgho = CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.kind === 'sgho')
  assert.equal(sgho.routeKey, 'GHO → sGho [GHO]')
  assert.equal(sgho.destination, '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d')
  assert.equal(sgho.asset, '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f')
  assert.throws(() => resolveCarryExitV2Route('USDe → sGho [GHO]', sgho.destination, sgho.asset))
})

test('Morpho covered revert uses previewRedeem of all shares as assets', () => {
  const covered = validateCarryExitV2RpcProof(
    fixture('morpho', {
      status: 'evm_revert',
      balance: 80n,
      required: 110n,
    }),
  )
  assert.equal(covered.coveredRevert, true)
  assert.deepEqual(
    [
      covered.holderSharesRaw,
      covered.previewRedeemAssetsRaw,
      covered.requiredAssetsRaw,
      covered.sharesBurnedRaw,
    ],
    ['80', '110', '100', null],
  )
  assert.equal(
    validateCarryExitV2RpcProof(
      fixture('morpho', {
        status: 'evm_revert',
        balance: 80n,
        required: 99n,
      }),
    ).coveredRevert,
    false,
  )
})

test('other vaults use previewWithdraw shares; direct routes use token balance', () => {
  assert.equal(
    validateCarryExitV2RpcProof(
      fixture('fluid', {
        status: 'evm_revert',
        required: 120n,
        balance: 120n,
      }),
    ).coveredRevert,
    true,
  )
  assert.equal(
    validateCarryExitV2RpcProof(
      fixture('fluid', {
        status: 'evm_revert',
        required: 121n,
        balance: 120n,
      }),
    ).coveredRevert,
    false,
  )
  assert.equal(
    validateCarryExitV2RpcProof(
      fixture('aave', {
        status: 'evm_revert',
        balance: 99n,
      }),
    ).coveredRevert,
    false,
  )
  assert.equal(
    validateCarryExitV2RpcProof(
      fixture('comet', {
        status: 'evm_revert',
        balance: 100n,
      }),
    ).coveredRevert,
    true,
  )
})

test('rejects mismatched route, target, caller, calldata, block and response id', () => {
  for (const change of [
    (x) => {
      x.routeKey = 'missing'
    },
    (x) => {
      x.proof.withdrawRpc.callTarget = token
    },
    (x) => {
      x.proof.withdrawRpc.request.params[0].from = token
    },
    (x) => {
      x.proof.withdrawRpc.request.params[0].data += '00'
    },
    (x) => {
      x.proof.withdrawRpc.request.params[1].blockHash = `0x${'b'.repeat(64)}`
    },
    (x) => {
      x.proof.withdrawRpc.request.params[1].requireCanonical = false
    },
    (x) => {
      x.proof.withdrawRpc.response.id = 9
    },
    (x) => {
      x.proof.holderCoverageRpc.request.params[0].to = token
    },
    (x) => {
      x.proof.requiredCoverageRpc.request.params[0].data = `0x0a28a477${word(99)}`
    },
    (x) => {
      x.proof.blockNumber = '26086001'
    },
    (x) => {
      x.proof.withdrawRpc.provider = ''
    },
    (x) => {
      x.proof.withdrawRpc.source = 'x'.repeat(161)
    },
    (x) => {
      x.proof.withdrawRpc.request.params[0].value = '0x1'
    },
    (x) => {
      x.proof.withdrawRpc.request.params[0].gas = '0x5208'
    },
    (x) => {
      x.proof.withdrawRpc.request.params[1].blockNumber = '0x1'
    },
    (x) => {
      x.routeKey = 'attacker'
      x.proof.routeKey = 'attacker'
      x.manifest = [
        {
          kind: 'morpho',
          routeKey: x.routeKey,
          destination: x.destination,
          asset: x.asset,
          withdrawTarget: token,
          holderCoverageTarget: token,
          requiredCoverageTarget: token,
        },
      ]
    },
  ]) {
    const input = fixture('morpho')
    change(input)
    assert.throws(() => validateCarryExitV2RpcProof(input))
  }
})

test('rejects false decoded amounts and invalid success outputs', () => {
  for (const change of [
    (x) => {
      x.proof.holderCoverageRpc.decodedRaw = '999'
    },
    (x) => {
      x.proof.requiredCoverageRpc.decodedRaw = '999'
    },
    (x) => {
      x.proof.withdrawRpc.decodedConsumedRaw = '999'
    },
    (x) => {
      x.proof.withdrawRpc.response.result = '0x'
    },
    (x) => {
      x.proof.withdrawRpc.response.result = `0x${word(0)}`
    },
    (x) => {
      x.proof.withdrawRpc.response.result = `0x${word(121)}`
    },
  ]) {
    const input = fixture('morpho')
    change(input)
    assert.throws(() => validateCarryExitV2RpcProof(input))
  }
  const poolInput = fixture('spark')
  poolInput.proof.withdrawRpc.response.result = `0x${word(99)}`
  assert.throws(() => validateCarryExitV2RpcProof(poolInput))
  const cometInput = fixture('comet')
  cometInput.proof.withdrawRpc.response.result = `0x${word(100)}`
  assert.throws(() => validateCarryExitV2RpcProof(cometInput))
})

test('a claimed revert requires a raw JSON-RPC execution error', () => {
  for (const change of [
    (x) => {
      delete x.proof.withdrawRpc.response.error
    },
    (x) => {
      x.proof.withdrawRpc.response.result = '0x'
    },
    (x) => {
      x.proof.withdrawRpc.response.error.message = 'request timed out'
    },
    (x) => {
      x.proof.withdrawRpc.response.error.message = 'execution reverted: out of gas'
    },
  ]) {
    const input = fixture('aave', { status: 'evm_revert' })
    change(input)
    assert.throws(() => validateCarryExitV2RpcProof(input))
  }
})
