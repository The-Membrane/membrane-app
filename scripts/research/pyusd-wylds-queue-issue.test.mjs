import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseAbiItem, toEventSelector } from 'viem'

import {
  MAX_REQUESTS_PER_WINDOW,
  MAX_RPC_CALLS_PER_RUN,
  SCOPE,
  WINDOW_BLOCKS,
  issueQueueRequests,
  readIssues,
} from './pyusd-wylds-queue-issue.mjs'
import { WYLDS } from './pyusd-staking-economic-exit.mjs'

const URLS = ['https://one.example', 'https://two.example']
const USER = '0x6e2eaaec940e529cb428eaeedc7f5566a870de43'
const NOW = Date.UTC(2026, 9, 4, 12)
const BASE_SECONDS = NOW / 1000 - 3000
const TOPIC = toEventSelector(
  parseAbiItem(
    'event RedemptionRequested(address indexed user,uint256 shares,uint256 assets,uint256 timestamp)',
  ),
)
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const word = (n) => BigInt(n).toString(16).padStart(64, '0')
const time = (n) => BASE_SECONDS + n * 12
const file = (root, sequence) => join(root, `${String(sequence).padStart(8, '0')}.json`)

function fixture({
  head = 104,
  eventBlocks = [104],
  mismatch = false,
  failedReceipt = false,
  duplicate = false,
  brokenParent = false,
  receiptTransactionMismatch = false,
  receiptLogBlockMismatch = false,
  receiptLogTransactionMismatch = false,
  rejectCanonical = false,
  forkFinalizedHead = false,
  subwindowMismatch = false,
  busyTransactions = 0,
  duplicateBlockLogIndex = false,
  duplicateReceiptLogIndex = false,
} = {}) {
  const state = { head, calls: [] }
  const events = eventBlocks.map((block, index) => ({
    address: WYLDS,
    blockNumber: `0x${block.toString(16)}`,
    blockHash: hash(block),
    transactionHash: hash(block * 1000 + index),
    transactionIndex: `0x${(index + 1).toString(16)}`,
    logIndex: duplicateBlockLogIndex && index === 1 ? '0x2' : `0x${(index + 2).toString(16)}`,
    removed: false,
    topics: [TOPIC, `0x${USER.slice(2).padStart(64, '0')}`],
    data: `0x${word(400000)}${word(425073)}${word(time(block))}`,
  }))
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body)
    state.calls.push({ url, method: request.method, params: request.params })
    let result
    let error
    if (request.method === 'eth_chainId') result = '0x1'
    else if (request.method === 'eth_getBlockByNumber') {
      const block =
        request.params[0] === 'finalized' ? state.head : Number(BigInt(request.params[0]))
      result = {
        number: `0x${block.toString(16)}`,
        hash: forkFinalizedHead && request.params[0] === 'finalized' ? hash(9000) : hash(block),
        parentHash: brokenParent && block === 105 ? hash(1) : hash(block - 1),
        timestamp: `0x${time(block).toString(16)}`,
        transactions: Array.from({ length: busyTransactions }, (_, index) =>
          hash(block * 1000 + index),
        ),
      }
    } else if (request.method === 'eth_getLogs') {
      const query = request.params[0]
      const from = Number(BigInt(query.fromBlock))
      const to = Number(BigInt(query.toBlock))
      result = events.filter((event) => {
        const block = Number(BigInt(event.blockNumber))
        return block >= from && block <= to
      })
      if (mismatch && url === URLS[1]) result = []
      if (subwindowMismatch && url === URLS[1] && to - from + 1 < WINDOW_BLOCKS) result = []
      if (duplicate && result.length > 0) result = [...result, result[0]]
    } else if (request.method === 'eth_getTransactionReceipt') {
      const event = events.find((candidate) => candidate.transactionHash === request.params[0])
      result = event && {
        transactionHash: event.transactionHash,
        blockHash: event.blockHash,
        blockNumber: event.blockNumber,
        transactionIndex:
          receiptTransactionMismatch && url === URLS[1] ? '0x3' : event.transactionIndex,
        status: failedReceipt ? '0x0' : '0x1',
        logs: [
          {
            ...event,
            blockNumber:
              receiptLogBlockMismatch && url === URLS[1]
                ? `0x${(Number(BigInt(event.blockNumber)) + 1).toString(16)}`
                : event.blockNumber,
            transactionIndex:
              receiptLogTransactionMismatch && url === URLS[1] ? '0x3' : event.transactionIndex,
          },
          ...(duplicateReceiptLogIndex
            ? [{ ...event, address: '0x0000000000000000000000000000000000000001' }]
            : []),
        ],
      }
    } else if (request.method === 'eth_getBalance') {
      assert.equal(request.params[0], '0x0000000000000000000000000000000000000000')
      assert.equal(request.params[1].requireCanonical, true)
      if (rejectCanonical && url === URLS[1])
        error = { code: -32000, message: 'block not canonical' }
      else result = '0x0'
    } else throw Error(`unexpected_method_${request.method}`)
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }),
    }
  }
  return { state, fetchImpl }
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'wylds-queue-test-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const options = (root, source, extras = {}) => ({
  root,
  urls: URLS,
  fetchImpl: source.fetchImpl,
  nowMs: () => NOW,
  minimumFreeBytes: 0,
  maxWindows: 1,
  ...extras,
})

