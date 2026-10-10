import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { encodeFunctionResult, parseAbi } from 'viem'
import {
  capture,
  MAX_RECIPIENTS,
  MIN_ASSETS_RAW,
  parseCli,
  selectConfiguredRpc,
  TRANSFER_TOPIC,
  validateReceipt,
} from './scrvusd-share-holder-seed.mjs'

const abi = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
])
const hash = (byte) => `0x${byte.repeat(64)}`
const address = (number) => `0x${number.toString(16).padStart(40, '0')}`
const word = (value) => `0x${value.slice(2).padStart(64, '0')}`
const seal = (value) => ({
  ...value,
  sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
})
const reseal = ({ sha256: _sha256, ...value }) => seal(value)
const identity = { chainId: 1, vault: address(1), crvUsd: address(2) }
const B = 2000
const START = 1001
const checkpoints = [
  {
    filename: 'quote.json',
    physicalSha256: 'a'.repeat(64),
    checkpoint: {
      block: { number: B, hash: hash('a'), timestamp: 1790467200 },
      captureEndUtc: '2026-09-27T00:00:00.000Z',
      sha256: 'b'.repeat(64),
    },
  },
]
const now = () => new Date('2026-09-27T00:01:00.000Z')
const log = (receiver, logIndex, block = START) => ({
  address: identity.vault,
  blockNumber: `0x${block.toString(16)}`,
  blockHash: block === B ? hash('a') : hash('c'),
  transactionIndex: '0x0',
  transactionHash: hash('d'),
  logIndex: `0x${logIndex.toString(16)}`,
  topics: [TRANSFER_TOPIC, word(address(8)), word(receiver)],
  data: `0x${'0'.repeat(63)}1`,
})

function client(
  logs,
  { readFailure = null, alteredBlock = false, code = {}, balances = {}, maxes = {} } = {},
) {
  const selectors = Object.fromEntries(
    ['asset', 'balanceOf', 'maxWithdraw'].map((name) => [
      abi.find((item) => item.name === name).name === name
        ? { asset: '0x38d52e0f', balanceOf: '0x70a08231', maxWithdraw: '0xce96cb77' }[name]
        : '',
      name,
    ]),
  )
  let BReads = 0
  return {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'finalized' ? B : Number(BigInt(params[0]))
        if (number === B) BReads++
        return {
          number: `0x${number.toString(16)}`,
          hash: number === B ? (alteredBlock && BReads > 1 ? hash('e') : hash('a')) : hash('c'),
        }
      }
      if (method === 'eth_getLogs') {
        const from = Number(BigInt(params[0].fromBlock))
        const to = Number(BigInt(params[0].toBlock))
        assert.ok(
          (from === START && to === START + 499) || (from === START + 500 && to === B),
          'exact two contiguous 500-block requests required',
        )
        return logs.filter((entry) => {
          const block = Number(BigInt(entry.blockNumber))
          return block >= from && block <= to
        })
      }
      if (method === 'eth_getCode') return code[params[0]] ?? '0x'
      if (method === 'eth_call') {
        const name = selectors[params[0].data.slice(0, 10)]
        const recipient = `0x${params[0].data.slice(-40)}`
        if (readFailure === recipient) throw new Error('RPC ambiguity')
        const result =
          name === 'asset'
            ? identity.crvUsd
            : name === 'balanceOf'
              ? (balances[recipient] ?? 1n)
              : (maxes[recipient] ?? MIN_ASSETS_RAW)
        return encodeFunctionResult({ abi, functionName: name, result })
      }
      throw new Error(`Unexpected method ${method}`)
    },
  }
}

test('quiet 1000-block window is retained as a provider-attested empty sample', async () => {
  const receipt = await capture({ client: client([]), identity, checkpoints, now })
  assert.equal(receipt.status, 'sampled')
  assert.deepEqual(receipt.window, {
    start: START,
    end: B,
    startHash: hash('c'),
    endHash: hash('a'),
    ranges: [
      { start: START, end: START + 499, startHash: hash('c'), endHash: hash('c'), logCount: 0 },
      { start: START + 500, end: B, startHash: hash('c'), endHash: hash('a'), logCount: 0 },
    ],
  })
  assert.deepEqual(receipt.logs, [])
  assert.deepEqual(receipt.recipients, [])
  validateReceipt(receipt, { identity, checkpoints })
})

test('preserves every recipient and sorts eligible code-empty candidates', async () => {
  const eligible = address(11)
  const contract = address(12)
  const dust = address(13)
  const logs = [log(dust, 0), log(contract, 1), log(eligible, 2), log(eligible, 3)]
  const receipt = await capture({
    client: client(logs, {
      code: { [contract]: '0x6000' },
      maxes: { [dust]: MIN_ASSETS_RAW - 1n },
    }),
    identity,
    checkpoints,
    now,
  })
  assert.deepEqual(receipt.recipients, [eligible, contract, dust])
  assert.deepEqual(receipt.candidates, [eligible])
  assert.deepEqual(
    receipt.results.map((row) => row.status),
    ['eligible', 'contract', 'dust_or_empty'],
  )
  assert.equal(receipt.logs.length, 4)
})

test('ambiguous recipient RPC makes the whole sample unavailable without substitution', async () => {
  const first = address(11)
  const second = address(12)
  const receipt = await capture({
    client: client([log(first, 0), log(second, 1)], { readFailure: second }),
    identity,
    checkpoints,
    now,
  })
  assert.equal(receipt.status, 'unavailable')
  assert.equal(receipt.reason, 'rpc_read_ambiguous')
  assert.deepEqual(receipt.candidates, [])
  assert.deepEqual(receipt.recipients, [first, second])
  assert.deepEqual(
    receipt.results.map((row) => row.status),
    ['eligible', 'rpc_unavailable'],
  )
})

