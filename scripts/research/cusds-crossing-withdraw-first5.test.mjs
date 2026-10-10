import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { toFunctionSelector } from 'viem'
import {
  CROSSINGS_SHA256,
  DEFAULT_CROSSINGS,
  DEFAULT_HOLDERS,
  EXACT_BLOCKS,
  freezeInputs,
  loadOutcome,
  pinnedHolderCode,
  run,
  sanitizeStage,
  validateOutcome,
  verdict,
} from './cusds-crossing-withdraw-first5.mjs'
import { createHash } from 'node:crypto'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const sealed = (payload) => ({ payload, sha256: sha(JSON.stringify(payload)) })

test('frozen exact crossings and later-selected holders are pinned to five known blocks', () => {
  const frozen = freezeInputs()
  assert.equal(sha(readFileSync(DEFAULT_CROSSINGS)), CROSSINGS_SHA256)
  assert.deepEqual(
    frozen.rows.map((row) => row.crossing),
    EXACT_BLOCKS,
  )
  assert.equal(frozen.rows.length, 5)
  for (const row of frozen.rows) {
    assert.ok(row.crossing < row.onset)
    assert.match(row.preHash, /^0x[0-9a-f]{64}$/)
    assert.match(row.postHash, /^0x[0-9a-f]{64}$/)
    assert.ok(BigInt(row.preCashRaw) >= 10n ** 24n)
    assert.ok(BigInt(row.postCashRaw) < 10n ** 24n)
  }
})

test('crossing input byte mutation fails before outcome use', () => {
  const temp = mkdtempSync(join(tmpdir(), 'cusds-crossing-input-'))
  const altered = join(temp, 'crossings.json')
  writeFileSync(altered, `${readFileSync(DEFAULT_CROSSINGS, 'utf8')} `)
  assert.throws(() => freezeInputs(altered, DEFAULT_HOLDERS), /SHA mismatch/)
})

test('stage error sanitizer never retains raw RPC secrets', () => {
  const url = 'https://rpc.example/secret-api-key'
  const stage = {
    status: 'revert',
    error: { message: `execution reverted: Usds/insufficient-balance at ${url}`, data: '0x1234' },
  }
  const clean = sanitizeStage(stage)
  assert.equal(clean.error.message, 'insufficient balance')
  assert.doesNotMatch(JSON.stringify(clean), /secret-api-key|rpc\.example|0x1234/)
  assert.equal(
    sanitizeStage({ status: 'provider-error', error: { message: url } }).error.message,
    'provider-error (unclassified)',
  )
})

test('attrition at crossing pre-state makes the later-selected holder ineligible', () => {
  const code = { bytes: 0 }
  assert.equal(
    verdict({ preCode: code, postCode: code, pre: { status: 'attrition' }, post: null }),
    'ineligible-at-crossing-pre',
  )
  assert.equal(
    verdict({ preCode: { bytes: 1 }, postCode: code, pre: null, post: null }),
    'ineligible-contract-at-crossing-pre',
  )
  assert.equal(
    verdict({ preCode: code, postCode: { bytes: 1 }, pre: null, post: null }),
    'holder-identity-change',
  )
  assert.equal(verdict({ pre: null, post: null }), 'pending')
})

test('explicit cash revert remains distinguishable after secret-safe sanitization', () => {
  const code = {
    comet: { hash: '0x' + 'a'.repeat(64) },
    base: { hash: '0x' + 'b'.repeat(64) },
    cometImplementation: { address: '0x' + 'c'.repeat(40), hash: '0x' + 'd'.repeat(64) },
    baseImplementation: null,
  }
  const pre = {
    status: 'success',
    balanceRaw: (2n * 10n ** 24n).toString(),
    cashRaw: (11n * 10n ** 23n).toString(),
    paused: false,
    code,
  }
  const post = sanitizeStage({
    ...pre,
    status: 'revert',
    cashRaw: '999999999999999999999999',
    error: { message: 'execution reverted: Usds/insufficient-balance https://rpc.example/key' },
  })
  assert.equal(
    verdict({ preCode: { bytes: 0 }, postCode: { bytes: 0 }, pre, post }),
    'insufficient-cash',
  )
})

