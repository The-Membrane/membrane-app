import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeFunctionResult, parseAbi } from 'viem'
import {
  collect,
  collectToLatestQuote,
  MAX_PACE_MS,
  parseOptions,
  selectRpc,
  sourceIdentity,
  verify,
  verifyLatestQuoteAlignment,
} from './curve-vault-flow-ledger.mjs'

const source = sourceIdentity()
const fixedNow = () => new Date('2026-09-27T20:00:00.000Z')
const stat = () => ({ bavail: 10_000_000, bsize: 4096 })
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const q = (n) => `0x${n.toString(16)}`
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const topicAddress = (n) => `0x${n.toString(16).padStart(64, '0')}`
const assetAbi = parseAbi(['function asset() view returns (address)'])
const assetResult = encodeFunctionResult({
  abi: assetAbi,
  functionName: 'asset',
  result: source.asset,
})
const log = (kind, blockNumber, index = 0) => {
  const stream = source.streams.find((x) => x.kind === kind)
  const topics =
    kind === 'deposit'
      ? [stream.topic0, topicAddress(1), topicAddress(2)]
      : [stream.topic0, topicAddress(1), topicAddress(3), topicAddress(2)]
  return {
    address: source.vault,
    blockNumber: q(blockNumber),
    blockHash: hash(blockNumber),
    transactionHash: hash(blockNumber * 100 + index + 1),
    transactionIndex: q(index),
    logIndex: q(index),
    removed: false,
    topics,
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [100n, 98n]),
  }
}
function mock({ finalized = 20, logs = [], failRange = null, after = null } = {}) {
  const calls = []
  return {
    calls,
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'finalized' ? finalized : Number(BigInt(params[0]))
        return { number: q(n), hash: hash(n), timestamp: q(1_790_530_000 + n) }
      }
      if (method === 'eth_call') return assetResult
      if (method === 'eth_getLogs') {
        const from = Number(BigInt(params[0].fromBlock))
        const to = Number(BigInt(params[0].toBlock))
        if (failRange?.(from, to)) throw new Error('query returned more than 1000 results')
        after?.(from, to)
        const requested = Array.isArray(params[0].topics[0])
          ? params[0].topics[0]
          : [params[0].topics[0]]
        return logs
          .filter(
            (row) =>
              Number(BigInt(row.blockNumber)) >= from && Number(BigInt(row.blockNumber)) <= to,
          )
          .filter((row) => requested.includes(row.topics[0]))
      }
      throw new Error(`Unexpected mock method ${method}`)
    },
  }
}
const withOut = async (fn) => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-flow-test-'))
  try {
    await fn(out)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
const run = (client, out, extras = {}) =>
  collect({
    client,
    out,
    source,
    fromBlock: 10,
    maxChunks: 1,
    range: 3,
    rpcHost: 'example.org',
    now: fixedNow,
    stat,
    ...extras,
  })

test('a quiet finalized chunk has a sealed zero-event coverage receipt', async () =>
  withOut(async (out) => {
    const client = mock()
    const result = await run(client, out)
    assert.equal(result.saved, 1)
    assert.equal(result.throughBlock, 12)
    assert.deepEqual(verify({ out, source }).throughBlock, 12)
    const p = JSON.parse(readFileSync(result.paths[0], 'utf8'))
    assert.deepEqual(p.counts, { deposit: 0, withdraw: 0 })
    assert.deepEqual(p.events, [])
    assert.equal(p.range.from.hash, hash(10))
    assert.equal(p.range.to.hash, hash(12))
    assert.equal(client.calls.filter((x) => x.method === 'eth_getLogs').length, 3)
  }))

test('Deposit and Withdraw decode exact raw assets, shares, actors and coordinates', async () =>
  withOut(async (out) => {
    const client = mock({ logs: [log('withdraw', 12, 1), log('deposit', 11)] })
    const result = await run(client, out)
    const p = JSON.parse(readFileSync(result.paths[0], 'utf8'))
    assert.deepEqual(p.counts, { deposit: 1, withdraw: 1 })
    assert.deepEqual(
      p.events.map((x) => x.kind),
      ['deposit', 'withdraw'],
    )
    assert.equal(p.events[0].assetsRaw, '100')
    assert.equal(p.events[0].sharesRaw, '98')
    assert.equal(p.events[1].actors.receiver, address(3))
    assert.equal(p.events[0].blockTimestamp, 1_790_530_011)
    assert.equal(verify({ out, source }).count, 1)
  }))

test('crash before append leaves frontier; retry fills it and resumes from receipt, not event', async () =>
  withOut(async (out) => {
    const first = mock({
      after: () => {
        throw new Error('connection died')
      },
    })
    await assert.rejects(run(first, out), /connection died/)
    assert.equal(verify({ out, source }).count, 0)
    const good = mock()
    await run(good, out)
    const continuation = await run(good, out, { fromBlock: undefined })
    assert.equal(continuation.throughBlock, 15)
    assert.equal(verify({ out, source }).count, 2)
    const second = JSON.parse(readFileSync(continuation.paths[0], 'utf8'))
    assert.equal(second.range.from.number, 13)
    assert.equal(
      second.previousReceiptSha256,
      JSON.parse(readFileSync(join(out, readdirSync(out).sort()[0]), 'utf8')).sha256,
    )
  }))

test('offline verification rejects gap, overlap and duplicate receipt', async () =>
  withOut(async (out) => {
    const client = mock()
    await run(client, out)
    await run(client, out, { fromBlock: undefined })
    const files = readdirSync(out).sort()
    const second = JSON.parse(readFileSync(join(out, files[1]), 'utf8'))
    second.range.from.number = 14
    second.sha256 = createHash('sha256')
      .update(
        JSON.stringify(
          Object.fromEntries(Object.entries(second).filter(([key]) => key !== 'sha256')),
        ),
      )
      .digest('hex')
    writeFileSync(join(out, files[1]), `${JSON.stringify(second)}\n`)
    assert.throws(() => verify({ out, source }), /gap or overlap/)
    rmSync(join(out, files[1]))
    const copy = JSON.parse(readFileSync(join(out, files[0]), 'utf8'))
    writeFileSync(join(out, `999999999999-${files[0]}`), `${JSON.stringify(copy)}\n`)
    assert.throws(
      () => verify({ out, source }),
      /filename mismatch|gap or overlap|Invalid vault flow receipt/,
    )
  }))

test('tamper of raw event or sealed fields fails verification', async () =>
  withOut(async (out) => {
    const result = await run(mock({ logs: [log('deposit', 11)] }), out)
    const p = JSON.parse(readFileSync(result.paths[0], 'utf8'))
    p.events[0].assetsRaw = '101'
    writeFileSync(result.paths[0], `${JSON.stringify(p)}\n`)
    assert.throws(() => verify({ out, source }), /SHA mismatch/)
    p.sha256 = createHash('sha256')
      .update(
        JSON.stringify(Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'sha256'))),
      )
      .digest('hex')
    writeFileSync(result.paths[0], `${JSON.stringify(p)}\n`)
    assert.throws(() => verify({ out, source }), /fields mismatch/)
  }))

