import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem'
import {
  AAVE_CORE_POOL_CONFIGURATOR,
  classifyAaveDirectConfiguratorAction,
} from './aave-direct-configurator-intent.mjs'

const ASSET = '0x1111111111111111111111111111111111111111'
const BLOCK = `0x${'2'.repeat(64)}`
const CODE_SHA = `0x${'3'.repeat(64)}`
const signature = 'setSupplyCap(address,uint256)'
const abi = parseAbi([`function ${signature}`])
const base = {
  target: AAVE_CORE_POOL_CONFIGURATOR,
  observationBlockHash: BLOCK,
  lifecycle: 'queued',
  withDelegateCall: false,
  value: '0',
  signature,
  callData: encodeAbiParameters(abi[0].inputs, [ASSET, 200n]),
}
const context = {
  verifiedTargetCode: {
    verified: true,
    chainId: 1,
    target: AAVE_CORE_POOL_CONFIGURATOR,
    blockHash: BLOCK,
    codeSha256: CODE_SHA,
  },
  recognizedReserve: { verified: true, asset: ASSET, blockHash: BLOCK },
  verifiedPriorValue: {
    verified: true,
    kind: 'supply_cap',
    asset: ASSET,
    blockHash: BLOCK,
    value: '100',
  },
}

test('Governance V3 signature calldata is ABI arguments; empty signature uses full calldata', () => {
  const partial = classifyAaveDirectConfiguratorAction(base)
  assert.equal(partial.status, 'candidate')
  assert.equal(partial.direction, 'unknown')
  assert.equal(partial.proposedValue, '200')
  assert.equal(partial.alertEligible, false)
  const full = classifyAaveDirectConfiguratorAction(
    {
      ...base,
      signature: '',
      callData: encodeFunctionData({ abi, functionName: 'setSupplyCap', args: [ASSET, 200n] }),
    },
    context,
  )
  assert.equal(full.status, 'candidate')
  assert.equal(full.context, 'caller_attested_same_block')
  assert.equal(full.direction, 'increase')
})

test('malformed and noncanonical calldata fail closed under each signature mode', () => {
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, callData: '0x01' }).status,
    'unknown',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, callData: `${base.callData}00` }).reason,
    'noncanonical_calldata',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, signature: '', callData: base.callData })
      .status,
    'unknown',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({
      ...base,
      callData: encodeFunctionData({ abi, functionName: 'setSupplyCap', args: [ASSET, 200n] }),
    }).status,
    'unknown',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, signature: 'setBorrowCap(address,uint256)' })
      .status,
    'candidate',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({
      ...base,
      signature: 'setSupplyCap(address,uint256)',
      callData: `0x${'ff'.repeat(64)}`,
    }).status,
    'unknown',
  )
})

test('only direct zero-value calls to the exact Core Configurator are candidates', () => {
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, target: ASSET }).reason,
    'unrecognized_target',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, withDelegateCall: true }).reason,
    'delegatecall_or_missing_flag',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, withDelegateCall: undefined }).reason,
    'delegatecall_or_missing_flag',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, value: '1' }).reason,
    'nonzero_value',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, value: undefined }).reason,
    'malformed_value',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, value: false }).reason,
    'malformed_value',
  )
})

test('unverified code, unknown reserve, or missing prior cannot provide cap direction', () => {
  assert.equal(
    classifyAaveDirectConfiguratorAction(
      { ...base, observationBlockHash: `0x${'5'.repeat(64)}` },
      context,
    ).direction,
    'unknown',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction({ ...base, lifecycle: 'executed' }, context).direction,
    'unknown',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction(base, {
      ...context,
      verifiedTargetCode: { ...context.verifiedTargetCode, verified: false },
    }).direction,
    'unknown',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction(base, {
      ...context,
      recognizedReserve: { ...context.recognizedReserve, asset: AAVE_CORE_POOL_CONFIGURATOR },
    }).direction,
    'unknown',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction(base, {
      ...context,
      verifiedPriorValue: { ...context.verifiedPriorValue, blockHash: `0x${'4'.repeat(64)}` },
    }).direction,
    'unknown',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction(base, {
      ...context,
      verifiedPriorValue: { ...context.verifiedPriorValue, value: '-1' },
    }).direction,
    'unknown',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction(base, {
      ...context,
      verifiedPriorValue: { ...context.verifiedPriorValue, kind: 'borrow_cap' },
    }).direction,
    'unknown',
  )
})

test('cap direction is distinct from executable exit capacity', () => {
  assert.equal(classifyAaveDirectConfiguratorAction(base, context).direction, 'increase')
  assert.equal(
    classifyAaveDirectConfiguratorAction(
      { ...base, callData: encodeAbiParameters(abi[0].inputs, [ASSET, 50n]) },
      context,
    ).direction,
    'decrease',
  )
  assert.equal(
    classifyAaveDirectConfiguratorAction(
      { ...base, callData: encodeAbiParameters(abi[0].inputs, [ASSET, 100n]) },
      context,
    ).direction,
    'unchanged',
  )
  const borrow = classifyAaveDirectConfiguratorAction(
    { ...base, signature: 'setBorrowCap(address,uint256)' },
    context,
  )
  assert.equal(borrow.kind, 'borrow_cap')
  assert.equal(borrow.direction, 'unknown')
  assert.equal(borrow.executableExitCapacity, 'not_inferred')
  assert.equal(borrow.alertEligible, false)
})