test('holder code is read at the exact pinned hash, including empty EOA code', async () => {
  const calls = []
  const client = {
    request: async (request) => {
      calls.push(request)
      return '0x'
    },
  }
  const hash = '0x' + 'f'.repeat(64)
  const result = await pinnedHolderCode(client, '0x' + 'a'.repeat(40), 123, hash)
  assert.equal(result.bytes, 0)
  assert.equal(result.blockHash, hash)
  assert.deepEqual(calls[0].params[1], { blockHash: hash, requireCanonical: true })
})

test('fake-client crossing replay and offline resume preserve EOA success to cash revert', async () => {
  const frozen = freezeInputs()
  const first = frozen.rows[0]
  const out = join(mkdtempSync(join(tmpdir(), 'cusds-crossing-run-')), 'out.json')
  const pauseSelector = toFunctionSelector('isWithdrawPaused()')
  const withdrawSelector = toFunctionSelector('withdraw(address,uint256)')
  const implementation = '0x' + '1'.repeat(40)
  const word = '0x' + '0'.repeat(24) + implementation.slice(2)
  const holder = first.holder.toLowerCase()
  const calls = []
  const client = {
    getBlock: async ({ blockNumber }) => ({
      number: blockNumber,
      hash: Number(blockNumber) === first.crossing - 1 ? first.preHash : first.postHash,
    }),
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      const hash = params.at(-1)?.blockHash
      if (method === 'eth_getCode') return params[0].toLowerCase() === holder ? '0x' : '0x6000'
      if (method === 'eth_getStorageAt')
        return params[0].toLowerCase() === frozen.rows[0].holder.toLowerCase()
          ? '0x' + '0'.repeat(64)
          : params[0].toLowerCase() === '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
            ? '0x' + '0'.repeat(64)
            : word
      if (method !== 'eth_call') throw new Error('Unexpected fake RPC method')
      const tx = params[0]
      if (tx.data.startsWith(withdrawSelector)) {
        if (hash === first.postHash)
          throw new Error('execution reverted: Usds/insufficient-balance')
        return '0x'
      }
      if (tx.data.startsWith(pauseSelector)) return '0x' + '0'.repeat(64)
      if (tx.data.startsWith('0x70a08231')) {
        const amount =
          tx.to.toLowerCase() === '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
            ? hash === first.preHash
              ? first.preCashRaw
              : first.postCashRaw
            : (2n * 10n ** 24n).toString()
        return '0x' + BigInt(amount).toString(16).padStart(64, '0')
      }
      throw new Error('Unexpected fake call data')
    },
  }
  const outcome = await run({ out, client, maxEvents: 1, checkDisk: () => {} })
  assert.equal(outcome.rows[0].pre, 'success')
  assert.equal(outcome.rows[0].post, 'revert')
  assert.equal(outcome.rows[0].verdict, 'insufficient-cash')
  const saved = loadOutcome(out, frozen)
  assert.equal(saved.results[0].preCode.bytes, 0)
  assert.equal(saved.results[0].postCode.bytes, 0)
  assert.equal((await run({ out, maxEvents: 0 })).rows[0].verdict, 'insufficient-cash')
  assert.ok(
    calls
      .filter((call) => call.method === 'eth_getCode' && call.params[0].toLowerCase() === holder)
      .every((call) => call.params[1].requireCanonical),
  )
})

test('offline run constructs plan without touching RPC or writing checkpoint', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'cusds-crossing-plan-')), 'out.json')
  const result = await run({ out, maxEvents: 0 })
  assert.equal(result.processed, 0)
  assert.equal(result.status, 'partial')
  assert.equal(result.rows.length, 5)
  assert.deepEqual(
    result.rows.map((row) => row.verdict),
    Array(5).fill('pending'),
  )
})

