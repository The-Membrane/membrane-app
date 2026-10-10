import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import {
  backfillDirectSupplierFlow,
  directRpcRing,
  MIN_FREE_BYTES,
  safeDirectOriginFailureClass,
} from './backfill-carry-direct-supplier-flow.mjs'

test('origin failure telemetry exposes only fixed transport classes', () => {
  const rateLimit = Object.assign(new Error('https://private.example/secret'), {
    name: 'HttpRequestError',
    status: 429,
  })
  assert.equal(safeDirectOriginFailureClass(rateLimit), 'http_429')
  assert.equal(safeDirectOriginFailureClass({ name: 'TimeoutError' }), 'timeout')
  assert.equal(
    safeDirectOriginFailureClass(new Error('https://private.example/secret')),
    'source_or_proof',
  )
})
import {
  collectDirectSupplierFlowSegment,
  verifyDirectSupplierFlowSegment,
  verifyDirectSupplierFlowSegments,
} from './collect-carry-direct-supplier-flow.mjs'
import { readDirectSupplierFlowPublicationWitness } from './carry-direct-supplier-flow-publication-witness.mjs'

const marketKey = 'aaveV3Usdc'
const generousDisk = () => ({ bavail: 2 * MIN_FREE_BYTES, bsize: 1 })
test('direct supplier write floor is two GiB', () => {
  assert.equal(MIN_FREE_BYTES, 2 * 1024 ** 3)
})
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const temp = () => mkdtempSync(join(tmpdir(), 'direct-flow-backfill-'))
const WITHDRAW = parseAbiItem(
  'event Withdraw(address indexed reserve,address indexed user,address indexed to,uint256 amount)',
)
const positiveLog = {
  address: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  blockNumber: '0x64',
  blockHash: hash(100),
  transactionHash: hash(900),
  transactionIndex: '0x0',
  logIndex: '0x1',
  removed: false,
  topics: encodeEventTopics({
    abi: [WITHDRAW],
    eventName: 'Withdraw',
    args: {
      reserve: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      user: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
    },
  }),
  data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]),
}

function rpc({ broken = false, positive = false } = {}) {
  return {
    async request({ method, params }) {
      if (broken) {
        const error = new Error('https://vendor.example/secret-rpc-token')
        error.name = 'HttpRequestError'
        error.status = 429
        throw error
      }
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'finalized' ? 1000 : Number(BigInt(params[0]))
        return {
          number: `0x${n.toString(16)}`,
          hash: hash(n),
          parentHash: hash(n - 1),
          timestamp: `0x${(1000 + (n - 100) * 12).toString(16)}`,
        }
      }
      if (method === 'eth_getLogs') return positive ? [positiveLog] : []
      throw new Error('unexpected_rpc_method')
    },
  }
}

async function sealed(fromBlock, toBlock, selectedMarket = marketKey) {
  return (
    await collectDirectSupplierFlowSegment({
      primary: rpc(),
      secondary: rpc(),
      primaryOrigin: 'https://first.example',
      secondaryOrigin: 'https://second.example',
      marketKey: selectedMarket,
      fromBlock,
      toBlock,
    })
  ).document
}

