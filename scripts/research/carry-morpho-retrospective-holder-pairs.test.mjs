import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  auditedPair,
  capturePilot,
  classifyAssays,
  chooseQ,
  selectRpcUrls,
  validateRecord,
  verify,
} from './carry-morpho-retrospective-holder-pairs.mjs'
import { BOARD_ROUTES } from './carry-local-morpho-holder-v2.mjs'

const hash = (x) => `0x${x.repeat(64)}`
const source = { number: '0x64', hash: hash('a'), parentHash: hash('b'), timestamp: '0x64' }
const parent = { number: '0x63', hash: hash('b'), parentHash: hash('c'), timestamp: '0x5f' }
const finalized = { number: '0xc8', hash: hash('d'), parentHash: hash('e'), timestamp: '0xc8' }
const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`

function client(host, route, { noCode = false } = {}) {
  return {
    provider: host,
    url: `https://${host}/rpc`,
    send: async () => {
      throw Error('unexpected_send')
    },
    request: async (method, params) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber')
        return params[0] === '0x64' ? source : params[0] === '0x63' ? parent : finalized
      if (method === 'eth_getCode') return noCode ? '0x' : '0x6000'
      if (method === 'eth_call') {
        const data = params[0].data
        if (data === '0x38d52e0f') return `0x${route.asset.slice(2).padStart(64, '0')}`
        if (data === '0x01e1d114') return word(1_000_000)
        if (data === '0x313ce567') return word(6)
      }
      throw Error('unexpected_rpc')
    },
  }
}

test('source cohort selector sees historical source state and pre-source Transfer window only', async () => {
  const route = BOARD_ROUTES[38]
  const primary = client('one.example', route)
  const secondary = client('two.example', route)
  const calls = []
  await assert.rejects(
    capturePilot({
      routeIndex: 38,
      sourceBlock: 100,
      fromBlock: 99,
      toBlock: 99,
      primary,
      secondary,
      now: () => new Date('2026-10-02T00:00:00.000Z'),
      choose: async (args) => {
        calls.push(args)
        assert.equal(args.baselineBlock, '99')
        assert.equal(args.baselineHash, parent.hash)
        assert.equal(args.targetAt, '1970-01-01T00:01:40.000Z')
        return {
          targetBlock: '100',
          targetHash: source.hash,
          targetParentHash: parent.hash,
          targetBlockAt: args.targetAt,
          targetParentBlockAt: '1970-01-01T00:01:35.000Z',
        }
      },
      discover: async ({ baseline, windows }) => {
        assert.equal(baseline.targetBlock, '100')
        assert.equal(baseline.targetHash, source.hash)
        assert.equal(baseline.totalAssetsRaw, '1000000')
        assert.deepEqual(windows, [{ fromBlock: '99', toBlock: '99' }])
        throw Error('cohort_seen')
      },
    }),
    /cohort_seen/,
  )
  assert.equal(calls.length, 2)
})

test('two-host no-code source is sealed as not deployed, without a false holder outcome', async () => {
  const route = BOARD_ROUTES[38]
  const result = await capturePilot({
    routeIndex: 38,
    sourceBlock: 100,
    fromBlock: 99,
    toBlock: 99,
    primary: client('one.example', route, { noCode: true }),
    secondary: client('two.example', route, { noCode: true }),
    now: () => new Date('2026-10-02T00:00:00.000Z'),
    choose: async (args) => ({
      targetBlock: '100',
      targetHash: source.hash,
      targetParentHash: parent.hash,
      targetBlockAt: args.targetAt,
      targetParentBlockAt: '1970-01-01T00:01:35.000Z',
    }),
    discover: async () => assert.fail('no historical holder discovery before deployment'),
  })
  assert.equal(validateRecord(result), result)
  assert.equal(result.sourceState.status, 'no_code')
  assert.equal(result.sourceAssay.reason, 'vault_not_deployed')
  assert.equal(result.futureAssay.reason, 'vault_not_deployed')
  assert.equal(result.forecastValidated, false)
})

test('audited pair rejects two host target identity or timestamp disagreement', async () => {
  const primary = { provider: 'one', request: async () => {} }
  const secondary = { provider: 'two', request: async () => {} }
  const common = {
    primary,
    secondary,
    targetAt: '2026-01-01T00:00:00.000Z',
    baselineBlock: 99,
    baselineHash: parent.hash,
    now: () => new Date(),
  }
  await assert.rejects(
    auditedPair({
      ...common,
      choose: async ({ provider }) => ({
        targetBlock: '100',
        targetHash: source.hash,
        targetParentHash: parent.hash,
        targetBlockAt: provider === 'one' ? '2026-01-02T00:00:00.000Z' : '2026-01-02T00:00:01.000Z',
      }),
    }),
    /target_disagreement/,
  )
  await assert.rejects(
    auditedPair({
      ...common,
      choose: async ({ provider }) => ({
        targetBlock: '100',
        targetHash: provider === 'one' ? source.hash : parent.hash,
        targetParentHash: parent.hash,
        targetBlockAt: '2026-01-02T00:00:00.000Z',
      }),
    }),
    /target_disagreement/,
  )
})

test('Q is frozen from the source claim and zero Q is refused', () => {
  const doc = {
    selectedClaimRaw: '12',
    ladder: { labels: [{ label: 'holder_half_claim_capped_vault_0p001pct', assetsRaw: '6' }] },
  }
  assert.equal(chooseQ({ evidenceDoc: doc }), '6')
  doc.ladder.labels[0].assetsRaw = '0'
  assert.throws(() => chooseQ({ evidenceDoc: doc }), /q_unavailable/)
  doc.ladder.labels[0].assetsRaw = '13'
  assert.throws(() => chooseQ({ evidenceDoc: doc }), /q_unavailable/)
})

test('H24 revert below frozen Q is not counted as covered liquidity failure', () => {
  assert.equal(
    classifyAssays(
      { status: 'verified', simulationStatus: 'success', coveredRevert: false },
      { status: 'verified', simulationStatus: 'evm_revert', coveredRevert: false },
    ),
    'q_entitlement_below_frozen_amount',
  )
  assert.equal(
    classifyAssays(
      { status: 'verified', simulationStatus: 'success', coveredRevert: false },
      { status: 'verified', simulationStatus: 'evm_revert', coveredRevert: true },
    ),
    'covered_q_new_revert',
  )
})

test('offline verifier rejects unrelated files in private pilot directory', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'morpho-retro-test-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(out, { recursive: true, force: true })
  })
  await writeFile(join(out, 'unknown.txt'), 'x')
  await assert.rejects(verify({ out }), /unknown_file/)
})

test('explicit configured hosts select independent historical RPC origins', () => {
  const urls = ['https://a.example/key', 'https://b.example/key', 'https://c.example/key']
  assert.deepEqual(selectRpcUrls(urls, 'a.example,c.example'), [urls[0], urls[2]])
  assert.throws(() => selectRpcUrls(urls, 'a.example,a.example'), /two_hosts_required/)
  assert.throws(() => selectRpcUrls(urls, 'a.example,d.example'), /origin_not_configured/)
})