test('zero means uncapped for both supply and borrow, not a zero ceiling', () => {
  for (const [sig, kind] of [
    ['setSupplyCap(address,uint256)', 'supply_cap'],
    ['setBorrowCap(address,uint256)', 'borrow_cap'],
  ]) {
    const itemAbi = parseAbi([`function ${sig}`])
    const withCap = (value) => ({
      ...base,
      signature: sig,
      callData: encodeAbiParameters(itemAbi[0].inputs, [ASSET, value]),
    })
    const withPrior = (value) => ({
      ...context,
      verifiedPriorValue: { ...context.verifiedPriorValue, kind, value: String(value) },
    })
    const removal = classifyAaveDirectConfiguratorAction(withCap(0n), withPrior(100n))
    assert.equal(removal.direction, 'increase')
    assert.equal(removal.capTransition, 'removed')
    const introduction = classifyAaveDirectConfiguratorAction(withCap(100n), withPrior(0n))
    assert.equal(introduction.direction, 'decrease')
    assert.equal(introduction.capTransition, 'introduced')
    assert.equal(removal.alertEligible, false)
    assert.equal(introduction.executableExitCapacity, 'not_inferred')
  }
})

test('reference-code cap limits are warnings without implementation proof; zero reserve is unknown', () => {
  for (const sig of ['setSupplyCap(address,uint256)', 'setBorrowCap(address,uint256)']) {
    const itemAbi = parseAbi([`function ${sig}`])
    const overLimit = classifyAaveDirectConfiguratorAction(
      {
        ...base,
        signature: sig,
        callData: encodeAbiParameters(itemAbi[0].inputs, [ASSET, 1n << 36n]),
      },
      {
        ...context,
        verifiedPriorValue: {
          ...context.verifiedPriorValue,
          kind: sig.startsWith('setSupply') ? 'supply_cap' : 'borrow_cap',
        },
      },
    )
    assert.equal(overLimit.status, 'candidate')
    assert.equal(overLimit.referenceCodeWarning, 'cap_exceeds_v3_origin_limit')
    assert.equal(overLimit.direction, 'unknown')
    assert.equal(
      classifyAaveDirectConfiguratorAction({
        ...base,
        signature: sig,
        callData: encodeAbiParameters(itemAbi[0].inputs, [
          '0x0000000000000000000000000000000000000000',
          1n,
        ]),
      }).reason,
      'zero_reserve_address',
    )
  }
})

test('unpause grace is liquidation-only and reference limits do not erase candidates', () => {
  const pauseSig = 'setReservePause(address,bool,uint40)'
  const pauseAbi = parseAbi([`function ${pauseSig}`])
  const action = (paused, grace) => ({
    ...base,
    signature: pauseSig,
    callData: encodeAbiParameters(pauseAbi[0].inputs, [ASSET, paused, grace]),
  })
  const overGrace = classifyAaveDirectConfiguratorAction(action(false, 14_401n))
  assert.equal(overGrace.status, 'candidate')
  assert.equal(overGrace.referenceCodeWarning, 'unpause_grace_exceeds_v3_origin_limit')
  const unpause = classifyAaveDirectConfiguratorAction(action(false, 14_400n), context)
  assert.equal(unpause.liquidationGracePeriodSeconds, '14400')
  assert.equal(unpause.withdrawalImpact, 'not_inferred')
  const pause = classifyAaveDirectConfiguratorAction(action(true, 14_401n), context)
  assert.equal(pause.status, 'candidate')
  assert.equal(pause.liquidationGracePeriodSeconds, undefined)
  const freezeSig = 'setReserveFreeze(address,bool)'
  const freezeAbi = parseAbi([`function ${freezeSig}`])
  const freeze = {
    ...base,
    signature: freezeSig,
    callData: encodeAbiParameters(freezeAbi[0].inputs, [ASSET, true]),
  }
  const unchangedFreeze = classifyAaveDirectConfiguratorAction(freeze, {
    ...context,
    verifiedPriorFreeze: { verified: true, asset: ASSET, blockHash: BLOCK, value: true },
  })
  assert.equal(unchangedFreeze.status, 'candidate')
  assert.equal(unchangedFreeze.referenceCodeWarning, 'unchanged_freeze_reverts_in_v3_origin')
  assert.equal(classifyAaveDirectConfiguratorAction(freeze, context).status, 'candidate')
})

test('freeze and pause are separate candidates without quantified withdrawal semantics', () => {
  for (const [sig, args, kind] of [
    ['setReserveFreeze(address,bool)', [ASSET, true], 'reserve_freeze'],
    ['setReservePause(address,bool)', [ASSET, true], 'reserve_pause'],
    [
      'setReservePause(address,bool,uint40)',
      [ASSET, true, 3600n],
      'reserve_pause_with_grace_period',
    ],
  ]) {
    const itemAbi = parseAbi([`function ${sig}`])
    const result = classifyAaveDirectConfiguratorAction(
      {
        ...base,
        signature: sig,
        callData: encodeAbiParameters(itemAbi[0].inputs, args),
      },
      context,
    )
    assert.equal(result.kind, kind)
    assert.equal(result.proposedValue, true)
    assert.equal(result.withdrawalImpact, 'not_inferred')
    assert.equal(result.executableExitCapacity, 'not_inferred')
    assert.equal(result.alertEligible, false)
  }
})