async function rewrite(root, sequence, change) {
  const path = file(root, sequence)
  const row = JSON.parse(await readFile(path, 'utf8'))
  change(row)
  const { sha256: _old, ...body } = row
  row.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  await writeFile(path, `${JSON.stringify(row)}\n`)
}

test('seals mined request and then a contiguous empty window with pre-start history unobserved', async () => {
  await withRoot(async (root) => {
    const source = fixture()
    const first = await issueQueueRequests(options(root, source))
    assert.equal(first.windows, 1)
    assert.equal(first.issued, 1)
    const request = first.rows[0].requests[0]
    assert.equal(first.rows[0].scope, SCOPE)
    assert.equal(first.rows[0].bootstrap.preStartHistory, 'unobserved')
    assert.equal(first.rows[0].bootstrap.startBlock, 100)
    assert.equal(first.rows[0].bootstrap.startHash, hash(100))
    assert.equal(first.rows[0].scan.to - first.rows[0].scan.from + 1, WINDOW_BLOCKS)
    assert.equal(request.event.user, USER)
    assert.equal(request.event.sharesRaw, '400000')
    assert.equal(request.event.usdcAssetsRaw, '425073')
    assert.equal(request.event.requestTimestamp, time(104))
    assert.equal(request.rawReceipts.length, 2)
    assert.equal(first.rows[0].queueOutstanding, 'not_assessed')
    assert.equal(first.rows[0].usdcPayout, 'not_attested')
    assert.equal(first.rows[0].finalPyusdPayout, 'not_attested')
    assert.equal('aggregateLiability' in first.rows[0], false)

    source.state.head = 109
    const second = await issueQueueRequests(options(root, source))
    assert.equal(second.windows, 1)
    assert.equal(second.issued, 0)
    assert.equal(second.rows[0].requests.length, 0)
    assert.equal(second.rows[0].scan.from, 105)
    assert.equal(second.rows[0].scan.fromParentHash, first.rows[0].scan.toHash)
    assert.equal(second.rows[0].previousSha256, first.rows[0].sha256)
    assert.equal((await readIssues(root)).length, 2)
    const repeated = await issueQueueRequests(options(root, source))
    assert.equal(repeated.windows, 0)
    assert.equal(repeated.issued, 0)
  })
})

test('bounded catch-up advances through empty windows before a later request', async () => {
  await withRoot(async (root) => {
    const source = fixture({ eventBlocks: [104, 112] })
    await issueQueueRequests(options(root, source))
    source.state.head = 119
    const result = await issueQueueRequests(options(root, source, { maxWindows: 24 }))
    assert.equal(result.windows, 3)
    assert.equal(result.issued, 1)
    assert.deepEqual(
      result.rows.map((row) => [row.scan.from, row.scan.to, row.requests.length]),
      [
        [105, 109, 0],
        [110, 114, 1],
        [115, 119, 0],
      ],
    )
    assert.equal((await readIssues(root)).length, 4)
  })
})