test('USDe anchor hash rejects first segment before publication and on resume', async () => {
  const dir = temp()
  const options = base(dir, {
    marketKey: 'aaveV3Usde',
    fromBlock: 100,
    toBlock: 100,
    expectedFirstBlockHash: hash(999),
    clientFactory: () => rpc(),
  })
  try {
    await assert.rejects(backfillDirectSupplierFlow(options), /direct_source_disagreement/)
    assert.equal(
      readdirSync(dir).some((name) => name.startsWith('aaveV3Usde-')),
      false,
    )
    const first = await sealed(100, 100, 'aaveV3Usde')
    writeSegment(dir, first)
    await assert.rejects(backfillDirectSupplierFlow(options), /direct_usde_anchor_segment_mismatch/)
    const resumed = await backfillDirectSupplierFlow({
      ...options,
      expectedFirstBlockHash: hash(100),
    })
    assert.equal(resumed.resumedSegments, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function writeSegment(dir, doc) {
  const { fromBlock, toBlock } = doc.range
  writeFileSync(
    join(dir, `${doc.marketKey}-${fromBlock}-${toBlock}.json`),
    `${JSON.stringify(doc)}\n`,
    { flag: 'wx', mode: 0o444 },
  )
}

const base = (dir, extras = {}) => ({
  marketKey,
  fromBlock: 100,
  toBlock: 101,
  outDir: dir,
  maxSegments: 1,
  rpcUrls: 'https://bad.example/path,https://good-one.example/path,https://good-two.example/path',
  stat: generousDisk,
  clientFactory: (url) => rpc({ broken: url.includes('bad.example') }),
  ...extras,
})

test('deduplicates configured RPC origins and needs two independent origins', () => {
  assert.deepEqual(
    directRpcRing('https://a.example/key1,https://a.example/key2,https://b.example'),
    [
      { url: 'https://a.example/key1', origin: 'https://a.example' },
      { url: 'https://b.example', origin: 'https://b.example' },
    ],
  )
  assert.throws(
    () => directRpcRing('https://a.example/x,https://a.example/y'),
    /two_distinct_direct_rpc_origins_required/,
  )
  assert.throws(
    () => directRpcRing(Array.from({ length: 9 }, (_, i) => `https://rpc-${i}.example`).join(',')),
    /too_many_direct_rpc_origins/,
  )
})

test('falls back to a different pair and resumes immutable one-block evidence', async () => {
  const dir = temp()
  try {
    const first = await sealed(100, 100)
    writeSegment(dir, first)
    const prior = readFileSync(join(dir, `${marketKey}-100-100.json`), 'utf8')
    const result = await backfillDirectSupplierFlow(base(dir))
    assert.equal(result.status, 'complete')
    assert.equal(result.resumedSegments, 1)
    assert.equal(result.newSegments, 1)
    assert.equal(result.throughBlock, 101)
    assert.equal(readFileSync(join(dir, `${marketKey}-100-100.json`), 'utf8'), prior)
    const newDoc = JSON.parse(readFileSync(join(dir, `${marketKey}-101-101.json`), 'utf8'))
    verifyDirectSupplierFlowSegments([first, newDoc])
    assert.equal(newDoc.logQueries[0].slices.length, 1)
    assert.equal(verifyDirectSupplierFlowSegment(newDoc).candidateCount, 0)
    assert.equal(
      readDirectSupplierFlowPublicationWitness(join(dir, `${marketKey}-100-100.json`), first)
        .firstLocalReceiptAt,
      null,
    )
    assert.equal(
      readDirectSupplierFlowPublicationWitness(join(dir, `${marketKey}-101-101.json`), newDoc)
        .status,
      'local_publication_witness',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('origin-specific RPC -32615 tries another independently verified pair', async () => {
  const dir = temp()
  try {
    const result = await backfillDirectSupplierFlow(
      base(dir, {
        fromBlock: 100,
        toBlock: 100,
        clientFactory: (url) => {
          const healthy = rpc()
          return {
            async request(input) {
              if (url.includes('bad.example') && input.method === 'eth_getLogs') {
                const error = new Error('https://private.example/secret')
                error.name = 'RpcRequestError'
                error.code = -32615
                throw error
              }
              return healthy.request(input)
            },
          }
        },
      }),
    )
    assert.equal(result.status, 'complete')
    assert.equal(result.newSegments, 1)
    const doc = JSON.parse(readFileSync(join(dir, `${marketKey}-100-100.json`), 'utf8'))
    assert.equal(verifyDirectSupplierFlowSegment(doc).candidateCount, 0)
    assert.equal(
      safeDirectOriginFailureClass({ name: 'RpcRequestError', code: -32615 }),
      'rpc_origin_unavailable',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resumes an irregular 1+1+64 block prefix without collecting it again', async () => {
  const dir = temp()
  try {
    for (const [from, to] of [
      [100, 100],
      [101, 101],
      [102, 165],
    ])
      writeSegment(dir, await sealed(from, to))
    const result = await backfillDirectSupplierFlow({
      ...base(dir),
      fromBlock: 100,
      toBlock: 165,
      collect: () => {
        throw new Error('must_not_collect')
      },
    })
    assert.equal(result.status, 'complete')
    assert.equal(result.resumedSegments, 3)
    assert.equal(result.newSegments, 0)
    assert.equal(result.reconciledWithdrawals, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ignores an interrupted staging file and publishes an immutable final segment', async () => {
  const dir = temp()
  const stale = join(dir, '.direct-flow-stage-interrupted.tmp')
  try {
    writeFileSync(stale, '{"partial":')
    const result = await backfillDirectSupplierFlow(
      base(dir, { fromBlock: 100, toBlock: 100, clientFactory: () => rpc() }),
    )
    assert.equal(result.status, 'complete')
    assert.deepEqual(readdirSync(dir).sort(), [
      `.direct-flow-publication-${marketKey}-100-100.json`,
      '.direct-flow-stage-interrupted.tmp',
      `${marketKey}-100-100.json`,
    ])
    const final = join(dir, `${marketKey}-100-100.json`)
    assert.equal(statSync(final).mode & 0o777, 0o444)
    verifyDirectSupplierFlowSegment(JSON.parse(readFileSync(final, 'utf8')))
    const resumed = await backfillDirectSupplierFlow(
      base(dir, {
        fromBlock: 100,
        toBlock: 100,
        collect: () => {
          throw new Error('must_not_collect')
        },
      }),
    )
    assert.equal(resumed.resumedSegments, 1)
    assert.equal(resumed.newSegments, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publication collision never overwrites the other complete final seal', async () => {
  const dir = temp()
  try {
    const winner = await sealed(100, 100)
    const body = `${JSON.stringify(winner)}\n`
    await assert.rejects(
      backfillDirectSupplierFlow(
        base(dir, {
          fromBlock: 100,
          toBlock: 100,
          clientFactory: () => rpc(),
          collect: async () => {
            writeSegment(dir, winner) // A competing writer wins after discovery.
            return { document: winner }
          },
        }),
      ),
      (error) => error?.code === 'EEXIST',
    )
    assert.deepEqual(readdirSync(dir), [`${marketKey}-100-100.json`])
    assert.equal(readFileSync(join(dir, `${marketKey}-100-100.json`), 'utf8'), body)
    const resumed = await backfillDirectSupplierFlow(
      base(dir, {
        fromBlock: 100,
        toBlock: 100,
        collect: () => {
          throw new Error('must_not_collect')
        },
      }),
    )
    assert.equal(resumed.resumedSegments, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a tampered existing seal and a discontinuous collected range', async () => {
  const dir = temp()
  try {
    const document = await sealed(100, 100)
    writeSegment(dir, document)
    const path = join(dir, `${marketKey}-100-100.json`)
    const tampered = JSON.parse(readFileSync(path, 'utf8'))
    tampered.blocks[0].hash = hash(88)
    chmodSync(path, 0o600)
    writeFileSync(path, `${JSON.stringify(tampered)}\n`)
    await assert.rejects(backfillDirectSupplierFlow(base(dir)), /direct_segment_digest_mismatch/)
    rmSync(path)
    writeSegment(dir, document)
    await assert.rejects(
      backfillDirectSupplierFlow(
        base(dir, {
          rpcUrls: 'https://one.example,https://two.example',
          collect: async () => ({ document: await sealed(102, 102) }),
        }),
      ),
      /direct_source_disagreement/,
    )
    assert.deepEqual(readdirSync(dir), [`${marketKey}-100-100.json`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails closed when A sees a withdrawal and B/C agree on false zero', async () => {
  const dir = temp()
  try {
    await assert.rejects(
      backfillDirectSupplierFlow(
        base(dir, {
          fromBlock: 100,
          toBlock: 100,
          rpcUrls: 'https://first.example,https://second.example,https://third.example',
          clientFactory: (url) => rpc({ positive: url.includes('first.example') }),
        }),
      ),
      /direct_source_disagreement/,
    )
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reports a fixed unavailable code when all origins are rate limited', async () => {
  const dir = temp()
  try {
    await assert.rejects(
      backfillDirectSupplierFlow(
        base(dir, {
          rpcUrls: 'https://one.example,https://two.example,https://three.example',
          clientFactory: () => rpc({ broken: true }),
        }),
      ),
      (error) =>
        error.message === 'direct_segment_unavailable' &&
        !error.message.includes('secret-rpc-token'),
    )
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stops at new-segment budget and enforces reserve before RPC', async () => {
  const dir = temp()
  const lowDiskDir = temp()
  try {
    const result = await backfillDirectSupplierFlow(
      base(dir, {
        toBlock: 227,
        rpcUrls: 'https://one.example,https://two.example',
        clientFactory: () => rpc(),
      }),
    )
    assert.equal(result.status, 'budget_reached')
    assert.equal(result.throughBlock, 163)
    assert.deepEqual(readdirSync(dir).sort(), [
      `.direct-flow-publication-${marketKey}-100-163.json`,
      `${marketKey}-100-163.json`,
    ])
    await assert.rejects(
      backfillDirectSupplierFlow(
        base(lowDiskDir, {
          rpcUrls: 'https://one.example,https://two.example',
          stat: () => ({ bavail: MIN_FREE_BYTES - 1, bsize: 1 }),
          collect: () => {
            throw new Error('must_not_collect')
          },
        }),
      ),
      /direct_disk_reserve/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(lowDiskDir, { recursive: true, force: true })
  }
})

test('redacts upstream credential errors from API and CLI output', async () => {
  const dir = temp()
  try {
    await assert.rejects(
      backfillDirectSupplierFlow(
        base(dir, {
          collect: () => {
            throw new Error('https://rpc.example/private-key')
          },
        }),
      ),
      (error) =>
        error.message === 'direct_source_disagreement' && !error.message.includes('private-key'),
    )
    const run = spawnSync(
      process.execPath,
      [
        new URL('./backfill-carry-direct-supplier-flow.mjs', import.meta.url).pathname,
        '--market',
        marketKey,
        '--from',
        '100',
        '--to',
        '101',
        '--out-dir',
        dir,
        '--max-segments',
        '17',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, RECORDER_RPC_URLS: 'https://rpc.example/private-key' },
      },
    )
    assert.equal(run.status, 1)
    assert.equal(run.stderr, 'direct_backfill_failed\n')
    assert.doesNotMatch(run.stdout + run.stderr, /private-key/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
