import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { encodeFunctionData, parseAbi } from 'viem'
import {
  DRILLDOWN_SHA, FOLLOWTHROUGH_SHA, MORPHO, WITHDRAW_SELECTOR,
  extractFailingWithdraw, selectIncidents, validateOutput,
} from './morpho-v2-route-panic-position.mjs'

const blueAbi = parseAbi([
  'function withdraw((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,uint256 shares,address onBehalf,address receiver) returns (uint256,uint256)',
])
const panic = '0x4e487b71' + '0'.repeat(62) + '11'
const adapter = '0x6801ac6115660a94375a1262ea9684c2fe5a6e48'
const params = {
  loanToken: '0x0000000000000000000000000000000000000001',
  collateralToken: '0x0000000000000000000000000000000000000002',
  oracle: '0x0000000000000000000000000000000000000003',
  irm: '0x0000000000000000000000000000000000000004', lltv: 860000000000000000n,
}
const data = encodeFunctionData({ abi: blueAbi, functionName: 'withdraw',
  args: [params, 184850250n, 0n, adapter, adapter] })
const failing = { type: 'CALL', from: adapter, to: MORPHO, input: data,
  error: 'execution reverted', output: panic }

test('official Morpho Blue withdraw ABI yields the observed selector', () => {
  assert.equal(data.slice(0, 10), WITHDRAW_SELECTOR)
})
test('only the failing adapter-to-Blue withdraw is decoded and hashed', () => {
  const result = extractFailingWithdraw({ type: 'CALL', calls: [failing] }, adapter)
  assert.equal(result.nodes, 2)
  assert.equal(result.panicCode, '17')
  assert.equal(result.assets, '184850250')
  assert.equal(result.shares, '0')
  assert.equal(result.onBehalf.toLowerCase(), adapter)
  assert.equal(result.marketParams.lltv, params.lltv.toString())
  assert.match(result.marketId, /^0x[\da-f]{64}$/)
  assert.doesNotMatch(JSON.stringify(result), /input|output|calls/)
})
test('rejects wrong caller, ambiguous calls, and a non-0x11 panic', () => {
  assert.throws(() => extractFailingWithdraw(failing, params.oracle), /exactly one/)
  assert.throws(() => extractFailingWithdraw({ calls: [failing, failing] }, adapter), /exactly one/)
  assert.throws(() => extractFailingWithdraw({ ...failing,
    output: '0x4e487b71' + '0'.repeat(62) + '12' }, adapter), /Panic code/)
})
test('frozen source artifacts select exactly the two panic cases', () => {
  const dir = new URL('../../data/research/venue-signals/', import.meta.url)
  const drill = JSON.parse(readFileSync(new URL('morpho-v2-route-exit-panic-drilldown.json', dir)))
  const follow = JSON.parse(readFileSync(new URL('morpho-v2-route-exit-followthrough-first20.json', dir)))
  assert.equal(drill.followthroughSha256, FOLLOWTHROUGH_SHA)
  assert.equal(DRILLDOWN_SHA.length, 64)
  assert.deepEqual(selectIncidents(drill, follow).map((x) => x.index), [15, 18])
  assert.throws(() => selectIncidents({ ...drill, results: drill.results.slice(1) }, follow), /Frozen source/)
})
test('offline result validation fails on unsealed or mismatched state', () => {
  assert.throws(() => validateOutput({ study: 'wrong' }, []), /checkpoint mismatch/)
})
