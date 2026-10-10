import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeFunctionResult, parseAbi } from 'viem'
import {
  PARTS,
  STUDY as QUOTE_STUDY,
  routesFromParts,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import {
  makeIssue,
  makePlan,
  savePlan,
  verify as verifyHolder,
} from './scrvusd-fixed-holder-exit.mjs'
import {
  capture as captureSeed,
  MIN_ASSETS_RAW,
  save as saveSeed,
} from './scrvusd-index-holder-seed.mjs'
import {
  makeSelection,
  readSources,
  save as saveSelection,
} from './scrvusd-holder-selection-link.mjs'
import { computeTrend, readTrend } from './scrvusd-holder-exit-trend.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const hash = (character) => `0x${character.repeat(64)}`
const holder = `0x${'1'.repeat(40)}`
const identity = sourceIdentity()
const base = Math.floor(Date.now() / 1000) - 900
const at = (offset) => new Date((base + offset) * 1000).toISOString()
const stat = () => ({ bavail: 1_000_000, bsize: 4096 })

function fixture(rawCrvUsd = '1000') {
  const root = mkdtempSync(join(tmpdir(), 'holder-trend-'))
  const out = join(root, 'holder')
  const quoteOut = join(root, 'quotes')
  mkdirSync(quoteOut)
  const plan = makePlan({ holder, rawCrvUsd, now: new Date(at(-100)) })
  savePlan({ out, plan, stat })
  const checkpoints = []
  const issues = []
  function quote(number, character, offset) {
    const block = { number, hash: hash(character), timestamp: base + offset }
    const parts = [PARTS.map(() => '1000000'), PARTS.map(() => '1000000')]
    const checkpoint = seal({
      study: QUOTE_STUDY,
      source: identity,
      captureStartUtc: at(offset + 1),
      captureEndUtc: at(offset + 2),
      block,
      pinMode: 'hash',
      pinCaveat: null,
      raw: { vaultAssetsCrvUsd: '1000000000000000000', parts },
      routes: routesFromParts(parts),
    })
    const filename = `${String(number).padStart(12, '0')}-${block.hash.slice(2)}.json`
    const bytes = JSON.stringify(checkpoint) + '\n'
    writeFileSync(join(quoteOut, filename), bytes)
    const row = { checkpoint, filename, physicalSha256: sha(bytes) }
    checkpoints.push(row)
    return row
  }
  function issue(row, status, max, shares = '2000', preview = '100') {
    const offset = row.checkpoint.block.timestamp - base
    const saved = makeIssue({
      plan,
      checkpointRow: row,
      result: {
        status,
        sharesBurnedRaw: status === 'success' ? '100' : null,
        balanceSharesRaw: shares,
        maxWithdrawAssetsRaw: max,
        previewSharesRaw: preview,
      },
      captureStartUtc: at(offset + 3),
      captureEndUtc: at(offset + 4),
    })
    mkdirSync(join(out, 'issues'), { recursive: true })
    writeFileSync(join(out, 'issues', row.filename), JSON.stringify(saved) + '\n')
    issues.push(saved)
    return saved
  }
  const compute = (nowOffset = 800) =>
    computeTrend({ plan, checkpoints, issues, now: new Date(at(nowOffset)) })
  return { out, quoteOut, plan, checkpoints, issues, quote, issue, compute }
}

test('consecutive success reports only measured same-holder headroom and signed change', () => {
  const f = fixture()
  f.issue(f.quote(100, 'a', 0), 'success', '5000')
  f.issue(f.quote(101, 'b', 600), 'success', '3000')
  const result = f.compute()
  assert.equal(result.status, 'measured_pair')
  assert.equal(result.direction, 'shrinking')
  assert.equal(result.previousHeadroomAssetsRaw, '4000')
  assert.equal(result.currentHeadroomAssetsRaw, '2000')
  assert.equal(result.signedHeadroomChangeAssetsRaw, '-2000')
  assert.equal(result.elapsedSeconds, 600)
})

test('one success is right censored, without a trend or duration estimate', () => {
  const f = fixture()
  f.issue(f.quote(100, 'a', 0), 'success', '5000')
  const result = f.compute()
  assert.equal(result.status, 'right_censored')
  assert.equal(result.currentHeadroomAssetsRaw, undefined)
})

test('success to structured revert is a sampled interval, never a projected decline', () => {
  const f = fixture()
  f.issue(f.quote(100, 'a', 0), 'success', '5000')
  f.issue(f.quote(101, 'b', 600), 'revert', '1000')
  const result = f.compute()
  assert.equal(result.status, 'sampled_transition')
  assert.equal(result.transition, 'success_to_structured_evm_revert')
  assert.equal(result.currentHeadroomAssetsRaw, undefined)
  assert.equal(result.intervalStartUtc, at(0))
  assert.equal(result.intervalEndUtc, at(600))
})

test('provider ambiguity and holder share attrition never become a decline or transition', () => {
  const f = fixture()
  f.issue(f.quote(100, 'a', 0), 'success', '5000')
  f.issue(f.quote(101, 'b', 600), 'provider_error', null)
  assert.equal(f.compute().reason, 'ambiguous_current_result')
  f.issues.at(-1).result.status = 'revert'
  f.issues.at(-1).result.balanceSharesRaw = '1999'
  assert.equal(f.compute().reason, 'holder_attrition_or_insufficient_shares')
})

test('missing intermediate or newer quote, stale capture, and wide gap are unavailable', () => {
  const f = fixture()
  f.issue(f.quote(100, 'a', 0), 'success', '5000')
  f.quote(101, 'b', 300)
  f.issue(f.quote(102, 'c', 600), 'success', '3000')
  assert.equal(f.compute().reason, 'missing_intermediate_checkpoint')
  f.checkpoints.splice(1, 1)
  assert.equal(f.compute(9000).reason, 'stale_or_future_capture')
  f.quote(103, 'd', 700)
  assert.equal(f.compute().reason, 'missing_latest_checkpoint')

  const g = fixture()
  g.issue(g.quote(100, 'a', 0), 'success', '5000')
  g.issue(g.quote(101, 'b', 600), 'success', '3000')
  g.issues[0].checkpoint.block.timestamp -= 7201
  assert.equal(g.compute().reason, 'sample_gap')
})

test('source verifier refuses altered issue or quote bytes before trend is computed', () => {
  const f = fixture()
  const first = f.quote(100, 'a', 0)
  f.issue(first, 'success', '5000')
  const second = f.quote(101, 'b', 600)
  f.issue(second, 'success', '3000')
  const issuePath = join(f.out, 'issues', second.filename)
  const original = readFileSync(issuePath, 'utf8')
  writeFileSync(issuePath, original.replace('3000', '2000'))
  assert.throws(() => verifyHolder({ out: f.out, quoteOut: f.quoteOut }), /SHA mismatch/)
  writeFileSync(issuePath, original)
  const quotePath = join(f.quoteOut, second.filename)
  writeFileSync(quotePath, readFileSync(quotePath, 'utf8') + ' ')
  assert.throws(() => verifyHolder({ out: f.out, quoteOut: f.quoteOut }), /issue or source timing/)
})

test('trend reader requires intact synthetic seed-to-plan selection certificate', async () => {
  const f = fixture(MIN_ASSETS_RAW.toString())
  const root = mkdtempSync(join(tmpdir(), 'holder-trend-selection-'))
  const seedOut = join(root, 'seed')
  const selectionOut = join(root, 'selection')
  const options = { out: f.out, quoteOut: f.quoteOut, seedOut, selectionOut }
  const abi = parseAbi([
    'function asset() view returns (address)',
    'function balanceOf(address) view returns (uint256)',
    'function maxWithdraw(address) view returns (uint256)',
  ])
  const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
  const anchor = { number: '0x63', hash: hash('f'), timestamp: `0x${(base - 300).toString(16)}` }
  const page = {
    items: Array.from({ length: 50 }, (_, i) => ({
      address: { hash: i === 0 ? holder : address(i + 100) },
      value: String(50 - i),
    })),
    next_page_params: { items_count: 50, value: '1' },
  }
  let tick = 0
  const times = [base - 250, base - 249, base - 248].map((seconds) => seconds * 1000)
  const seed = await captureSeed({
    identity,
    now: () => times[tick++],
    fetchPage: async (url) => ({ status: 200, url, body: page }),
    client: {
      async request({ method, params }) {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber') return anchor
        if (method === 'eth_getCode') return params[0] === identity.vault ? '0x6000' : '0x'
        if (method === 'eth_call') {
          const data = params[0].data
          const name =
            data.slice(0, 10) === '0x38d52e0f'
              ? 'asset'
              : data.slice(0, 10) === '0x70a08231'
                ? 'balanceOf'
                : 'maxWithdraw'
          const target = `0x${data.slice(-40)}`
          const result =
            name === 'asset'
              ? identity.crvUsd
              : name === 'balanceOf'
                ? target === holder
                  ? 2000n
                  : 0n
                : target === holder
                  ? MIN_ASSETS_RAW + 5000n
                  : 0n
          return encodeFunctionResult({ abi, functionName: name, result })
        }
        throw new Error('Unexpected synthetic seed RPC method')
      },
    },
  })
  assert.deepEqual(seed.candidates, [holder])
  saveSeed({ receipt: seed, out: seedOut, identity, stat })
  f.issue(f.quote(100, 'a', 0), 'success', (MIN_ASSETS_RAW + 5000n).toString())
  f.issue(f.quote(101, 'b', 600), 'success', (MIN_ASSETS_RAW + 3000n).toString())

  assert.throws(() => readTrend(options), /Holder selection certificate unavailable/)
  const sources = readSources({ planOut: f.out, seedOut, quoteOut: f.quoteOut, identity })
  const selection = makeSelection({ sources, capturedUtc: at(-50) })
  saveSelection({ out: selectionOut, selection, sources, stat })
  assert.equal(readTrend(options).status, 'measured_pair')
  const seedFile = join(seedOut, sources.seedFilename)
  const seedBytes = readFileSync(seedFile, 'utf8')
  writeFileSync(seedFile, seedBytes + ' ')
  assert.throws(() => readTrend(options), /Selection certificate mismatch/)
  writeFileSync(seedFile, seedBytes)
  const file = join(selectionOut, 'selection.json')
  const original = readFileSync(file, 'utf8')
  writeFileSync(file, original.replace('prospective-holder-selection', 'tampered-holder-selection'))
  assert.throws(() => readTrend(options), /Selection certificate mismatch/)
})