test('shared RPC budget spans windows while its default permits ten quiet catch-up windows', async () => {
  await withRoot(async (root) => {
    const source = fixture({ eventBlocks: [] })
    await issueQueueRequests(options(root, source))
    source.state.head = 154
    const priorCalls = source.state.calls.length
    const result = await issueQueueRequests(options(root, source, { maxWindows: 10 }))
    assert.equal(result.windows, 10)
    assert.equal(source.state.calls.length - priorCalls, 178)
    assert.equal(MAX_RPC_CALLS_PER_RUN >= 178, true)
    assert.equal((await readIssues(root)).length, 11)
  })
  await withRoot(async (root) => {
    const source = fixture({ eventBlocks: [] })
    await issueQueueRequests(options(root, source))
    source.state.head = 114
    const priorCalls = source.state.calls.length
    await assert.rejects(
      issueQueueRequests(options(root, source, { maxWindows: 2, maxRunRpcCalls: 20 })),
      /wylds_queue_run_rpc_budget_exhausted/,
    )
    assert.equal(source.state.calls.length - priorCalls, 20)
    const rows = await readIssues(root)
    assert.equal(rows.length, 2)
    assert.deepEqual([rows[1].scan.from, rows[1].scan.to], [105, 109])
  })
})

test('two-origin request-window mismatch leaves the cursor unchanged', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      issueQueueRequests(options(root, fixture({ mismatch: true }))),
      /direct_flow_origin_disagreement/,
    )
    assert.deepEqual(await readIssues(root), [])
  })
})

test('failed raw request receipt cannot advance the cursor', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      issueQueueRequests(options(root, fixture({ failedReceipt: true }))),
      /wylds_queue_receipt_invalid/,
    )
    assert.deepEqual(await readIssues(root), [])
  })
})

test('receipt transaction index and each log block/transaction index must match the pinned event', async () => {
  for (const variant of [
    { receiptTransactionMismatch: true, error: /wylds_queue_receipt_invalid/ },
    { receiptLogBlockMismatch: true, error: /wylds_queue_receipt_log_invalid/ },
    { receiptLogTransactionMismatch: true, error: /wylds_queue_receipt_log_invalid/ },
  ]) {
    await withRoot(async (root) => {
      const { error, ...fixtureOptions } = variant
      await assert.rejects(issueQueueRequests(options(root, fixture(fixtureOptions))), error)
      assert.deepEqual(await readIssues(root), [])
    })
  }
})

test('duplicate request log cannot be sealed', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      issueQueueRequests(options(root, fixture({ duplicate: true }))),
      /wylds_queue_duplicate_request_log/,
    )
    assert.deepEqual(await readIssues(root), [])
  })
})

test('block-global log indexes are unique across requests and every receipt log', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      issueQueueRequests(
        options(root, fixture({ eventBlocks: [104, 104], duplicateBlockLogIndex: true })),
      ),
      /wylds_queue_duplicate_block_log_index/,
    )
    assert.deepEqual(await readIssues(root), [])
  })
  await withRoot(async (root) => {
    await assert.rejects(
      issueQueueRequests(options(root, fixture({ duplicateReceiptLogIndex: true }))),
      /wylds_queue_duplicate_receipt_log_index/,
    )
    assert.deepEqual(await readIssues(root), [])
  })
})

test('busy block transaction arrays are removed from the sealed four-field witnesses', async () => {
  await withRoot(async (root) => {
    const source = fixture({ eventBlocks: [], busyTransactions: 500 })
    const result = await issueQueueRequests(options(root, source))
    assert.equal(result.windows, 1)
    assert.equal(result.issued, 0)
    assert.equal((await readFile(file(root, 1))).byteLength < 20_000, true)
    const fields = ['hash', 'number', 'parentHash', 'timestamp']
    for (const witness of result.rows[0].sources) {
      assert.deepEqual(Object.keys(witness.finalizedHead).sort(), fields)
      for (const header of witness.headers) assert.deepEqual(Object.keys(header).sort(), fields)
    }
    assert.equal((await readIssues(root)).length, 1)
  })
})

