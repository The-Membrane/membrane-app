import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GAS_BASIS,
  ISSUE_SHAS,
  bisectExecutable,
  classifyWithdrawal,
  makeRpc,
  pairOriginObservations,
  probeOriginPoint,
  selectCells,
  selectOrigins,
} from './carry-morpho-ausd-threshold-probe.mjs'

const hash = `0x${'a'.repeat(64)}`
const vault = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const holder = `0x${'3'.repeat(40)}`
const uint = (n) => `0x${n.toString(16).padStart(64, '0')}`

test('selects only sealed AUSD issues and matching H1 impairment', () => {
  const issues = Array(67)
  const scores = []
  for (const id of [66, 67]) {
    issues[id - 1] = {
      sequence: id,
      sha256: ISSUE_SHAS[id],
      routeKey: 'AUSD → VaultV2 [AUSD]',
      destination: vault,
      asset,
      holder,
      cases: [
        {
          label: 'holder_small_sentinel',
          assetsRaw: '10',
          baselineStatus: 'simulated_withdraw_success',
        },
        { label: 'holder_near_claim_90pct', assetsRaw: '100', baselineStatus: 'baseline_revert' },
      ],
      baseline: { targetBlock: '123', targetHash: hash },
    }
    scores.push({
      issueSequence: id,
      issueSha256: ISSUE_SHAS[id],
      scoreSha256: hash,
      caseLabel: 'holder_near_claim_90pct',
      horizonHours: 1,
      outcome: 'covered_revert_cause_unknown',
      transition: 'still_reverting',
      assetsRaw: '100',
      target: { targetBlock: '456', targetHash: hash },
      targetWitness: { targetHash: hash },
    })
  }
  assert.equal(selectCells(issues, scores).length, 2)
  issues[65].sha256 = 'tampered'
  assert.throws(() => selectCells(issues, scores), /issue_identity_changed/)
})

test('selects two distinct HTTPS origin hosts', () => {
  assert.deepEqual(
    selectOrigins(['https://one.example/a', 'https://one.example/b', 'https://two.example/c']).map(
      (x) => x.host,
    ),
    ['one.example', 'two.example'],
  )
  assert.throws(
    () => selectOrigins(['https://one.example/a', 'https://one.example/b']),
    /two_origins/,
  )
  assert.throws(
    () => selectOrigins(['http://one.example/a', 'https://two.example/b']),
    /origin_invalid/,
  )
})

test('six-call bisection preserves only a sampled success/revert bracket', async () => {
  const calls = []
  const result = await bisectExecutable({
    low: 10n,
    high: 100n,
    probe: async (q) => {
      calls.push(q)
      return { status: q <= 45n ? 'success' : 'revert' }
    },
  })
  assert.equal(calls.length, 6)
  assert.ok(BigInt(result.lowerSuccessRaw) <= 45n)
  assert.ok(BigInt(result.upperRevertRaw) > 45n)
  assert.ok(BigInt(result.upperRevertRaw) - BigInt(result.lowerSuccessRaw) < 90n)
})