test('known RPC log cap splits; unknown provider failure does not turn into quiet coverage', async () =>
  withOut(async (out) => {
    const split = mock({ failRange: (from, to) => from === 10 && to === 12 })
    const result = await run(split, out)
    assert.equal(result.throughBlock, 10)
    assert.equal(verify({ out, source }).throughBlock, 10)
    const bad = mock({
      after: () => {
        throw new Error('provider unavailable')
      },
    })
    await assert.rejects(run(bad, out, { fromBlock: undefined }), /provider unavailable/)
    assert.equal(verify({ out, source }).throughBlock, 10)
  }))

test('duplicate RPC log and wrong onchain identity cannot be sealed', async () =>
  withOut(async (out) => {
    const duplicate = mock({ logs: [log('deposit', 11), log('deposit', 11)] })
    await assert.rejects(run(duplicate, out), /Duplicate RPC vault log/)
    assert.equal(verify({ out, source }).count, 0)
    const wrong = mock()
    const base = wrong.request
    wrong.request = async (request) =>
      request.method === 'eth_call'
        ? encodeFunctionResult({ abi: assetAbi, functionName: 'asset', result: address(99) })
        : base(request)
    await assert.rejects(run(wrong, out), /asset identity mismatch/)
  }))

test('combined and per-stream RPC disagreement is not certified as coverage', async () =>
  withOut(async (out) => {
    const client = mock({ logs: [log('deposit', 11)] })
    const base = client.request
    client.request = async (request) =>
      request.method === 'eth_getLogs' && request.params[0].topics[0] === source.streams[0].topic0
        ? []
        : base(request)
    await assert.rejects(run(client, out), /Combined and per-stream vault log mismatch/)
    assert.equal(verify({ out, source }).count, 0)
  }))

