import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  PARTS,
  STUDY as QUOTE_STUDY,
  routesFromParts,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import {
  classifyWithdrawFailure,
  makeIssue,
  makePlan,
  observe,
  parseArgs,
  savePlan,
  selectConfiguredRpc,
  trajectory,
  validateIssue,
  verify,
} from './scrvusd-fixed-holder-exit.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const holder = `0x${'1'.repeat(40)}`
const hash = (char) => `0x${char.repeat(64)}`
const identity = sourceIdentity()
const base = Math.floor(Date.now() / 1000) - 900
const clock = (offset) => new Date((base + offset) * 1000).toISOString()
const stat = () => ({ bavail: 1_000_000, bsize: 4096 })
const root = () => mkdtempSync(join(tmpdir(), 'fixed-holder-exit-'))
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])

function fixture() {
  const rootDir = root()
  const out = join(rootDir, 'holder')
  const quoteOut = join(rootDir, 'quotes')
  mkdirSync(quoteOut)
  const plan = makePlan({ holder, rawCrvUsd: '1000000000000000000', now: new Date(clock(-120)) })
  savePlan({ out, plan, stat })
  function addQuote(number, character, offset) {
    const block = { number, hash: hash(character), timestamp: base + offset }
    const parts = [PARTS.map(() => '1000000'), PARTS.map(() => '1000000')]
    const saved = seal({
      study: QUOTE_STUDY,
      source: identity,
      captureStartUtc: clock(offset + 1),
      captureEndUtc: clock(offset + 2),
      block,
      pinMode: 'hash',
      pinCaveat: null,
      raw: { vaultAssetsCrvUsd: '1000000000000000000', parts },
      routes: routesFromParts(parts),
    })
    const filename = `${String(number).padStart(12, '0')}-${block.hash.slice(2)}.json`
    const bytes = JSON.stringify(saved) + '\n'
    writeFileSync(join(quoteOut, filename), bytes)
    return { filename, checkpoint: saved, physicalSha256: sha(bytes) }
  }
  return { out, quoteOut, plan, addQuote }
}

function result(status) {
  return {
    status,
    sharesBurnedRaw: status === 'success' ? '100' : null,
    balanceSharesRaw: '1000',
    maxWithdrawAssetsRaw: '2000',
    previewSharesRaw: '100',
  }
}

test('predeclared holder and size bind the exact quote logical and physical bytes', () => {
  const f = fixture()
  const row = f.addQuote(100, 'a', 0)
  const issue = makeIssue({
    plan: f.plan,
    checkpointRow: row,
    result: result('success'),
    captureStartUtc: clock(3),
    captureEndUtc: clock(4),
  })
  validateIssue(issue, { plan: f.plan, checkpoints: [row] })
  assert.throws(() =>
    validateIssue(issue, {
      plan: { ...f.plan, holder: `0x${'2'.repeat(40)}` },
      checkpoints: [row],
    }),
  )
  assert.throws(
    () =>
      validateIssue(issue, {
        plan: f.plan,
        checkpoints: [{ ...row, physicalSha256: sha('different') }],
      }),
    /timing/,
  )
  mkdirSync(join(f.out, 'issues'))
  writeFileSync(join(f.out, 'issues', row.filename), JSON.stringify(issue) + '\n')
  assert.equal(verify({ out: f.out, quoteOut: f.quoteOut }).count, 1)
  const file = join(f.quoteOut, row.filename)
  writeFileSync(file, readFileSync(file, 'utf8') + ' ')
  assert.throws(() => verify({ out: f.out, quoteOut: f.quoteOut }), /issue or source timing/)
})