test('outcome identity and canonical stage hashes cannot be modified', () => {
  const frozen = freezeInputs()
  const source = {
    study: 'cusds-crossing-withdraw-first5-exploratory-v1',
    chainId: 1,
    comet: '0x5d409e56d886231adaf00c8775665ad0f9897b56',
    base: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    qRaw: (10n ** 24n).toString(),
    crossingsSha256: frozen.crossingsSha256,
    holdersSha256: frozen.holdersSha256,
    selectionCaveat:
      'same EOA chosen at later grid B-1; crossing replay is post-result exploratory',
    frozenRows: frozen.rows,
    status: 'partial',
    results: frozen.rows.map((row) => ({ crossing: row.crossing, pre: null, post: null })),
  }
  assert.equal(validateOutcome(sealed(source), frozen).status, 'partial')
  const bad = structuredClone(source)
  bad.frozenRows[0].holder = '0x0000000000000000000000000000000000000000'
  assert.throws(() => validateOutcome(sealed(bad), frozen), /identity mismatch/)
  const postWithoutPre = structuredClone(source)
  postWithoutPre.results[0].post = { block: EXACT_BLOCKS[0], blockHash: frozen.rows[0].postHash }
  assert.throws(() => validateOutcome(sealed(postWithoutPre), frozen), /stage invalid/)
})

test('re-sealing an outcome cannot alter frozen crossing cash on either side', () => {
  const frozen = freezeInputs()
  const row = frozen.rows[0]
  const code = {
    comet: { hash: '0x' + 'a'.repeat(64) },
    base: { hash: '0x' + 'b'.repeat(64) },
    cometImplementation: { address: '0x' + 'c'.repeat(40), hash: '0x' + 'd'.repeat(64) },
    baseImplementation: null,
  }
  const pre = {
    block: row.crossing - 1,
    blockHash: row.preHash,
    status: 'success',
    balanceRaw: (2n * 10n ** 24n).toString(),
    cashRaw: row.preCashRaw,
    paused: false,
    code,
  }
  const post = {
    ...pre,
    block: row.crossing,
    blockHash: row.postHash,
    cashRaw: row.postCashRaw,
    status: 'revert',
    error: { message: 'insufficient balance' },
  }
  const payload = {
    study: 'cusds-crossing-withdraw-first5-exploratory-v1',
    chainId: 1,
    comet: '0x5d409e56d886231adaf00c8775665ad0f9897b56',
    base: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    qRaw: (10n ** 24n).toString(),
    crossingsSha256: frozen.crossingsSha256,
    holdersSha256: frozen.holdersSha256,
    selectionCaveat:
      'same EOA chosen at later grid B-1; crossing replay is post-result exploratory',
    frozenRows: frozen.rows,
    status: 'partial',
    results: frozen.rows.map((item) => ({ crossing: item.crossing, pre: null, post: null })),
  }
  const preCode = {
    block: row.crossing - 1,
    blockHash: row.preHash,
    bytes: 0,
    codeHash: '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  }
  const postCode = { ...preCode, block: row.crossing, blockHash: row.postHash }
  payload.results[0] = { crossing: row.crossing, preCode, postCode, pre, post }
  assert.equal(validateOutcome(sealed(payload), frozen).status, 'partial')
  const badPre = structuredClone(payload)
  badPre.results[0].pre.cashRaw = (BigInt(row.preCashRaw) + 1n).toString()
  assert.throws(() => validateOutcome(sealed(badPre), frozen), /stage invalid/)
  const badPost = structuredClone(payload)
  badPost.results[0].post.cashRaw = (BigInt(row.postCashRaw) - 1n).toString()
  assert.throws(() => validateOutcome(sealed(badPost), frozen), /stage invalid/)
  const contractOrigin = structuredClone(payload)
  contractOrigin.results[0].preCode.bytes = 1
  assert.throws(() => validateOutcome(sealed(contractOrigin), frozen), /stage invalid/)
})
