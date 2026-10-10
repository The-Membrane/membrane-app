import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseAbiItem, toEventSelector } from 'viem'

import {
  collectLifecycle,
  collectWindow,
  readRows,
  replayEpisodes,
  replayWindow,
  verifyLedger,
} from './pyusd-wylds-queue-lifecycle-v2.mjs'
import { USDC, WYLDS } from './pyusd-staking-economic-exit.mjs'

const URLS = ['https://one.example', 'https://two.example']
const USER = '0x6e2eaaec940e529cb428eaeedc7f5566a870de43'
const VAULT = '0x1234567890123456789012345678901234567890'
const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const Q = (n) => `0x${n.toString(16)}`
const word = (n) => BigInt(n).toString(16).padStart(64, '0')
const addressWord = (a) => `0x${a.slice(2).padStart(64, '0')}`
const TS = (n) => 1_700_000_000 + n * 12
const topics = {
  request: toEventSelector(
    parseAbiItem(
      'event RedemptionRequested(address indexed user,uint256 shares,uint256 assets,uint256 timestamp)',
    ),
  ),
  completion: toEventSelector(
    parseAbiItem(
      'event RedemptionCompleted(address indexed user,uint256 shares,uint256 assets,uint256 timestamp)',
    ),
  ),
  cancel: toEventSelector(
    parseAbiItem('event RedemptionCancelled(address indexed user,uint256 shares)'),
  ),
  transfer: toEventSelector(
    parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)'),
  ),
}
function event(kind, block, nonce = 0, shares = 400000, assets = 425073) {
  return {
    address: WYLDS,
    blockNumber: Q(block),
    blockHash: H(block),
    transactionHash: H(block * 1000 + nonce + 1),
    transactionIndex: Q(nonce),
    logIndex: Q(nonce + 2),
    removed: false,
    topics: [topics[kind], addressWord(USER)],
    data: `0x${word(shares)}${kind === 'cancel' ? '' : word(assets) + word(TS(block))}`,
  }
}
function transfer(completion, amount = 425073) {
  return {
    address: USDC,
    blockNumber: completion.blockNumber,
    blockHash: completion.blockHash,
    transactionHash: completion.transactionHash,
    transactionIndex: completion.transactionIndex,
    logIndex: '0x9',
    removed: false,
    topics: [topics.transfer, addressWord(VAULT), addressWord(USER)],
    data: `0x${word(amount)}`,
  }
}
function fixture(
  input,
  {
    head = 114,
    secondLogs,
    missingTransfer = false,
    wrongVault = false,
    duplicateTransfer = false,
    busyHeaders = false,
  } = {},
) {
  const logs = input
  const receipts = new Map(
    logs.map((e) => [
      e.transactionHash,
      {
        transactionHash: e.transactionHash,
        blockHash: e.blockHash,
        blockNumber: e.blockNumber,
        transactionIndex: e.transactionIndex,
        status: '0x1',
        logs: [
          e,
          ...(e.topics[0] === topics.completion && !missingTransfer
            ? [transfer(e), ...(duplicateTransfer ? [transfer(e)] : [])]
            : []),
        ],
      },
    ]),
  )
  const calls = []
  const fetchImpl = async (url, { body }) => {
    const req = JSON.parse(body)
    calls.push({ url, ...req })
    let result
    switch (req.method) {
      case 'eth_chainId':
        result = '0x1'
        break
      case 'eth_getBlockByNumber': {
        const b = req.params[0] === 'finalized' ? head : Number(BigInt(req.params[0]))
        result = { number: Q(b), hash: H(b), parentHash: H(b - 1), timestamp: Q(TS(b)) }
        if (busyHeaders) result.transactions = Array.from({ length: 1000 }, (_, i) => H(i))
        break
      }
      case 'eth_getLogs': {
        const [{ fromBlock, toBlock }] = req.params,
          from = Number(BigInt(fromBlock)),
          to = Number(BigInt(toBlock))
        result = (url === URLS[1] && secondLogs !== undefined ? secondLogs : logs).filter(
          (e) => Number(BigInt(e.blockNumber)) >= from && Number(BigInt(e.blockNumber)) <= to,
        )
        break
      }
      case 'eth_getTransactionReceipt':
        result = receipts.get(req.params[0])
        break
      case 'eth_getBalance':
        result = '0x0'
        break
      case 'eth_call':
        result = addressWord(
          wrongVault && url === URLS[1] ? '0x2222222222222222222222222222222222222222' : VAULT,
        )
        break
      default:
        throw Error(req.method)
    }
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: req.id, result }),
    }
  }
  return { fetchImpl, calls }
}
const opts = (f) => ({ urls: URLS, fetchImpl: f.fetchImpl, nowMs: () => Date.UTC(2026, 9, 4, 12) })
const reseal = (row) => {
  const { sha256, ...body } = row
  row.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return row
}