test('pinned raw requests preserve getter and Q evidence without assuming maxWithdraw means executable', async () => {
  const seen = []
  let malformedMax = false
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body)
    seen.push(request)
    const response =
      request.method === 'eth_getBlockByNumber'
        ? { number: '0x7b', hash }
        : request.params[0].data.startsWith('0xce96cb77') // maxWithdraw selector
          ? malformedMax
            ? '0x1'
            : uint(999n)
          : request.params[0].to === asset
            ? uint(50n)
            : BigInt(`0x${request.params[0].data.slice(10, 74)}`) <= 40n
              ? uint(1n)
              : undefined
    const body =
      response === undefined
        ? { jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted' } }
        : { jsonrpc: '2.0', id: request.id, result: response }
    return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) }
  }
  const { rpc, budget } = makeRpc(fetchImpl)
  const result = await probeOriginPoint(
    { issueSequence: 66, vault, asset, holder, lowQ: '10', impairedQ: '100' },
    { label: 'baseline', number: '123', hash },
    { host: 'one.example', url: 'https://one.example' },
    rpc,
  )
  assert.equal(result.maxWithdrawRaw, '999')
  assert.equal(result.underlyingCashRaw, '50')
  assert.equal(result.lowerEndpoint.status, 'success')
  assert.equal(result.upperEndpoint.status, 'revert')
  assert.equal(result.bracket.samples.length, 6)
  assert.equal(result.interpretation, 'single_origin_bounded_simulated_callability_only')
  assert.equal(GAS_BASIS, 'diagnostic_gas_cap_original_holder_measurement_gas_omitted')
  assert.equal(budget().calls, 11)
  assert.equal(
    seen
      .filter((x) => x.method === 'eth_call')
      .every((x) => x.params[1].blockHash === hash && x.params[1].requireCanonical === true),
    true,
  )
  assert.equal(
    seen.filter((x) => x.method === 'eth_call').every((x) => x.params[0].gas === '0x1312d00'),
    true,
  )
  malformedMax = true
  const malformed = await probeOriginPoint(
    { issueSequence: 66, vault, asset, holder, lowQ: '10', impairedQ: '100' },
    { label: 'baseline', number: '123', hash },
    { host: 'one.example', url: 'https://one.example' },
    rpc,
  )
  assert.equal(malformed.maxWithdrawRaw, null)
})

test('transport errors cannot become inferred reverts', () => {
  assert.equal(
    classifyWithdrawal({ response: { error: { message: 'rate limit exceeded' } } }),
    'inconclusive_rpc_error',
  )
  assert.equal(
    classifyWithdrawal({ response: { error: { message: 'execution reverted' } } }),
    'revert',
  )
  assert.equal(
    classifyWithdrawal({ response: { error: { message: 'execution reverted: out of gas' } } }),
    'inconclusive_rpc_error',
  )
  assert.equal(classifyWithdrawal({ response: { result: uint(0n) } }), 'success')
  assert.equal(classifyWithdrawal({ response: { result: '0x1' } }), 'inconclusive_result')
})

test('a paired bracket requires semantic agreement and complete uint getters', () => {
  const sample = (q, status) => ({ q, status, reply: { response: { result: uint(1n) } } })
  const first = {
    issueSequence: 66,
    point: { label: 'h1', number: '123', hash },
    origin: 'one.example',
    vault,
    asset,
    holder,
    maxWithdrawRaw: '999',
    underlyingCashRaw: '50',
    lowerEndpoint: { q: '10', status: 'success' },
    upperEndpoint: { q: '100', status: 'revert' },
    bracket: {
      lowerSuccessRaw: '40',
      upperRevertRaw: '41',
      samples: [sample('55', 'revert'), sample('32', 'success')],
    },
  }
  const second = structuredClone(first)
  second.origin = 'two.example'
  assert.equal(
    pairOriginObservations(first, second).status,
    'corroborated_bounded_simulated_callability_only',
  )
  assert.deepEqual(pairOriginObservations(first, second).bracket?.samples, [
    { q: '55', status: 'revert' },
    { q: '32', status: 'success' },
  ])
  second.bracket.samples[1].status = 'revert'
  assert.throws(() => pairOriginObservations(first, second), /ausd_origin_disagreement/)
  second.bracket.samples[1].status = 'success'
  second.underlyingCashRaw = '51'
  assert.throws(() => pairOriginObservations(first, second), /ausd_origin_disagreement/)
  second.underlyingCashRaw = null
  assert.throws(() => pairOriginObservations(first, second), /ausd_origin_disagreement/)
  first.underlyingCashRaw = null
  const incomplete = pairOriginObservations(first, second)
  assert.equal(incomplete.status, 'getter_incomplete')
  assert.equal(incomplete.bracket, null)
})