test('an exact 1000-log combined response is split before any coverage receipt is sealed', async () =>
  withOut(async (out) => {
    const client = mock()
    const base = client.request
    client.request = async (request) => {
      if (
        request.method === 'eth_getLogs' &&
        Array.isArray(request.params[0].topics[0]) &&
        request.params[0].fromBlock === q(10) &&
        request.params[0].toBlock === q(12)
      )
        return Array(1000).fill(log('deposit', 11))
      return base(request)
    }
    const result = await run(client, out)
    assert.equal(result.throughBlock, 10)
    assert.equal(verify({ out, source }).throughBlock, 10)
  }))

test('an exact 1000-log per-stream response is also split', async () =>
  withOut(async (out) => {
    const client = mock()
    const base = client.request
    client.request = async (request) => {
      if (
        request.method === 'eth_getLogs' &&
        request.params[0].topics[0] === source.streams[0].topic0 &&
        request.params[0].fromBlock === q(10) &&
        request.params[0].toBlock === q(12)
      )
        return Array(1000).fill(log('deposit', 11))
      return base(request)
    }
    const result = await run(client, out)
    assert.equal(result.throughBlock, 10)
    assert.equal(verify({ out, source }).throughBlock, 10)
  }))

test('asset identity is checked against both finalized boundary hashes', async () =>
  withOut(async (out) => {
    const client = mock()
    const base = client.request
    client.request = async (request) =>
      request.method === 'eth_call' && request.params[1].blockHash === hash(12)
        ? encodeFunctionResult({ abi: assetAbi, functionName: 'asset', result: address(99) })
        : base(request)
    await assert.rejects(run(client, out), /asset identity mismatch/)
    assert.equal(verify({ out, source }).count, 0)
    const good = mock()
    await run(good, out)
    assert.deepEqual(
      good.calls.filter((x) => x.method === 'eth_call').map((x) => x.params[1].blockHash),
      [hash(10), hash(12)],
    )
  }))

test('RPC index selects one configured host without exposing URL credentials', () => {
  const configured = 'https://user:secret@first.example/rpc,https://key:private@second.example/rpc'
  const selected = selectRpc(undefined, configured, 1)
  assert.equal(selected.host, 'second.example')
  assert.equal(selected.url, 'https://key:private@second.example/rpc')
  assert.equal(selectRpc(undefined, configured).host, 'first.example')
  assert.throws(() => selectRpc(undefined, configured, 2), /index unavailable/)
  assert.throws(() => selectRpc(undefined, configured, -1), /Invalid RPC index/)
  assert.throws(() => selectRpc(undefined, 'https://first.example,', 1), /index unavailable/)
  assert.deepEqual(parseOptions(['--run', '--rpc-index', '1']), {
    '--run': true,
    '--rpc-index': '1',
  })
  assert.throws(
    () => parseOptions(['--run', '--rpc', 'https://first.example', '--rpc-index', '1']),
    /Incompatible options/,
  )
  assert.throws(() => parseOptions(['--rpc-index', '1']), /Incompatible options/)
})

test('inclusive to-block cap bounds log queries and remains idempotent after resume', async () =>
  withOut(async (out) => {
    const client = mock({ finalized: 20, logs: [log('deposit', 13)] })
    const first = await run(client, out, { toBlock: 13 })
    assert.equal(first.throughBlock, 12)
    assert.equal(first.completeThroughTarget, false)
    const second = await run(client, out, { fromBlock: undefined, toBlock: 13 })
    assert.equal(second.throughBlock, 13)
    assert.equal(second.completeThroughTarget, true)
    assert.equal(second.completeThroughFinalized, false)
    const third = await run(client, out, { fromBlock: undefined, toBlock: 13 })
    assert.equal(third.saved, 0)
    assert.equal(third.throughBlock, 13)
    assert.equal(verify({ out, source }).throughBlock, 13)
    assert.ok(
      client.calls
        .filter((call) => call.method === 'eth_getLogs')
        .every((call) => Number(BigInt(call.params[0].toBlock)) <= 13),
    )
    await assert.rejects(
      run(client, out, { fromBlock: undefined, toBlock: 12 }),
      /Coverage exceeds requested to-block/,
    )
  }))