test('contiguous request, empty, completion windows preserve exact episode and intermediate only', async () => {
  const req = event('request', 100),
    done = event('completion', 110)
  const f = fixture([req, done])
  const a = await collectWindow({ ...opts(f), startBlock: 100 })
  const b = await collectWindow({ ...opts(f), previous: a })
  const c = await collectWindow({ ...opts(f), previous: b })
  assert.deepEqual([a.events.length, b.events.length, c.events.length], [1, 0, 1])
  assert.deepEqual([a.scan.to, b.scan.to, c.scan.to], [104, 109, 114])
  const episodes = replayEpisodes([a, b, c])
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].status, 'completed')
  assert.equal(episodes[0].durationSeconds, 120)
  assert.equal(
    episodes[0].intermediateUsdc.status,
    'same_tx_usdc_transfer_from_block_end_redeem_vault_to_holder',
  )
  assert.equal(c.finalPyusdPayout, 'not_attested')
  assert.equal(c.events[0].redeemVault, VAULT)
  assert.equal(f.calls.filter((x) => x.method === 'eth_getLogs').length, 6)
})

test('right censor, cancellation, and left censor remain distinct', async () => {
  const req = event('request', 100),
    cancel = event('cancel', 105),
    orphan = event('completion', 110)
  const f = fixture([req, cancel, orphan], { missingTransfer: true })
  const a = await collectWindow({ ...opts(f), startBlock: 100 })
  assert.equal(replayEpisodes([a])[0].status, 'right_censored_pending')
  const b = await collectWindow({ ...opts(f), previous: a })
  const c = await collectWindow({ ...opts(f), previous: b })
  assert.deepEqual(
    replayEpisodes([a, b, c]).map((e) => e.status),
    ['cancelled', 'left_censored_completion'],
  )
})

test('missing transfer cannot attest intermediate USDC', async () => {
  const f = fixture([event('completion', 100)], { missingTransfer: true })
  const row = await collectWindow({ ...opts(f), startBlock: 100 })
  assert.equal(row.events[0].intermediateUsdc.status, 'not_attested')
})

test('two-origin discovery disagreement and ambiguous transfer fail closed', async () => {
  const done = event('completion', 100)
  await assert.rejects(
    collectWindow({ ...opts(fixture([done], { secondLogs: [] })), startBlock: 100 }),
    /discovery_disagreement/,
  )
  await assert.rejects(
    collectWindow({ ...opts(fixture([done], { duplicateTransfer: true })), startBlock: 100 }),
    /receipt_log_invalid|payout_ambiguous|receipt_mismatch/,
  )
  await assert.rejects(
    collectWindow({ ...opts(fixture([done], { wrongVault: true })), startBlock: 100 }),
    /vault_disagreement/,
  )
})

test('duplicate same-holder request and amount mismatch fail pairing', async () => {
  const duplicate = fixture([event('request', 100), event('request', 105)])
  const a = await collectWindow({ ...opts(duplicate), startBlock: 100 })
  const b = await collectWindow({ ...opts(duplicate), previous: a })
  assert.throws(() => replayEpisodes([a, b]), /ambiguous_duplicate_request/)
  const mismatch = fixture([event('request', 100), event('completion', 105, 0, 400000, 425074)], {
    missingTransfer: true,
  })
  const x = await collectWindow({ ...opts(mismatch), startBlock: 100 })
  const y = await collectWindow({ ...opts(mismatch), previous: x })
  assert.throws(() => replayEpisodes([x, y]), /pair_amount_mismatch/)
})