test('future and stale issue times fail; exact holder and amount cannot change on replay', () => {
  const f = fixture()
  const row = f.addQuote(100, 'a', 0)
  const issue = makeIssue({
    plan: f.plan,
    checkpointRow: row,
    result: result('success'),
    captureStartUtc: clock(3),
    captureEndUtc: clock(4),
  })
  assert.throws(
    () => validateIssue(issue, { plan: f.plan, checkpoints: [row], nowUtc: clock(3) }),
    /timing/,
  )
  assert.throws(
    () =>
      makeIssue({
        plan: f.plan,
        checkpointRow: row,
        result: result('success'),
        captureStartUtc: clock(4000),
        captureEndUtc: clock(4001),
      }),
    /timing/,
  )
  assert.throws(
    () =>
      makeIssue({
        plan: f.plan,
        checkpointRow: row,
        result: result('success'),
        captureStartUtc: clock(1),
        captureEndUtc: clock(2),
      }),
    /timing/,
  )
  const changed = seal({ ...issue, holder: `0x${'2'.repeat(40)}`, sha256: undefined })
  assert.throws(() => validateIssue(changed, { plan: f.plan, checkpoints: [row] }))
  const staleEnd = seal({ ...issue, captureEndUtc: clock(4000), sha256: undefined })
  assert.throws(
    () => validateIssue(staleEnd, { plan: f.plan, checkpoints: [row], nowUtc: clock(5000) }),
    /source timing/,
  )
})

test('offline verification rejects a self-sealed future issue but replays a historical one', () => {
  const f = fixture()
  const row = f.addQuote(100, 'a', 600)
  const issue = makeIssue({
    plan: f.plan,
    checkpointRow: row,
    result: result('success'),
    captureStartUtc: clock(603),
    captureEndUtc: clock(604),
  })
  mkdirSync(join(f.out, 'issues'))
  const path = join(f.out, 'issues', row.filename)
  writeFileSync(path, JSON.stringify(issue) + '\n')
  assert.equal(verify({ out: f.out, quoteOut: f.quoteOut }).count, 1)
  const future = seal({ ...issue, captureEndUtc: clock(1000), sha256: undefined })
  validateIssue(future, { plan: f.plan, checkpoints: [row], nowUtc: clock(2000) })
  writeFileSync(path, JSON.stringify(future) + '\n')
  assert.throws(() => verify({ out: f.out, quoteOut: f.quoteOut }), /source timing/)
})

test('rejects a holder plan created after block B even if quote capture has not started', async () => {
  const f = fixture()
  const row = f.addQuote(100, 'a', 0)
  const latePlan = makePlan({ holder, rawCrvUsd: '1000000000000000000', now: new Date(clock(1)) })
  assert.equal(latePlan.createdUtc, row.checkpoint.captureStartUtc)
  assert.throws(
    () =>
      makeIssue({
        plan: latePlan,
        checkpointRow: row,
        result: result('success'),
        captureStartUtc: clock(3),
        captureEndUtc: clock(4),
      }),
    /source timing/,
  )
  writeFileSync(join(f.out, 'plan.json'), JSON.stringify(latePlan) + '\n')
  const observed = await observe({
    client: {
      request: async () => {
        throw new Error('RPC should not be called without an eligible checkpoint')
      },
    },
    out: f.out,
    quoteOut: f.quoteOut,
    now: () => new Date(clock(5)),
    stat,
  })
  assert.deepEqual(observed, { status: 'unavailable', reason: 'no_eligible_unobserved_checkpoint' })
})

test('observes success, actual revert, and provider error as different statuses', async () => {
  for (const expected of ['success', 'revert', 'provider_error']) {
    const f = fixture()
    const row = f.addQuote(100, 'a', 0)
    const client = {
      async request({ method, params }) {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber')
          return {
            number: params[0] === 'finalized' ? '0x65' : '0x64',
            hash: row.checkpoint.block.hash,
          }
        if (method === 'eth_getCode') {
          assert.equal(params[0], holder)
          assert.deepEqual(params[1], {
            blockHash: row.checkpoint.block.hash,
            requireCanonical: true,
          })
          return '0x'
        }
        assert.equal(method, 'eth_call')
        assert.equal(params[1].blockHash, row.checkpoint.block.hash)
        const { functionName } = decodeFunctionData({ abi: ABI, data: params[0].data })
        if (functionName === 'withdraw') {
          assert.equal(params[0].from, holder)
          if (expected === 'revert') throw { code: 3, data: '0x', message: 'execution reverted' }
          if (expected === 'provider_error')
            throw new Error('execution reverted during network timeout')
        }
        const output = functionName === 'asset' ? identity.crvUsd : 100n
        return encodeFunctionResult({ abi: ABI, functionName, result: output })
      },
    }
    const observed = await observe({
      client,
      out: f.out,
      quoteOut: f.quoteOut,
      now: () => new Date(clock(5)),
      stat,
    })
    assert.equal(observed.status, expected)
    assert.equal(verify({ out: f.out, quoteOut: f.quoteOut }).count, 1)
    const issue = JSON.parse(readFileSync(observed.path, 'utf8'))
    assert.equal(issue.result.status, expected)
    assert.equal(issue.result.sharesBurnedRaw, expected === 'success' ? '100' : null)
  }
})