test('latest quote mode seals exactly at the checkpoint block and hash', async () =>
  withOut(async (out) => {
    const checkpoints = [
      { checkpoint: { block: { number: 13, hash: hash(13) }, sha256: 'quote-seal' } },
    ]
    const client = mock({ finalized: 20, logs: [log('withdraw', 13)] })
    const first = await collectToLatestQuote({
      client,
      out,
      source,
      checkpoints,
      fromBlock: 10,
      maxChunks: 2,
      range: 3,
      rpcHost: 'example.org',
      now: fixedNow,
      stat,
    })
    assert.equal(first.throughBlock, 13)
    assert.equal(first.completeThroughTarget, true)
    assert.equal(first.quoteCheckpointSha256, 'quote-seal')
    assert.equal(verifyLatestQuoteAlignment({ out, source, checkpoints }).throughBlock, 13)
    assert.ok(
      client.calls
        .filter((call) => call.method === 'eth_getLogs')
        .every((call) => Number(BigInt(call.params[0].toBlock)) <= 13),
    )
    const again = await collectToLatestQuote({
      client,
      out,
      source,
      checkpoints,
      maxChunks: 2,
      range: 3,
      rpcHost: 'example.org',
      now: fixedNow,
      stat,
    })
    assert.equal(again.saved, 0)
  }))

test('latest quote mode fails closed after partial catch-up or a prior straddle', async () =>
  withOut(async (out) => {
    const checkpoints = [
      { checkpoint: { block: { number: 15, hash: hash(15) }, sha256: 'quote-seal' } },
    ]
    const client = mock({ finalized: 20 })
    await assert.rejects(
      collectToLatestQuote({
        client,
        out,
        source,
        checkpoints,
        fromBlock: 10,
        maxChunks: 1,
        range: 3,
        rpcHost: 'example.org',
        now: fixedNow,
        stat,
      }),
      /did not reach latest quote block/,
    )
    assert.equal(verify({ out, source }).throughBlock, 12)
    assert.throws(() => verifyLatestQuoteAlignment({ out, source, checkpoints }), /not aligned/)
    await run(client, out, { fromBlock: undefined, toBlock: 17, range: 10 })
    await assert.rejects(
      collectToLatestQuote({
        client,
        out,
        source,
        checkpoints,
        maxChunks: 2,
        range: 3,
        rpcHost: 'example.org',
        now: fixedNow,
        stat,
      }),
      /Coverage exceeds requested to-block/,
    )
    assert.equal(verify({ out, source }).throughBlock, 17)
  }))

test('latest quote mode rejects flow RPC checkpoint hash mismatch before writing', async () =>
  withOut(async (out) => {
    const checkpoints = [
      { checkpoint: { block: { number: 12, hash: hash(999) }, sha256: 'quote-seal' } },
    ]
    await assert.rejects(
      collectToLatestQuote({
        client: mock(),
        out,
        source,
        checkpoints,
        fromBlock: 10,
        maxChunks: 1,
        range: 3,
        rpcHost: 'example.org',
        now: fixedNow,
        stat,
      }),
      /Flow RPC quote block hash mismatch/,
    )
    assert.equal(verify({ out, source }).count, 0)
  }))

test('latest quote mode rejects a flow RPC whose finalized head trails the checkpoint', async () =>
  withOut(async (out) => {
    const checkpoints = [
      { checkpoint: { block: { number: 21, hash: hash(21) }, sha256: 'quote-seal' } },
    ]
    await assert.rejects(
      collectToLatestQuote({
        client: mock({ finalized: 20 }),
        out,
        source,
        checkpoints,
        fromBlock: 10,
        maxChunks: 1,
        range: 3,
        rpcHost: 'example.org',
        now: fixedNow,
        stat,
      }),
      /not finalized on flow RPC/,
    )
    assert.equal(verify({ out, source }).count, 0)
  }))

