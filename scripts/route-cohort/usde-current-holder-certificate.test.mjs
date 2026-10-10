import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbiItem,
} from 'viem'

import {
  CHUNK_BLOCKS,
  CONFIGURATOR,
  INITIALIZATION_TX,
  MIN_FREE_BYTES,
  START_BLOCK,
  START_HASH,
  TOKEN,
  USDE,
  collect,
} from './usde-debt-mint-baseline.mjs'
import { sourceIdentity as alchemySourceIdentity } from './alchemy-mint-discovery.mjs'
import {
  MULTICALL3,
  POOL,
  collectPage,
  finalize,
  loadManifest,
  prepare,
  reconcile,
  sourceCandidates,
  sourceCandidatesV2,
  verifyCertificate,
} from './usde-current-holder-certificate.mjs'

const ZERO = `0x${'0'.repeat(40)}`
const B = START_BLOCK + 20
const B2 = START_BLOCK + CHUNK_BLOCKS + 20
const NOW = Date.UTC(2026, 8, 27, 21)
const address = (i) => `0x${BigInt(i).toString(16).padStart(40, '0')}`
const hex = (i) => `0x${BigInt(i).toString(16)}`
const hash = (i) => `0x${BigInt(i).toString(16).padStart(64, '0')}`
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixtureStat = () => ({ bavail: MIN_FREE_BYTES + 1_000_000, bsize: 1 })
const transfer = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const initialized = parseAbiItem(
  'event ReserveInitialized(address indexed asset, address indexed aToken, address stableDebtToken, address variableDebtToken, address interestRateStrategyAddress)',
)
const abi = {
  aggregate3: parseAbiItem(
    'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
  ),
  scaledBalanceOf: parseAbiItem('function scaledBalanceOf(address) view returns (uint256)'),
  scaledTotalSupply: parseAbiItem('function scaledTotalSupply() view returns (uint256)'),
  POOL: parseAbiItem('function POOL() view returns (address)'),
  UNDERLYING_ASSET_ADDRESS: parseAbiItem(
    'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  ),
}
const selectors = Object.fromEntries(
  Object.entries(abi)
    .filter(([name]) => name !== 'aggregate3')
    .map(([name, item]) => [
      encodeFunctionData({
        abi: [item],
        functionName: name,
        args: name === 'scaledBalanceOf' ? [address(1)] : [],
      }).slice(0, 10),
      name,
    ]),
)
function block(number, asOf = B) {
  return {
    number: hex(number),
    hash: number === START_BLOCK ? START_HASH : hash(number),
    parentHash: number === START_BLOCK + 1 ? START_HASH : hash(number - 1),
    timestamp: hex(Math.floor(NOW / 1000) - 1200 - (asOf - number) * 12),
  }
}
function sourceRpc(repeatedOwner = false) {
  const init = {
    address: CONFIGURATOR,
    topics: encodeEventTopics({
      abi: [initialized],
      eventName: 'ReserveInitialized',
      args: { asset: USDE, aToken: address(100) },
    }),
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
      [address(101), TOKEN, address(102)],
    ),
    blockNumber: hex(START_BLOCK),
    blockHash: START_HASH,
    transactionHash: INITIALIZATION_TX,
    logIndex: '0x0',
    removed: false,
  }
  const mint = {
    address: TOKEN,
    topics: encodeEventTopics({
      abi: [transfer],
      eventName: 'Transfer',
      args: { from: ZERO, to: address(1) },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [1n]),
    blockNumber: hex(START_BLOCK + 4),
    blockHash: hash(START_BLOCK + 4),
    transactionHash: hash(999),
    logIndex: '0x1',
    removed: false,
  }
  const repeat = {
    ...mint,
    blockNumber: hex(START_BLOCK + 14),
    blockHash: hash(START_BLOCK + 14),
    transactionHash: hash(1000),
  }
  return async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber')
      return block(params[0] === 'finalized' ? B : Number(BigInt(params[0])))
    if (method === 'eth_getCode') return Number(BigInt(params[1])) < START_BLOCK ? '0x' : '0x6001'
    if (method === 'eth_getLogs') {
      if (params[0].address.toLowerCase() === CONFIGURATOR) return [init]
      return [mint, ...(repeatedOwner ? [repeat] : [])].filter(
        (entry) =>
          Number(BigInt(entry.blockNumber)) >= Number(BigInt(params[0].fromBlock)) &&
          Number(BigInt(entry.blockNumber)) <= Number(BigInt(params[0].toBlock)),
      )
    }
    throw new Error(`unexpected ${method}`)
  }
}
function censusRpc({
  balance = 1n,
  supply = balance,
  failed = false,
  wrongReserve = false,
  wrongBlock = false,
  wrongTimestamp = false,
  finalizedNumber,
  asOf = B,
} = {}) {
  finalizedNumber ??= asOf
  return async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      const result = block(
        params[0] === 'finalized' ? finalizedNumber : Number(BigInt(params[0])),
        asOf,
      )
      if (wrongBlock && params[0] !== 'finalized') result.hash = hash(B + 1)
      if (wrongTimestamp && params[0] !== 'finalized')
        result.timestamp = hex(Number(BigInt(result.timestamp)) + 1)
      return result
    }
    if (method === 'eth_getCode') {
      assert.equal(params[1].blockHash, hash(asOf))
      return '0x6001'
    }
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
    assert.equal(params[1].blockHash, hash(asOf))
    const { to, data } = params[0]
    if (to.toLowerCase() === POOL) {
      const token = wrongReserve ? address(200) : TOKEN
      return `0x${Array.from({ length: 11 }, (_, i) => (i === 10 ? token.slice(2).padStart(64, '0') : '0'.repeat(64))).join('')}`
    }
    assert.equal(to.toLowerCase(), MULTICALL3)
    const calls = decodeFunctionData({ abi: [abi.aggregate3], data }).args[0]
    const results = calls.map((call) => {
      assert.equal(call.allowFailure, false)
      const name = selectors[call.callData.slice(0, 10)]
      const result =
        name === 'UNDERLYING_ASSET_ADDRESS'
          ? USDE
          : name === 'POOL'
            ? POOL
            : name === 'scaledTotalSupply'
              ? supply
              : balance
      return {
        success: !failed,
        returnData: encodeFunctionResult({ abi: [abi[name]], functionName: name, result }),
      }
    })
    return encodeFunctionResult({
      abi: [abi.aggregate3],
      functionName: 'aggregate3',
      result: results,
    })
  }
}
async function fixture(fn, repeatedOwner = false) {
  const temp = mkdtempSync(join(tmpdir(), 'usde-current-holder-'))
  const sourceDir = join(temp, 'source')
  const out = join(temp, 'certificate')
  try {
    await collect({
      rpcRead: sourceRpc(repeatedOwner),
      out: sourceDir,
      throughBlock: START_BLOCK + (repeatedOwner ? 19 : 9),
      maxChunks: repeatedOwner ? 2 : 1,
      rangeBlocks: 10,
      now: () => new Date(NOW),
      stat: fixtureStat,
    })
    await fn({ sourceDir, out, stat: fixtureStat })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
const capture = ({ sourceDir, out, stat }, rpcRead = censusRpc()) =>
  collectPage({ sourceDir, out, page: 0, rpcRead, now: () => new Date(NOW), stat })
const freeze = (paths, rpcRead = censusRpc(), now = () => new Date(NOW)) =>
  prepare({ ...paths, rpcRead, now })

test('partial historical prefix is independent of finalized B and provenance is sealed', async () =>
  fixture(async (paths) => {
    const manifestPath = await freeze(paths)
    const { manifest, manifestSha256 } = loadManifest(paths)
    assert.equal(manifest.schemaVersion, 1)
    assert.equal('alchemySegments' in manifest, false)
    assert.equal(manifest.sourceThroughBlock, START_BLOCK + 9)
    assert.equal(manifest.block, B)
    assert.equal(manifest.candidateCount, 1)
    assert.equal(manifest.segments.length, 1)
    assert.match(manifestPath, /manifest-[a-f0-9]{64}\.json$/)
    assert.match(manifestSha256, /^[a-f0-9]{64}$/)
    await assert.rejects(freeze(paths), /output_not_empty/)
    await capture(paths)
    const result = reconcile(paths)
    assert.equal(result.positiveHolderCount, 1)
    assert.deepEqual(result.positiveHolders, [{ owner: address(1), scaledDebtRaw: '1' }])
    assert.equal(
      result.accountingAssumption,
      'deployed_additive_scaled_balance_implementation_unverified',
    )
    assert.equal('routeAttributedTvl' in result, false)
    const receipt = finalize(paths)
    assert.match(receipt, /certificate-[a-f0-9]{64}\.json$/)
    assert.equal(verifyCertificate(paths).positiveHolderCount, 1)
    assert.throws(() => finalize(paths), /certificate_already_sealed/)
  }))

test('repeat mint recipient across sealed segments is one candidate and one balance read', async () =>
  fixture(async (paths) => {
    await freeze(paths)
    const { manifest } = loadManifest(paths)
    assert.equal(manifest.segments.length, 2)
    assert.deepEqual(manifest.candidateOwners, [address(1)])
    await capture(paths)
    assert.equal(reconcile(paths).scaledTotalSupplyRaw, '1')
  }, true))

test('replay still rejects a stat result below the 1 GiB reserve', async () =>
  fixture(async (paths) => {
    await freeze(paths)
    assert.throws(
      () => loadManifest({ ...paths, stat: () => ({ bavail: MIN_FREE_BYTES - 1, bsize: 1 }) }),
      /disk_reserve_reached/,
    )
  }))

test('later historical segment append does not mutate a frozen candidate manifest', async () =>
  fixture(async (paths) => {
    await freeze(paths)
    await collect({
      rpcRead: sourceRpc(true),
      out: paths.sourceDir,
      throughBlock: START_BLOCK + 19,
      rangeBlocks: 10,
      now: () => new Date(NOW),
      stat: fixtureStat,
    })
    assert.equal(loadManifest(paths).manifest.segments.length, 1)
    await capture(paths)
    assert.equal(reconcile(paths).positiveHolderCount, 1)
  }))

test('supply mismatch returns no aggregate, including with a zero balance', async () =>
  fixture(async (paths) => {
    await freeze(paths)
    await capture(paths, censusRpc({ balance: 0n, supply: 1n }))
    assert.throws(() => reconcile(paths), /scaled_supply_mismatch/)
    assert.throws(() => finalize(paths), /scaled_supply_mismatch/)
    assert.equal(
      readdirSync(paths.out).some((name) => name.startsWith('certificate-')),
      false,
    )
  }))

test('zero supply and zero candidate balance yields an empty positive set', async () =>
  fixture(async (paths) => {
    await freeze(paths)
    await capture(paths, censusRpc({ balance: 0n, supply: 0n }))
    assert.deepEqual(reconcile(paths).positiveHolders, [])
  }))

test('duplicate page and incomplete page are rejected', async () =>
  fixture(async (paths) => {
    await freeze(paths)
    assert.throws(() => reconcile(paths), /pages_incomplete/)
    await capture(paths)
    await assert.rejects(capture(paths), /page_already_sealed/)
    const original = readdirSync(paths.out).find((name) => name.startsWith('page-'))
    writeFileSync(
      join(paths.out, `page-000000-${'f'.repeat(64)}.json`),
      readFileSync(join(paths.out, original)),
    )
    assert.throws(() => reconcile(paths), /pages_incomplete/)
  }))

test('source or page hash corruption is rejected before aggregate', async () =>
  fixture(async (paths) => {
    await freeze(paths)
    await capture(paths)
    const page = readdirSync(paths.out).find((name) => name.startsWith('page-'))
    writeFileSync(join(paths.out, page), '{}')
    assert.throws(() => reconcile(paths), /artifact_hash_mismatch/)
    const source = readdirSync(paths.sourceDir)[0]
    writeFileSync(join(paths.sourceDir, source), '{}')
    assert.throws(
      () => loadManifest(paths),
      /segment_invalid|segment_json_invalid|artifact_hash_mismatch|candidate_mismatch/,
    )
  }))

test('failed subcalls and wrong same-B reserve identity cannot seal a page', async () =>
  fixture(async (paths) => {
    await freeze(paths)
    await assert.rejects(capture(paths, censusRpc({ failed: true })), /batch_incomplete/)
    await assert.rejects(
      capture(paths, censusRpc({ wrongReserve: true })),
      /reserve_debt_token_mismatch/,
    )
    assert.equal(readdirSync(paths.out).filter((name) => name.startsWith('page-')).length, 0)
  }))

test('prepare observes finalized B and refuses stale or non-independent finalized heads', async () =>
  fixture(async (paths) => {
    await assert.rejects(
      freeze(paths, censusRpc(), () => new Date(NOW + 6_001_000)),
      /as_of_window_expired/,
    )
    await assert.rejects(
      freeze(paths, censusRpc({ finalizedNumber: START_BLOCK + 9 })),
      /independent_block_invalid/,
    )
    assert.equal(existsSync(paths.out), false)
    await freeze(paths)
    const { manifest } = loadManifest(paths)
    assert.equal(manifest.block, B)
    assert.equal(manifest.blockHash, hash(B))
    assert.equal(manifest.blockTimestamp, Number(BigInt(block(B).timestamp)))
    assert.equal(manifest.asOfMaxAgeSeconds, 7_200)
  }))

test('pages reject expired as-of B, lost finality, changed hash or changed timestamp', async () =>
  fixture(async (paths) => {
    await freeze(paths)
    await assert.rejects(
      collectPage({
        ...paths,
        page: 0,
        rpcRead: censusRpc(),
        now: () => new Date(NOW + 6_001_000),
        stat: paths.stat,
      }),
      /as_of_window_expired/,
    )
    await assert.rejects(
      capture(paths, censusRpc({ finalizedNumber: B - 1 })),
      /block_not_finalized/,
    )
    await assert.rejects(capture(paths, censusRpc({ wrongBlock: true })), /frozen_block_mismatch/)
    await assert.rejects(
      capture(paths, censusRpc({ wrongTimestamp: true })),
      /frozen_block_mismatch/,
    )
    assert.equal(readdirSync(paths.out).filter((name) => name.startsWith('page-')).length, 0)
  }))

test('rehashing forged source and manifest cannot bypass prefix semantic verification', async () =>
  fixture(async (paths) => {
    await freeze(paths)
    const sourceName = readdirSync(paths.sourceDir)[0]
    const source = JSON.parse(readFileSync(join(paths.sourceDir, sourceName)))
    source.candidateOwners = [] // Contradicts the unchanged positive mint log.
    const sourceBytes = Buffer.from(JSON.stringify(source))
    const forgedSourceName = sourceName.replace(
      /[a-f0-9]{64}\.json$/,
      `${digest(sourceBytes)}.json`,
    )
    writeFileSync(join(paths.sourceDir, forgedSourceName), sourceBytes)
    const manifestName = readdirSync(paths.out).find((name) => name.startsWith('manifest-'))
    const manifest = JSON.parse(readFileSync(join(paths.out, manifestName)))
    manifest.segments[0] = { name: forgedSourceName, sha256: digest(sourceBytes) }
    manifest.sourceManifestSha256 = digest(JSON.stringify(manifest.segments))
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    const forgedManifestName = `manifest-${digest(manifestBytes)}.json`
    writeFileSync(join(paths.out, forgedManifestName), manifestBytes)
    renameSync(join(paths.out, manifestName), join(paths.out, 'old-manifest'))
    assert.throws(() => loadManifest(paths), /usde_debt_mint_candidate_mismatch/)
  }))

async function v2Fixture(fn, { offset = 0, raw = '2' } = {}) {
  await fixture(async (paths) => {
    const rpc = sourceCandidates(paths.sourceDir)
    const alchemyDir = join(paths.sourceDir, '..', 'alchemy')
    mkdirSync(alchemyDir)
    const fromBlock = rpc.sourceThroughBlock + 1 + offset
    const toBlock = fromBlock + CHUNK_BLOCKS - 1
    const row = `${fromBlock}:${hash(1001)}:${address(2)}:${raw}`
    const segment = {
      sourceIdentity: alchemySourceIdentity({
        throughBlock: rpc.sourceThroughBlock,
        frontierHash: rpc.sourceFrontierHash,
      }),
      fromBlock,
      toBlock,
      finalizedHead: toBlock,
      finalizedHeadHash: hash(toBlock),
      fromBlockHash: hash(fromBlock),
      fromBlockParentHash: rpc.sourceFrontierHash,
      boundaryHash: hash(toBlock),
      fetchedAt: new Date(NOW).toISOString(),
      pages: 1,
      pageKeyExhausted: true,
      rows: [row],
      candidateOwners: raw === '0' ? [] : [address(2)],
      canonicalLogClaim: false,
      borrowerCensusClaim: false,
    }
    const bytes = Buffer.from(JSON.stringify(segment))
    const name = `${String(fromBlock).padStart(12, '0')}-${String(toBlock).padStart(12, '0')}-${digest(bytes)}.json`
    writeFileSync(join(alchemyDir, name), bytes)
    await fn({ ...paths, alchemyDir, alchemyName: name, alchemySegment: segment })
  })
}

test('v2 unions sorted unique candidates and replays both frozen sources', async () =>
  v2Fixture(async (paths) => {
    const source = sourceCandidatesV2(paths.sourceDir, paths.alchemyDir)
    assert.deepEqual(source.candidateOwners, [address(1), address(2)])
    await freeze(paths, censusRpc({ asOf: B2 }))
    const { manifest } = loadManifest(paths)
    assert.equal(manifest.schemaVersion, 2)
    assert.equal(manifest.alchemyThroughBlock, START_BLOCK + CHUNK_BLOCKS + 9)
    assert.equal(manifest.alchemyManifestSha256, digest(JSON.stringify(manifest.alchemySegments)))
    assert.deepEqual(manifest.candidateOwners, [address(1), address(2)])
    await collectPage({
      ...paths,
      page: 0,
      rpcRead: censusRpc({ asOf: B2, supply: 2n }),
      now: () => new Date(NOW),
    })
    assert.equal(reconcile(paths).positiveHolderCount, 2)
    finalize(paths)
    assert.equal(verifyCertificate(paths).positiveHolderCount, 2)
  }))

test('v2 rejects gaps and overlaps at the frozen RPC frontier', async () => {
  await v2Fixture(
    async (paths) => {
      assert.throws(() => sourceCandidatesV2(paths.sourceDir, paths.alchemyDir), /seal_invalid/)
    },
    { offset: 1 },
  )
  await v2Fixture(
    async (paths) => {
      assert.throws(() => sourceCandidatesV2(paths.sourceDir, paths.alchemyDir), /seal_invalid/)
    },
    { offset: -1 },
  )
})

test('v2 rejects tampered suffix and mismatched source identity', async () => {
  await v2Fixture(async (paths) => {
    await freeze(paths, censusRpc({ asOf: B2 }))
    writeFileSync(join(paths.alchemyDir, paths.alchemyName), '{}')
    assert.throws(() => loadManifest(paths), /artifact_hash_mismatch/)
  })
  await v2Fixture(async (paths) => {
    const altered = {
      ...paths.alchemySegment,
      sourceIdentity: { ...paths.alchemySegment.sourceIdentity, maxCount: 999 },
    }
    const bytes = Buffer.from(JSON.stringify(altered))
    const forged = paths.alchemyName.replace(/[a-f0-9]{64}\.json$/, `${digest(bytes)}.json`)
    writeFileSync(join(paths.alchemyDir, forged), bytes)
    assert.throws(
      () => sourceCandidatesV2(paths.sourceDir, paths.alchemyDir),
      /seal_invalid|artifact_invalid/,
    )
  })
})

test('v2 incomplete candidate set cannot pass the unchanged scaled-supply gate', async () =>
  v2Fixture(
    async (paths) => {
      await freeze(paths, censusRpc({ asOf: B2 }))
      await collectPage({
        ...paths,
        page: 0,
        rpcRead: censusRpc({ asOf: B2, supply: 2n }),
        now: () => new Date(NOW),
      })
      assert.throws(() => reconcile(paths), /scaled_supply_mismatch/)
    },
    { raw: '0' },
  ))