test('observes the newest of two fresh post-plan checkpoints first', async () => {
  const f = fixture()
  f.addQuote(100, 'a', 0)
  const newest = f.addQuote(101, 'b', 100)
  const client = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber')
        return {
          number: params[0] === 'finalized' ? '0x66' : '0x65',
          hash: newest.checkpoint.block.hash,
        }
      if (method === 'eth_getCode') {
        assert.equal(params[1].blockHash, newest.checkpoint.block.hash)
        return '0x'
      }
      assert.equal(method, 'eth_call')
      assert.equal(params[1].blockHash, newest.checkpoint.block.hash)
      const { functionName } = decodeFunctionData({ abi: ABI, data: params[0].data })
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: functionName === 'asset' ? identity.crvUsd : 100n,
      })
    },
  }
  const observed = await observe({
    client,
    out: f.out,
    quoteOut: f.quoteOut,
    now: () => new Date(clock(105)),
    stat,
  })
  assert.equal(observed.block, 101)
  assert.equal(verify({ out: f.out, quoteOut: f.quoteOut }).count, 1)
})

test('exact checkpoint option probes an older score-selected quote, not the newest', async () => {
  const f = fixture()
  const selected = f.addQuote(100, 'a', 0)
  f.addQuote(101, 'b', 100)
  const client = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber')
        return {
          number: params[0] === 'finalized' ? '0x66' : '0x64',
          hash: selected.checkpoint.block.hash,
        }
      if (method === 'eth_getCode') {
        assert.equal(params[1].blockHash, selected.checkpoint.block.hash)
        return '0x'
      }
      assert.equal(params[1].blockHash, selected.checkpoint.block.hash)
      const { functionName } = decodeFunctionData({ abi: ABI, data: params[0].data })
      return encodeFunctionResult({
        abi: ABI,
        functionName,
        result: functionName === 'asset' ? identity.crvUsd : 100n,
      })
    },
  }
  const observed = await observe({
    client,
    out: f.out,
    quoteOut: f.quoteOut,
    checkpointBlock: 100,
    now: () => new Date(clock(105)),
    stat,
  })
  assert.equal(observed.block, 100)
  assert.equal(verify({ out: f.out, quoteOut: f.quoteOut }).count, 1)
})

test('invalid exact checkpoint is rejected before RPC', async () => {
  const f = fixture()
  f.addQuote(100, 'a', 0)
  await assert.rejects(
    observe({
      client: {
        request: async () => {
          throw new Error('RPC must not run')
        },
      },
      out: f.out,
      quoteOut: f.quoteOut,
      checkpointBlock: -1,
      now: () => new Date(clock(5)),
      stat,
    }),
    /Invalid exact checkpoint block/,
  )
})

test('contract holder is unavailable before simulating withdrawal and writes no issue', async () => {
  const f = fixture()
  const row = f.addQuote(100, 'a', 0)
  const methods = []
  const client = {
    async request({ method, params }) {
      methods.push(method)
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber')
        return {
          number: params[0] === 'finalized' ? '0x65' : '0x64',
          hash: row.checkpoint.block.hash,
        }
      if (method === 'eth_getCode') return '0x6001'
      throw new Error('withdraw must not be called')
    },
  }
  assert.deepEqual(
    await observe({
      client,
      out: f.out,
      quoteOut: f.quoteOut,
      now: () => new Date(clock(5)),
      stat,
    }),
    { status: 'unavailable', reason: 'contract_holder', block: 100 },
  )
  assert.equal(methods.includes('eth_call'), false)
  assert.equal(verify({ out: f.out, quoteOut: f.quoteOut }).count, 0)
})

test('structured revert evidence is required and transport evidence takes precedence', () => {
  assert.equal(classifyWithdrawFailure(new Error('execution reverted')), 'provider_error')
  assert.equal(classifyWithdrawFailure({ code: 3, data: '0x' }), 'revert')
  assert.equal(
    classifyWithdrawFailure({ name: 'HttpRequestError', cause: { code: 3, data: '0x' } }),
    'provider_error',
  )
  assert.equal(classifyWithdrawFailure({ cause: { code: 3, data: '0x08c379a0' } }), 'revert')
})

