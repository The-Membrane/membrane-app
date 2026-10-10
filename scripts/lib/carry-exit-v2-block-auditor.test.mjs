import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ExitV2BlockAuditError,
  exactUtcMicros,
  selectCarryExitV2FirstFinalizedBlock,
} from './carry-exit-v2-block-auditor.mjs'

const hash = (number) => `0x${BigInt(number).toString(16).padStart(64, '0')}`
const stamp = (seconds) => new Date(seconds * 1_000).toISOString()
const makeBlock = (number, seconds, parentHash = hash(number - 1)) => ({
  number: `0x${number.toString(16)}`,
  hash: hash(number),
  parentHash,
  timestamp: `0x${seconds.toString(16)}`,
})

function fixture(seconds = [100, 101, 102, 103, 104], overrides = {}) {
  const blocks = new Map(seconds.map((time, i) => [i + 10, makeBlock(i + 10, time)]))
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (overrides.throwOn && overrides.throwOn(method, params)) throw new Error('provider down')
    if (method === 'eth_chainId') return overrides.chainId ?? '0x1'
    if (method !== 'eth_getBlockByNumber') throw new Error('unexpected method')
    const block =
      params[0] === 'finalized'
        ? blocks.get(overrides.finalized ?? 14)
        : blocks.get(Number(BigInt(params[0])))
    return overrides.overrideBlock?.(method, params, block, calls) ?? block ?? null
  }
  const args = {
    targetAt: stamp(102),
    baselineBlock: '10',
    baselineHash: hash(10),
    provider: 'test-rpc',
    source: 'carry-exit-v2-test',
    request,
    now: () => new Date(stamp(110)),
  }
  return { args, calls }
}

function expectCode(code) {
  return (error) => error instanceof ExitV2BlockAuditError && error.code === code
}

test('selects the equal-timestamp first finalized block and emits DB guard fields', async () => {
  const { args, calls } = fixture()
  const result = await selectCarryExitV2FirstFinalizedBlock(args)
  assert.equal(result.targetBlock, '12')
  assert.equal(result.targetParentBlock, '11')
  assert.equal(result.targetParentHash, hash(11))
  assert.equal(result.parentHeaderHash, hash(11))
  assert.equal(result.targetBlockAt, stamp(102))
  assert.equal(result.canonicalityEvidenceDoc.schema, 'carry_exit_v2_headers_v1')
  assert.equal(result.canonicalityEvidenceDoc.targetAt, stamp(102))
  assert.equal(result.canonicalityEvidenceDoc.finalityTag, 'finalized')
  assert.equal(result.canonicalityEvidenceDoc.targetHeader.parentHash, hash(11))
  assert.equal(result.canonicalityEvidenceDoc.finalizedHead.number, '14')
  assert(
    calls.some(
      ([method, params]) => method === 'eth_getBlockByNumber' && params[0] === 'finalized',
    ),
  )
})

test('selects first block after an exact microsecond target in a timestamp gap', async () => {
  const { args } = fixture([100, 101, 108, 108, 111])
  args.targetAt = '1970-01-01T00:01:48.000001Z'
  args.now = () => new Date(stamp(112))
  const result = await selectCarryExitV2FirstFinalizedBlock(args)
  assert.equal(result.targetBlock, '14')
  assert.equal(result.targetParentBlockAt, stamp(108))
  assert(exactUtcMicros(result.targetParentBlockAt) < exactUtcMicros(args.targetAt))
})

test('selects earliest of multiple blocks with the target timestamp', async () => {
  const { args } = fixture([100, 102, 102, 102, 104])
  const result = await selectCarryExitV2FirstFinalizedBlock(args)
  assert.equal(result.targetBlock, '11')
  assert.equal(result.targetParentBlock, '10')
})

test('does not substitute latest block when due timestamp is not finalized', async () => {
  const { args } = fixture()
  args.targetAt = stamp(105)
  await assert.rejects(
    selectCarryExitV2FirstFinalizedBlock(args),
    expectCode('target_not_finalized'),
  )
})

test('rejects wrong target parent linkage', async () => {
  const { args } = fixture(undefined, {
    overrideBlock: (_, params, block) =>
      params[0] === '0xc' ? { ...block, parentHash: hash(777) } : undefined,
  })
  await assert.rejects(
    selectCarryExitV2FirstFinalizedBlock(args),
    expectCode('noncanonical_target_boundary'),
  )
})

test('rejects target hash changing during the audit', async () => {
  let targetReads = 0
  const { args } = fixture(undefined, {
    overrideBlock: (_, params, block) => {
      if (params[0] !== '0xc') return undefined
      return ++targetReads > 2 ? { ...block, hash: hash(777) } : undefined
    },
  })
  await assert.rejects(
    selectCarryExitV2FirstFinalizedBlock(args),
    expectCode('noncanonical_target_boundary'),
  )
})

test('rejects a same-height finalized head hash change during the audit', async () => {
  let finalizedReads = 0
  const { args } = fixture(undefined, {
    overrideBlock: (_, params, block) =>
      params[0] === 'finalized' && ++finalizedReads > 1 ? { ...block, hash: hash(777) } : undefined,
  })
  await assert.rejects(
    selectCarryExitV2FirstFinalizedBlock(args),
    expectCode('noncanonical_target_boundary'),
  )
})

test('rejects a finalized head timestamp beyond bounded observation clock skew', async () => {
  const { args } = fixture([100, 101, 102, 103, 400])
  await assert.rejects(
    selectCarryExitV2FirstFinalizedBlock(args),
    expectCode('finalized_head_after_observation'),
  )
})

test('allows only the explicit two-minute finalized-head clock skew boundary', async () => {
  const { args } = fixture([100, 101, 102, 103, 400])
  args.now = () => new Date(stamp(280))
  const result = await selectCarryExitV2FirstFinalizedBlock(args)
  assert.equal(result.targetBlock, '12')
})

test('rejects provider error and wrong chain without producing evidence', async () => {
  const { args } = fixture(undefined, {
    throwOn: (method, params) => method === 'eth_getBlockByNumber' && params[0] === '0xb',
  })
  await assert.rejects(selectCarryExitV2FirstFinalizedBlock(args), expectCode('rpc_unavailable'))
  const wrong = fixture(undefined, { chainId: '0xa' })
  await assert.rejects(selectCarryExitV2FirstFinalizedBlock(wrong.args), expectCode('wrong_chain'))
})

test('microsecond parsing preserves DB precision and rejects JS Date rounding inputs', () => {
  assert.equal(
    exactUtcMicros('2026-09-29T23:01:13.731001Z') - exactUtcMicros('2026-09-29T23:01:13.731Z'),
    1n,
  )
  assert.throws(
    () => exactUtcMicros('2026-09-29T23:01:13.7310001Z'),
    expectCode('invalid_target_at'),
  )
  assert.throws(
    () => exactUtcMicros('2026-09-29T23:01:13.731+00:00'),
    expectCode('invalid_target_at'),
  )
})

test('rejects baseline hash mismatch before binary search', async () => {
  const { args } = fixture()
  args.baselineHash = hash(500)
  await assert.rejects(
    selectCarryExitV2FirstFinalizedBlock(args),
    expectCode('baseline_not_canonical'),
  )
})