test('overfull five-block discovery splits at a block boundary without gaps or duplicates', async () => {
  await withRoot(async (root) => {
    const source = fixture({ eventBlocks: [...Array(12).fill(100), 101] })
    const first = await issueQueueRequests(options(root, source))
    assert.equal(first.windows, 1)
    assert.deepEqual([first.rows[0].scan.from, first.rows[0].scan.to], [100, 100])
    assert.equal(first.issued, 12)
    assert.equal(first.rows[0].requests.length <= MAX_REQUESTS_PER_WINDOW, true)
    assert.equal(
      first.rows[0].sources.every((item) => item.canonicalRead !== null),
      true,
    )
    assert.equal(source.state.calls.filter((call) => call.method === 'eth_getLogs').length, 4)
    assert.equal(source.state.calls.length, 44)

    source.state.head = 109
    const second = await issueQueueRequests(options(root, source))
    assert.deepEqual([second.rows[0].scan.from, second.rows[0].scan.to], [101, 105])
    assert.equal(second.issued, 1)
    const rows = await readIssues(root)
    assert.equal(rows[1].scan.fromParentHash, rows[0].scan.toHash)
    assert.equal(rows[1].previousSha256, rows[0].sha256)
    const keys = rows.flatMap((row) =>
      row.requests.map((request) => `${request.event.transactionHash}:${request.event.logIndex}`),
    )
    assert.equal(new Set(keys).size, 13)
  })
})

test('a single block with more than twelve requests fails closed and cannot advance the cursor', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      issueQueueRequests(options(root, fixture({ eventBlocks: Array(13).fill(100) }))),
      /wylds_queue_single_block_overflow_hard_blocker/,
    )
    assert.deepEqual(await readIssues(root), [])
  })
})

test('adaptive subwindows still require two-origin logs, canonicality, and successful bound receipts', async () => {
  const eventBlocks = [...Array(8).fill(100), ...Array(5).fill(101)]
  for (const [variant, error] of [
    [{ subwindowMismatch: true }, /direct_flow_origin_disagreement/],
    [{ rejectCanonical: true }, /wylds_queue_canonicality_unproved/],
    [{ receiptLogTransactionMismatch: true }, /wylds_queue_receipt_log_invalid/],
  ]) {
    await withRoot(async (root) => {
      await assert.rejects(
        issueQueueRequests(options(root, fixture({ eventBlocks, ...variant }))),
        error,
      )
      assert.deepEqual(await readIssues(root), [])
    })
  }
})

test('whole-run deadline interrupts an in-flight RPC and leaves the cursor unchanged', async () => {
  await withRoot(async (root) => {
    const source = fixture()
    const fetchImpl = (url, init) => {
      const request = JSON.parse(init.body)
      if (request.method === 'eth_getLogs') return new Promise(() => {})
      return source.fetchImpl(url, init)
    }
    const started = Date.now()
    await assert.rejects(
      issueQueueRequests(options(root, { fetchImpl }, { runTimeoutMs: 25 })),
      /wylds_queue_run_deadline/,
    )
    assert.equal(Date.now() - started < 500, true)
    assert.deepEqual(await readIssues(root), [])
  })
})

test('deadline during a later window preserves the last sealed tip', async () => {
  await withRoot(async (root) => {
    const source = fixture()
    const first = await issueQueueRequests(options(root, source))
    source.state.head = 109
    const fetchImpl = (url, init) => {
      if (JSON.parse(init.body).method === 'eth_getLogs') return new Promise(() => {})
      return source.fetchImpl(url, init)
    }
    await assert.rejects(
      issueQueueRequests(options(root, { fetchImpl }, { runTimeoutMs: 25 })),
      /wylds_queue_run_deadline/,
    )
    const rows = await readIssues(root)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sha256, first.rows[0].sha256)
  })
})