test('observe CLI selects a strict configured RPC index without exposing host values', () => {
  assert.deepEqual(parseArgs(['--observe', '--rpc-index', '1']), {
    '--observe': true,
    '--rpc-index': '1',
  })
  assert.equal(
    selectConfiguredRpc('https://first.invalid, https://second.invalid', '1'),
    'https://second.invalid',
  )
  assert.equal(
    selectConfiguredRpc('https://first.invalid, https://second.invalid'),
    'https://first.invalid',
  )
  assert.throws(() => selectConfiguredRpc('https://first.invalid', '1'), /unavailable/)
  assert.throws(() => parseArgs(['--observe', '--rpc-index', '-1']), /Invalid RPC index/)
  assert.throws(() => parseArgs(['--observe', '--rpc-index', '01']), /Invalid RPC index/)
  assert.throws(() => parseArgs(['--rpc-index', '1']), /requires --observe/)
  assert.throws(() => parseArgs(['--observe', '--rpc-index', '1', '--rpc-index', '0']), /duplicate/)
})

test('direct observe CLI rejects missing and tampered selection before RPC', () => {
  const cwd = root()
  const script = join(dirname(fileURLToPath(import.meta.url)), 'scrvusd-fixed-holder-exit.mjs')
  const run = () =>
    spawnSync(process.execPath, [script, '--observe', '--rpc-index', '1'], {
      cwd,
      env: { ...process.env, RECORDER_RPC_URL: 'http://127.0.0.1:1,http://127.0.0.1:2' },
      encoding: 'utf8',
    })
  const missing = run()
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Holder exit planning, observation, or verification failed/)
  assert.equal(missing.stdout, '')
  const linkOut = join(cwd, 'data/research/venue-signals/scrvusd-holder-selection-link')
  mkdirSync(linkOut, { recursive: true })
  writeFileSync(join(linkOut, 'selection.json'), '{"tampered":true}\n')
  const tampered = run()
  assert.equal(tampered.status, 1)
  assert.match(tampered.stderr, /Holder exit planning, observation, or verification failed/)
  assert.equal(tampered.stdout, '')
})

test('canonical mismatch is a source failure and seals no holder outcome', async () => {
  const f = fixture()
  f.addQuote(100, 'a', 0)
  const client = {
    request: async ({ method, params }) =>
      method === 'eth_chainId'
        ? '0x1'
        : { number: params[0] === 'finalized' ? '0x65' : '0x64', hash: hash('b') },
  }
  await assert.rejects(
    observe({ client, out: f.out, quoteOut: f.quoteOut, now: () => new Date(clock(5)), stat }),
    /identity/,
  )
  assert.equal(verify({ out: f.out, quoteOut: f.quoteOut }).count, 0)
})

test('trajectory reports observed interval with gaps and right censor without a two-hour rule', () => {
  const f = fixture()
  const one = f.addQuote(100, 'a', 0)
  const two = f.addQuote(101, 'b', 100)
  const three = f.addQuote(102, 'c', 600)
  const issue = (row, status, offset) =>
    makeIssue({
      plan: f.plan,
      checkpointRow: row,
      result: result(status),
      captureStartUtc: clock(offset + 3),
      captureEndUtc: clock(offset + 4),
    })
  const success = issue(one, 'success', 0)
  const unknown = issue(two, 'provider_error', 100)
  const revert = issue(three, 'revert', 600)
  assert.deepEqual(trajectory([success, unknown]), {
    status: 'right_censored',
    lastSuccessBlock: 100,
    lastSuccessUtc: clock(0),
    laterUnknownCount: 1,
  })
  assert.deepEqual(trajectory([success, unknown, revert]), {
    status: 'first_observed_revert',
    intervalStartUtc: clock(0),
    intervalEndUtc: clock(600),
    intervalStartBlock: 100,
    intervalEndBlock: 102,
    unknownWithinInterval: 1,
    laterSuccessObserved: false,
  })
  assert.equal(trajectory([unknown]).status, 'unavailable')
  assert.throws(() => trajectory([success, { ...revert, planSha256: sha('other') }]), /Mixed/)
})