test('recipient bound retains full recipient set but issues no candidate', async () => {
  const logs = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => log(address(i + 100), i))
  const receipt = await capture({ client: client(logs), identity, checkpoints, now })
  assert.equal(receipt.status, 'unavailable')
  assert.equal(receipt.reason, 'recipient_bound_exceeded')
  assert.equal(receipt.recipients.length, MAX_RECIPIENTS + 1)
  assert.deepEqual(receipt.candidates, [])
  assert.deepEqual(receipt.results, [])
})

test('retains both half-range counts and rejects overlap or a missing half', async () => {
  const receipt = await capture({
    client: client([log(address(11), 0, START), log(address(12), 0, B)]),
    identity,
    checkpoints,
    now,
  })
  assert.deepEqual(
    receipt.window.ranges.map((range) => range.logCount),
    [1, 1],
  )
  assert.equal(receipt.logs.length, 2)
  const missing = structuredClone(receipt)
  missing.window.ranges[1].logCount = 0
  assert.throws(() => validateReceipt(reseal(missing), { identity, checkpoints }), /half-range/)
  const overlap = structuredClone(receipt)
  overlap.window.ranges[1].start = START + 499
  assert.throws(() => validateReceipt(reseal(overlap), { identity, checkpoints }), /source, window/)
  let calls = 0
  const base = client([log(address(11), 0, START)])
  const bad = {
    request(args) {
      if (args.method === 'eth_getLogs' && ++calls === 2) return [log(address(11), 0, START)]
      return base.request(args)
    },
  }
  await assert.rejects(
    capture({ client: bad, identity, checkpoints, now }),
    /Transfer log response/,
  )
})

test('rejects changed source, changed quote block, duplicate and reordered logs', async () => {
  const good = await capture({ client: client([log(address(11), 0)]), identity, checkpoints, now })
  assert.throws(
    () => validateReceipt(good, { identity: { ...identity, vault: address(9) }, checkpoints }),
    /source/,
  )
  await assert.rejects(
    capture({ client: client([], { alteredBlock: true }), identity, checkpoints, now }),
    /identity changed/,
  )
  await assert.rejects(
    capture({
      client: client([log(address(11), 1), log(address(12), 0)]),
      identity,
      checkpoints,
      now,
    }),
    /ordering/,
  )
  await assert.rejects(
    capture({
      client: client([log(address(11), 0), log(address(12), 0)]),
      identity,
      checkpoints,
      now,
    }),
    /ordering/,
  )
})

test('sealed receipt and eligibility are replay-validated offline', async () => {
  const receipt = await capture({
    client: client([log(address(11), 0)]),
    identity,
    checkpoints,
    now,
  })
  const tampered = structuredClone(receipt)
  tampered.results[0].maxWithdrawAssetsRaw = '0'
  assert.throws(() => validateReceipt(tampered, { identity, checkpoints }), /SHA mismatch/)
  const resealed = seal({ ...tampered, sha256: undefined })
  assert.throws(
    () => validateReceipt(resealed, { identity, checkpoints }),
    /SHA mismatch|eligibility mismatch/,
  )
})

test('stale quote and future-dated sample are unavailable', async () => {
  await assert.rejects(
    capture({
      client: client([]),
      identity,
      checkpoints,
      now: () => new Date('2026-09-27T02:00:01.000Z'),
    }),
    /stale/,
  )
  const receipt = await capture({ client: client([]), identity, checkpoints, now })
  assert.throws(
    () => validateReceipt(receipt, { identity, checkpoints, nowUtc: '2026-09-27T00:00:30.000Z' }),
    /capture time/,
  )
})

test('CLI failure output is fixed and contains no supplied argument', () => {
  const script = fileURLToPath(new URL('./scrvusd-share-holder-seed.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, 'credential-sentinel'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), '[scrvusd-share-holder-seed] unavailable')
  assert.equal(result.stdout, '')
})

test('RPC index CLI selects exactly one configured host and rejects malformed indices', () => {
  assert.deepEqual(parseCli(['--run']), { mode: '--run', rpcIndex: 0 })
  assert.deepEqual(parseCli(['--run', '--rpc-index', '1']), { mode: '--run', rpcIndex: 1 })
  assert.deepEqual(parseCli(['--verify']), { mode: '--verify', rpcIndex: 0 })
  for (const args of [
    ['--run', '--rpc-index', '-1'],
    ['--run', '--rpc-index', '01'],
    ['--run', '--rpc-index', '1.0'],
    ['--run', '--rpc-index', '9007199254740992'],
    ['--verify', '--rpc-index', '1'],
    ['--rpc-index', '1'],
  ])
    assert.throws(() => parseCli(args), /Invalid seed CLI/)
  const configured = 'https://first.invalid/key, https://second.invalid/key'
  assert.equal(selectConfiguredRpc(configured, 0), 'https://first.invalid/key')
  assert.equal(selectConfiguredRpc(configured, 1), 'https://second.invalid/key')
  assert.throws(() => selectConfiguredRpc(configured, 2), /index unavailable/)
  assert.throws(() => selectConfiguredRpc(configured, -1), /Invalid RPC index/)
  assert.throws(() => selectConfiguredRpc('https://first.invalid,', 1), /index unavailable/)
  const script = fileURLToPath(new URL('./scrvusd-share-holder-seed.mjs', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [script, '--run', '--rpc-index', 'credential-sentinel'],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), '[scrvusd-share-holder-seed] unavailable')
  assert.equal(result.stdout, '')
})