test('a previously sealed archive is replayed before any advancing RPC', async () => {
  await withRoot(async (root) => {
    const source = fixture()
    await issueQueueRequests(options(root, source))
    await rewrite(root, 1, (row) => {
      row.requests[0].rawReceipts[0].status = '0x0'
    })
    source.state.head = 109
    const priorCalls = source.state.calls.length
    await assert.rejects(issueQueueRequests(options(root, source)), /wylds_queue_receipt_invalid/)
    assert.equal(source.state.calls.length, priorCalls)
  })
})

test('five-block rows from the earlier discovery label still replay and chain forward', async () => {
  await withRoot(async (root) => {
    const source = fixture()
    await issueQueueRequests(options(root, source))
    await rewrite(root, 1, (row) => {
      row.discovery = 'two_origin_contiguous_five_block_request_log_agreement'
      for (const witness of row.sources) {
        witness.finalizedHead.transactions = [hash(1)]
        for (const header of witness.headers) header.transactions = [hash(1)]
      }
    })
    source.state.head = 109
    const next = await issueQueueRequests(options(root, source))
    assert.equal(next.rows[0].previousSha256, (await readIssues(root))[0].sha256)
    assert.equal(next.rows[0].scan.from, 105)
  })
})

test('receipt and scope tampering fail offline even after the local SHA is recomputed', async () => {
  await withRoot(async (root) => {
    await issueQueueRequests(options(root, fixture()))
    await rewrite(root, 1, (row) => {
      row.requests[0].rawReceipts[0].status = '0x0'
    })
    await assert.rejects(readIssues(root), /wylds_queue_receipt_invalid/)
  })
  await withRoot(async (root) => {
    await issueQueueRequests(options(root, fixture()))
    await rewrite(root, 1, (row) => {
      row.finalPyusdPayout = 'attested'
    })
    await assert.rejects(readIssues(root), /wylds_queue_issue_invalid/)
  })
  await withRoot(async (root) => {
    await issueQueueRequests(options(root, fixture()))
    await rewrite(root, 1, (row) => {
      row.aggregateLiability = '425073'
    })
    await assert.rejects(readIssues(root), /wylds_queue_issue_invalid/)
  })
})

test('parent-hash mismatch cannot skip a window or alter the prior seal', async () => {
  await withRoot(async (root) => {
    const source = fixture({ brokenParent: true })
    const first = await issueQueueRequests(options(root, source))
    source.state.head = 109
    await assert.rejects(issueQueueRequests(options(root, source)), /wylds_queue_parent_mismatch/)
    const rows = await readIssues(root)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sha256, first.rows[0].sha256)
  })
})

test('a behind-finality window requires an exact-hash canonical read at both origins', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      issueQueueRequests(options(root, fixture({ forkFinalizedHead: true }))),
      /wylds_queue_finalized_hash_mismatch/,
    )
    assert.deepEqual(await readIssues(root), [])
  })
  await withRoot(async (root) => {
    const source = fixture({ rejectCanonical: true })
    const first = await issueQueueRequests(options(root, source))
    source.state.head = 114
    await assert.rejects(
      issueQueueRequests(options(root, source)),
      /wylds_queue_canonicality_unproved/,
    )
    assert.equal(source.state.calls.filter((call) => call.method === 'eth_getBalance').length, 2)
    const rows = await readIssues(root)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sha256, first.rows[0].sha256)
  })
  await withRoot(async (root) => {
    const source = fixture()
    await issueQueueRequests(options(root, source))
    source.state.head = 114
    await issueQueueRequests(options(root, source))
    await rewrite(root, 2, (row) => {
      row.sources[0].canonicalRead = null
    })
    await assert.rejects(readIssues(root), /wylds_queue_canonicality_unproved/)
  })
})

test('disk reserve fails before any RPC', async () => {
  await withRoot(async (root) => {
    const source = fixture()
    await assert.rejects(
      issueQueueRequests(options(root, source, { minimumFreeBytes: Number.MAX_SAFE_INTEGER })),
      /wylds_queue_disk_reserve/,
    )
    assert.equal(source.state.calls.length, 0)
  })
})