test('offline verifier catches tampered raw receipt and broken chain', async () => {
  const f = fixture([event('request', 100)])
  const row = await collectWindow({ ...opts(f), startBlock: 100 })
  const bad = structuredClone(row)
  bad.events[0].rawReceipts[1].status = '0x0'
  reseal(bad)
  assert.throws(() => replayWindow(bad), /receipt_invalid/)
  const narrowed = structuredClone(row)
  narrowed.sources[0].logRead.request.params[0].topics = [topics.request]
  reseal(narrowed)
  assert.throws(() => replayWindow(narrowed), /log_query_invalid/)
  const root = await mkdtemp(join(tmpdir(), 'wylds-v2-'))
  try {
    await writeFile(join(root, '00000001.json'), `${JSON.stringify(row)}\n`)
    assert.equal((await readRows(root)).length, 1)
    const badState = structuredClone(row)
    badState.postStateSha256 = H(99).slice(2)
    reseal(badState)
    await writeFile(join(root, '00000001.json'), `${JSON.stringify(badState)}\n`)
    await assert.rejects(verifyLedger(root), /post_state_commitment_mismatch/)
    await writeFile(join(root, '00000001.json'), `${JSON.stringify(row)}\n`)
    const raw = JSON.parse(await readFile(join(root, '00000001.json'), 'utf8'))
    raw.scan.toHash = H(99)
    reseal(raw)
    await writeFile(join(root, '00000001.json'), `${JSON.stringify(raw)}\n`)
    await assert.rejects(readRows(root), /header_disagreement|canonicality/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('whole-run bound and synthetic collection use no live RPC', async () => {
  const f = fixture([], { head: 104 })
  const root = await mkdtemp(join(tmpdir(), 'wylds-v2-'))
  try {
    const result = await collectLifecycle({
      ...opts(f),
      root,
      startBlock: 100,
      maxWindows: 2,
      minimumFreeBytes: 0,
    })
    assert.equal(result.windows, 1)
    assert.equal(result.events, 0)
    assert.equal(result.blocksAdvanced, 5)
    assert.equal(result.tipBlock, 104)
    assert.equal(result.minimumFinalizedHeadObserved, 104)
    assert.equal(result.latestFinalizedHead, 104)
    assert.equal(result.remainingLagBlocks, 0)
    assert.equal(result.rpcCalls, f.calls.length)
    assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0)
    assert.ok(!JSON.stringify(result).includes(USER))
    assert.equal((await readRows(root)).length, 1)
    const before = f.calls.length
    const caughtUp = await collectLifecycle({
      ...opts(f),
      root,
      maxWindows: 2,
      minimumFreeBytes: 0,
    })
    assert.equal(caughtUp.windows, 0)
    assert.equal(caughtUp.blocksAdvanced, 0)
    assert.equal(caughtUp.tipBlock, 104)
    assert.equal(caughtUp.minimumFinalizedHeadObserved, 104)
    assert.equal(caughtUp.remainingLagBlocks, 0)
    assert.equal(caughtUp.rpcCalls, f.calls.length - before)
    assert.ok(caughtUp.rpcCalls > 0)
    await assert.rejects(
      collectLifecycle({ ...opts(f), root, maxWindows: 25, minimumFreeBytes: 0 }),
      /run_bounds_invalid/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cadence reports finalized lag after a bounded partial catch-up', async () => {
  const f = fixture([], { head: 114 })
  const root = await mkdtemp(join(tmpdir(), 'wylds-v2-cadence-'))
  try {
    const result = await collectLifecycle({
      ...opts(f),
      root,
      startBlock: 100,
      maxWindows: 2,
      minimumFreeBytes: 0,
    })
    assert.equal(result.windows, 2)
    assert.equal(result.blocksAdvanced, 10)
    assert.equal(result.tipBlock, 109)
    assert.equal(result.minimumFinalizedHeadObserved, 114)
    assert.equal(result.latestFinalizedHead, 114)
    assert.equal(result.remainingLagBlocks, 5)
    assert.equal(result.rpcCalls, f.calls.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('whole-run deadline rejects an RPC transport that ignores AbortSignal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wylds-v2-deadline-'))
  try {
    await assert.rejects(
      collectLifecycle({
        root,
        minimumFreeBytes: 0,
        urls: URLS,
        fetchImpl: () => new Promise(() => {}),
        runTimeoutMs: 10,
      }),
      /queue_v2_deadline/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dense window splits at a block boundary and single-block overflow blocks', async () => {
  const logs = [
    ...Array.from({ length: 12 }, (_, i) => event('cancel', 100, i)),
    event('cancel', 101),
  ]
  const f = fixture(logs)
  const first = await collectWindow({ ...opts(f), startBlock: 100 })
  assert.equal(first.scan.to, 100)
  assert.equal(first.events.length, 12)
  const next = await collectWindow({ ...opts(f), previous: first })
  assert.equal(next.scan.from, 101)
  assert.equal(next.events.length, 1)
  const blocked = fixture(Array.from({ length: 13 }, (_, i) => event('cancel', 100, i)))
  await assert.rejects(
    collectWindow({ ...opts(blocked), startBlock: 100 }),
    /single_block_overflow_hard_blocker/,
  )
})

test('checkpoint recovers a sealed row left after a crash before checkpoint update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wylds-v2-tail-'))
  try {
    await collectLifecycle({
      ...opts(fixture([], { head: 104 })),
      root,
      startBlock: 100,
      maxWindows: 1,
      minimumFreeBytes: 0,
    })
    const prior = (await readRows(root))[0]
    const f = fixture([], { head: 109 })
    const tail = await collectWindow({
      ...opts(f),
      previous: prior,
      state: await verifyLedger(root),
    })
    await writeFile(join(root, '00000002.json'), `${JSON.stringify(tail)}\n`)
    const resumed = await collectLifecycle({ ...opts(f), root, maxWindows: 1, minimumFreeBytes: 0 })
    assert.equal(resumed.windows, 0)
    assert.equal((await verifyLedger(root)).windows, 2)
    assert.equal(JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8')).windows, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('busy block payloads are compacted to proof headers, and block-global logIndex duplicates fail', async () => {
  const f = fixture([], { head: 104, busyHeaders: true })
  const row = await collectWindow({ ...opts(f), startBlock: 100 })
  assert.equal(row.sources[0].headers[0].transactions, undefined)
  assert.ok(Buffer.byteLength(JSON.stringify(row)) < 10_000)
  const a = event('cancel', 100, 0),
    b = event('cancel', 100, 1)
  b.logIndex = a.logIndex
  await assert.rejects(
    collectWindow({ ...opts(fixture([a, b])), startBlock: 100 }),
    /event_duplicate/,
  )
})

test('rehashable checkpoint with wrong pending state cannot append a duplicate request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wylds-v2-commit-'))
  try {
    const first = fixture([event('request', 100)], { head: 104 })
    await collectLifecycle({
      ...opts(first),
      root,
      startBlock: 100,
      maxWindows: 1,
      minimumFreeBytes: 0,
    })
    const checkpoint = JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8'))
    assert.equal(checkpoint.pending.length, 1)
    checkpoint.pending = []
    reseal(checkpoint)
    await writeFile(join(root, 'checkpoint.json'), `${JSON.stringify(checkpoint)}\n`)
    const next = fixture([event('request', 105)], { head: 109 })
    await assert.rejects(
      collectLifecycle({ ...opts(next), root, maxWindows: 1, minimumFreeBytes: 0 }),
      /checkpoint_state_mismatch/,
    )
    assert.equal((await verifyLedger(root)).windows, 1)
    await assert.rejects(readFile(join(root, '00000002.json')), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
