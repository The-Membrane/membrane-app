import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseAbiItem, toEventHash } from 'viem'
import { probe, run } from './record-carry-morpho-v2-block-archive.mjs'

const hash = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const depositTopic = toEventHash(
  parseAbiItem(
    'event Deposit(address indexed sender,address indexed onBehalf,uint256 assets,uint256 shares)',
  ),
).toLowerCase()
function client({ failCombined = false, disagreeHash = false } = {}) {
  return {
    getChainId: async () => 1,
    getBlock: async ({ blockNumber, blockTag }) => {
      const number = blockTag === 'finalized' ? 26_000_000n : BigInt(blockNumber)
      return {
        number,
        hash: hash(number + (disagreeHash ? 1n : 0n)),
        timestamp: 1_700_000_000n + number * 12n,
      }
    },
    request: async ({ method, params }) => {
      assert.equal(method, 'eth_getLogs')
      assert.equal(params[0].address.length, 49)
      assert.ok(BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) < 10n)
      if (failCombined && params[0].topics[0].length === 3) throw Error('provider_limited')
      return []
    },
  }
}
const options = (root, factory = () => client()) => ({
  root,
  rpcUrls: 'https://one.example,https://two.example',
  clientFactory: factory,
  startBlock: 25_880_000n,
  endBlock: 25_880_063n,
})

test('QuikNode probe partitions each ten-block event query into five-block requests', async () => {
  const quik = client()
  const request = quik.request
  const windows = []
  quik.request = async (args) => {
    const query = args.params[0]
    windows.push([BigInt(query.fromBlock), BigInt(query.toBlock)])
    assert.ok(BigInt(query.toBlock) - BigInt(query.fromBlock) < 5n)
    return request(args)
  }
  const subjects = Array.from({ length: 49 }, (_, i) => ({
    vault: `0x${(i + 1).toString(16).padStart(40, '0')}`,
  }))
  const result = await probe(
    [
      { origin: 'rpc.ankr.com', client: client() },
      { origin: 'divine-spring-wind.ethereum-mainnet.quiknode.pro', client: quik },
    ],
    subjects,
    100n,
    109n,
  )
  assert.equal(result.length, 2)
  assert.equal(windows.length, 8)
  assert.deepEqual(windows.slice(0, 2), [
    [100n, 104n],
    [105n, 109n],
  ])
})