test('historical CLI mode is explicit and cannot override frozen bounds', () => {
  assert.deepEqual(parseOptions(['--run', '--historical', '--max-chunks', '4']), {
    '--run': true,
    '--historical': true,
    '--max-chunks': '4',
  })
  assert.deepEqual(parseOptions(['--verify', '--historical']), {
    '--verify': true,
    '--historical': true,
  })
  assert.throws(() => parseOptions(['--run', '--historical', '--to-block', '12']), /Incompatible/)
  assert.throws(() => parseOptions(['--run', '--historical', '--from-block', '10']), /Incompatible/)
  assert.throws(() => parseOptions(['--to-block', '12']), /Incompatible/)
  assert.deepEqual(parseOptions(['--run', '--to-block', '12']), {
    '--run': true,
    '--to-block': '12',
  })
  assert.deepEqual(parseOptions(['--run', '--to-latest-quote']), {
    '--run': true,
    '--to-latest-quote': true,
  })
  assert.deepEqual(parseOptions(['--verify', '--to-latest-quote']), {
    '--verify': true,
    '--to-latest-quote': true,
  })
  assert.throws(
    () => parseOptions(['--run', '--to-latest-quote', '--to-block', '12']),
    /Incompatible/,
  )
  assert.throws(() => parseOptions(['--run', '--historical', '--to-latest-quote']), /Incompatible/)
})

test('optional pacing spaces every RPC method including event block reads without real sleeps', async () =>
  withOut(async (out) => {
    let elapsed = 0
    const starts = []
    const sleeps = []
    const client = mock({ logs: [log('deposit', 11)] })
    const original = client.request
    client.request = async (request) => {
      starts.push({ method: request.method, at: elapsed })
      return original(request)
    }
    await run(client, out, {
      paceMs: 250,
      monotonicMs: () => elapsed,
      sleep: async (ms) => {
        sleeps.push(ms)
        elapsed += ms
      },
    })
    assert.ok(starts.length >= 10)
    assert.ok(starts.some((request) => request.method === 'eth_chainId'))
    assert.ok(starts.some((request) => request.method === 'eth_call'))
    assert.ok(starts.some((request) => request.method === 'eth_getLogs'))
    assert.ok(starts.filter((request) => request.method === 'eth_getBlockByNumber').length >= 5)
    assert.deepEqual(
      starts.map((request) => request.at),
      starts.map((_, index) => index * 250),
    )
    assert.deepEqual(sleeps, Array(starts.length - 1).fill(250))
    assert.equal(verify({ out, source }).throughBlock, 12)
  }))

test('HTTP 429 stops before the next receipt and resume starts at sealed frontier', async () =>
  withOut(async (out) => {
    let elapsed = 0
    const client = mock({
      after: (from) => {
        if (from === 13) {
          const error = new Error('HTTP 429 Too many requests; exceeds results cap')
          error.status = 429
          throw error
        }
      },
    })
    await assert.rejects(
      run(client, out, {
        maxChunks: 2,
        paceMs: 1,
        monotonicMs: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms
        },
      }),
      /429/,
    )
    assert.equal(verify({ out, source }).throughBlock, 12)
    assert.equal(verify({ out, source }).count, 1)
    const resumed = await run(mock(), out, { fromBlock: undefined })
    assert.equal(resumed.throughBlock, 15)
    assert.equal(verify({ out, source }).count, 2)
  }))

test('pace option is bounded and requires collection mode', async () =>
  withOut(async (out) => {
    assert.deepEqual(parseOptions(['--run', '--historical', '--pace-ms', '250']), {
      '--run': true,
      '--historical': true,
      '--pace-ms': '250',
    })
    assert.throws(() => parseOptions(['--pace-ms', '250']), /Incompatible options/)
    const client = mock()
    await assert.rejects(run(client, out, { paceMs: MAX_PACE_MS + 1 }), /bounded scan options/)
    assert.equal(client.calls.length, 0)
    assert.equal(verify({ out, source }).count, 0)
  }))