test('64-block all-49 quiet archive seals one bundle with explicit zero counts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-block-test-'))
  try {
    const result = await run(['--capture'], options(root))
    assert.equal(result.bundles, 1)
    assert.equal(result.coveredBlocks, 64)
    assert.equal(result.events, 0)
    const bundle = JSON.parse(readFileSync(join(root, '000000000001.json'), 'utf8'))
    assert.equal(bundle.slices.length, 7)
    assert.equal(bundle.vaults.length, 49)
    assert.equal(bundle.vaults.filter((row) => row.state === 'deployed').length, 49)
    assert.equal(
      bundle.vaults.filter((row) => Object.values(row.counts).every((count) => count === 0)).length,
      49,
    )
    assert.equal((await run(['--verify'], { root })).complete, true)
    const repeat = await run(['--capture'], options(root))
    assert.equal(repeat.tipSha256, result.tipSha256)
    writeFileSync(join(root, '000000000002.json'), '{}\n')
    await assert.rejects(run(['--verify'], { root }), /digest_mismatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed read-only capability probe creates no archive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-block-test-'))
  try {
    await assert.rejects(
      run(
        ['--capture'],
        options(root, () => client({ failCombined: true })),
      ),
      /provider_limited/,
    )
    await assert.rejects(run(['--verify'], { root }), /missing_enrollment/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cross-origin header conflict prevents enrollment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-block-test-'))
  try {
    await assert.rejects(
      run(
        ['--capture'],
        options(root, (url) => client({ disagreeHash: url.includes('two') })),
      ),
      /campaign_header_disagreement/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v2 campaign chains immutable v1 tip and resumes one bounded bundle per tick', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-block-campaign-test-'))
  const pilotRoot = join(root, 'pilot')
  const campaignRoot = join(root, 'campaign')
  try {
    const pilot = await run(['--capture'], options(pilotRoot))
    const settings = {
      root: campaignRoot,
      pilotRoot,
      rpcUrls: 'https://one.example,https://two.example',
      clientFactory: () => client(),
      endBlock: 25_880_639n,
    }
    const first = await run(['--campaign-capture'], settings)
    assert.equal(first.complete, false)
    assert.equal(first.coveredBlocks, 512)
    const enrollment = JSON.parse(readFileSync(join(campaignRoot, 'enrollment.json'), 'utf8'))
    assert.equal(enrollment.predecessorArchiveSha256, pilot.tipSha256)
    assert.equal(enrollment.startBlock, '25880063')
    assert.equal(enrollment.campaignEndBlock, '25880639')
    const second = await run(['--campaign-capture'], settings)
    assert.equal(second.complete, true)
    assert.equal(second.coveredBlocks, 576)
    assert.equal(second.bundles, 2)
    assert.equal((await run(['--campaign-verify'], settings)).complete, true)
    assert.equal((await run(['--verify'], { root: pilotRoot })).tipSha256, pilot.tipSha256)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v2 campaign refuses a changed pilot predecessor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-block-campaign-test-'))
  const pilotRoot = join(root, 'pilot')
  const campaignRoot = join(root, 'campaign')
  try {
    await run(['--capture'], options(pilotRoot))
    const settings = {
      root: campaignRoot,
      pilotRoot,
      rpcUrls: 'https://one.example,https://two.example',
      clientFactory: () => client(),
      endBlock: 25_880_639n,
    }
    await run(['--campaign-capture'], settings)
    writeFileSync(join(pilotRoot, '000000000001.json'), '{}\n')
    await assert.rejects(run(['--campaign-verify'], settings), /digest_mismatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('v2 provider rate limit leaves the cursor unchanged for a reduced retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-block-campaign-test-'))
  const pilotRoot = join(root, 'pilot')
  const campaignRoot = join(root, 'campaign')
  try {
    await run(['--capture'], options(pilotRoot))
    const settings = {
      root: campaignRoot,
      pilotRoot,
      rpcUrls: 'https://one.example,https://two.example',
      endBlock: 25_880_159n,
    }
    await assert.rejects(
      run(['--campaign-capture'], {
        ...settings,
        clientFactory: (url) => {
          const source = client()
          return {
            ...source,
            request: async (args) => {
              if (url.includes('two') && BigInt(args.params[0].fromBlock) >= 25_880_074n)
                throw Object.assign(Error('rate limited'), { code: 429 })
              return source.request(args)
            },
          }
        },
      }),
      /origin_two.example_rpc_429/,
    )
    const checkpoint = await run(['--campaign-verify-partial'], settings)
    assert.equal(checkpoint.bundles, 0)
    assert.equal(checkpoint.complete, false)
    const retry = await run(['--campaign-tick'], {
      ...settings,
      clientFactory: () => client(),
      bundleBlocks: 32,
    })
    assert.equal(retry.bundles, 1)
    assert.equal(retry.coveredBlocks, 32)
    assert.equal(retry.complete, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const malformed of ['out_of_range', 'duplicate']) {
  test(`two agreeing ${malformed} raw logs cannot poison the v2 cursor`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'morpho-block-malformed-test-'))
    const pilotRoot = join(root, 'pilot')
    const campaignRoot = join(root, 'campaign')
    try {
      await run(['--capture'], options(pilotRoot))
      const settings = {
        root: campaignRoot,
        pilotRoot,
        rpcUrls: 'https://one.example,https://two.example',
        clientFactory: () => client(),
        endBlock: 25_880_159n,
        bundleBlocks: 32,
      }
      const first = await run(['--campaign-capture'], settings)
      assert.equal(first.bundles, 1)
      const badFrom = 25_880_096n
      await assert.rejects(
        run(['--campaign-tick'], {
          ...settings,
          clientFactory: () => {
            const source = client()
            return {
              ...source,
              request: async (args) => {
                const filter = args.params[0]
                if (BigInt(filter.fromBlock) < badFrom) return source.request(args)
                const selector = filter.topics[0]
                const topic = Array.isArray(selector) ? selector[0] : selector
                if (topic !== depositTopic) return []
                const block =
                  malformed === 'out_of_range'
                    ? BigInt(filter.toBlock) + 1n
                    : BigInt(filter.fromBlock)
                const row = {
                  address: filter.address[0],
                  blockNumber: `0x${block.toString(16)}`,
                  blockHash: hash(block),
                  transactionHash: hash(123),
                  transactionIndex: '0x0',
                  logIndex: '0x0',
                  topics: [topic],
                  data: '0x',
                }
                return malformed === 'duplicate' ? [row, row] : [row]
              },
            }
          },
        }),
        new RegExp(malformed === 'out_of_range' ? 'raw_range' : 'raw_duplicate'),
      )
      assert.deepEqual(readdirSync(campaignRoot).sort(), ['000000000001.json', 'enrollment.json'])
      const checkpoint = await run(['--campaign-verify-partial'], settings)
      assert.equal(checkpoint.bundles, 1)
      assert.equal(checkpoint.tipSha256, first.tipSha256)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
