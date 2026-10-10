import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  COHORT_SIZE,
  POOL,
  SOURCE_SHA256,
  SUSDE,
  USDE,
  validateSourceAndSeed,
} from './usde-susde-receipts.mjs'
import {
  MAX_BLOCK_AGE_MS,
  RECEIPT_SHA256,
  collectMatched,
  main,
  readVariableDebtToken,
  validateMatched,
  writeSealedOutput,
} from './usde-susde-matched.mjs'

const DEBT = '0x1111111111111111111111111111111111111111'
const HASH = `0x${'ab'.repeat(32)}`
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const owners = Array.from(
  { length: COHORT_SIZE },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`,
)
const cohort = { observations: owners.map((owner) => ({ owner })) }
const attestation = { checked: COHORT_SIZE }
const now = Date.UTC(2026, 8, 27, 18, 0)
const block = {
  number: 26_070_000n,
  hash: HASH,
  timestamp: BigInt(Math.floor((now - 60_000) / 1000)),
}

function reserveWords(debt = DEBT) {
  const words = Array.from({ length: 11 }, () => '0'.repeat(64))
  words[10] = debt.slice(2).padStart(64, '0')
  return `0x${words.join('')}`
}

function client(overrides = {}) {
  let headerCalls = 0
  return {
    getChainId: async () => overrides.chainId ?? 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      assert.ok(blockTag === 'finalized' || blockNumber === block.number)
      headerCalls += 1
      return headerCalls === 2 ? (overrides.afterBlock ?? block) : (overrides.block ?? block)
    },
    request: async ({ method, params }) => {
      assert.equal(method, 'eth_call')
      assert.equal(params[0].to.toLowerCase(), POOL)
      assert.equal(params[1], `0x${block.number.toString(16)}`)
      return overrides.reserve ?? reserveWords()
    },
    readContract: async ({ address, functionName, args, blockNumber }) => {
      assert.equal(blockNumber, block.number)
      if (address.toLowerCase() === DEBT && functionName === 'UNDERLYING_ASSET_ADDRESS')
        return overrides.underlying ?? USDE
      if (address.toLowerCase() === DEBT && functionName === 'POOL') return overrides.pool ?? POOL
      if (address.toLowerCase() === DEBT && functionName === 'decimals')
        return overrides.debtDecimals ?? 18
      if (address.toLowerCase() === USDE && functionName === 'decimals')
        return overrides.assetDecimals ?? 18
      if (address.toLowerCase() === SUSDE && functionName === 'asset')
        return overrides.vaultAsset ?? USDE
      if (address.toLowerCase() === SUSDE && functionName === 'decimals')
        return overrides.shareDecimals ?? 18
      if (address.toLowerCase() === SUSDE && functionName === 'totalAssets')
        return overrides.totalAssets ?? 1_000n
      if (functionName === 'balanceOf' && args?.[0] === overrides.missingOwner)
        throw new Error('provider read failed')
      if (address.toLowerCase() === DEBT && functionName === 'balanceOf')
        return 'debt' in overrides ? overrides.debt : 5n
      if (address.toLowerCase() === SUSDE && functionName === 'balanceOf')
        return overrides.shares ?? 4n
      if (address.toLowerCase() === SUSDE && functionName === 'convertToAssets')
        return overrides.holding ?? args[0]
      throw new Error(`unexpected ${functionName}`)
    },
  }
}

async function measured(overrides) {
  return collectMatched(
    client(overrides),
    cohort,
    attestation,
    RECEIPT_SHA256,
    overrides?.clock ?? (() => now),
  )
}

function reseal(document) {
  const { documentSha256: _old, ...body } = document
  return { ...body, documentSha256: sha256(JSON.stringify(body)) }
}

test('complete one-block read reports exact lesser-of overlap and separate all-depositor assets', async () => {
  const result = await measured()
  assert.equal(result.completeWalletCount, COHORT_SIZE)
  assert.equal(result.unknownWalletCount, 0)
  assert.equal(result.matchedRaw, '100')
  assert.equal(result.destinationVaultTotalAssetsRaw, '1000')
  assert.equal(result.sourceArtifactSha256, RECEIPT_SHA256)
  assert.equal(result.blockHash, HASH)
  assert.equal(result.ageSecondsAtCapture, 60)
  assert.equal(result.collectionElapsedMs, 0)
  assert.equal(result.capturedAt, new Date(now).toISOString())
  assert.equal(result.rows.length, COHORT_SIZE)
  assert.equal(result.rows[0].debtRaw, '5')
  assert.equal(result.rows[0].holdingRaw, '4')
  assert.equal(result.rows[0].matchedRaw, '4')
  assert.equal(validateMatched(result, cohort), result)
})

test('wrong reserve token identity or market is rejected', async () => {
  for (const changed of [
    { reserve: '0x1234' },
    { reserve: reserveWords('0x0000000000000000000000000000000000000000') },
    { underlying: SUSDE },
    { pool: SUSDE },
    { vaultAsset: DEBT },
  ]) {
    await assert.rejects(() => measured(changed), /usde_overlap_/)
  }
})

test('debt, asset, and share decimal mismatches are rejected', async () => {
  for (const changed of [{ debtDecimals: 6 }, { assetDecimals: 6 }, { shareDecimals: 6 }]) {
    await assert.rejects(() => measured(changed), /usde_overlap_.*identity_mismatch/)
  }
})

test('one missing wallet is incomplete, never a zero aggregate', async () => {
  await assert.rejects(() => measured({ missingOwner: owners[7] }), /provider read failed/)
  await assert.rejects(
    () =>
      collectMatched(
        client(),
        { observations: owners.slice(1).map((owner) => ({ owner })) },
        attestation,
        RECEIPT_SHA256,
        () => now,
      ),
    /usde_overlap_cohort_invalid/,
  )
})

test('chain, fresh finalized header, and same-block hash are mandatory', async () => {
  await assert.rejects(() => measured({ chainId: 10 }), /usde_overlap_wrong_chain/)
  await assert.rejects(
    () => measured({ block: { ...block, timestamp: block.timestamp - 8000n } }),
    /usde_overlap_finalized_header_stale/,
  )
  await assert.rejects(
    () => measured({ afterBlock: { ...block, hash: `0x${'cd'.repeat(32)}` } }),
    /usde_overlap_block_changed/,
  )
  await assert.rejects(
    () => measured({ block: { ...block, hash: '0x12' } }),
    /usde_overlap_finalized_header_invalid/,
  )
})

test('a supplied daily anchor pins the numeric block and rejects a different canonical hash', async () => {
  const anchor = {
    blockNumber: block.number.toString(),
    blockHash: HASH,
    blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
  }
  assert.equal(
    (await collectMatched(client(), cohort, attestation, RECEIPT_SHA256, () => now, anchor))
      .blockNumber,
    anchor.blockNumber,
  )
  await assert.rejects(
    () =>
      collectMatched(
        client({ block: { ...block, hash: `0x${'cd'.repeat(32)}` } }),
        cohort,
        attestation,
        RECEIPT_SHA256,
        () => now,
        anchor,
      ),
    /usde_overlap_anchor_mismatch/,
  )
})

test('slow 25-wallet collection rechecks age at completion and records elapsed time', async () => {
  let calls = 0
  const clock = () => (calls++ === 0 ? now : now + 5_000)
  const result = await measured({ clock })
  assert.equal(result.collectionElapsedMs, 5_000)
  assert.equal(result.ageSecondsAtCapture, 65)
  assert.equal(result.capturedAt, new Date(now + 5_000).toISOString())
  let staleCalls = 0
  const staleClock = () => (staleCalls++ === 0 ? now : now + MAX_BLOCK_AGE_MS)
  await assert.rejects(() => measured({ clock: staleClock }), /usde_overlap_finalized_header_stale/)
})

test('negative, missing, and out-of-bounds holdings cannot be sealed', async () => {
  for (const changed of [
    { debt: null },
    { shares: -1n },
    { holding: 1_001n },
    { totalAssets: 50n },
  ]) {
    await assert.rejects(() => measured(changed), /usde_overlap_/)
  }
})

test('offline verification detects row and aggregate corruption even after resealing', async () => {
  const result = await measured()
  const tampered = structuredClone(result)
  tampered.rows[0].matchedRaw = '5'
  assert.throws(() => validateMatched(tampered, cohort), /usde_overlap_document_hash_mismatch/)
  assert.throws(() => validateMatched(reseal(tampered), cohort), /usde_overlap_row_bounds_invalid/)
  const aggregate = structuredClone(result)
  aggregate.destinationVaultTotalAssetsRaw = '50'
  assert.throws(
    () => validateMatched(reseal(aggregate), cohort),
    /usde_overlap_aggregate_bounds_invalid/,
  )
  const noWallet = structuredClone(result)
  noWallet.rows.pop()
  assert.throws(
    () => validateMatched(reseal(noWallet), cohort),
    /usde_overlap_document_identity_invalid/,
  )
})

test('reserve-data reader itself requires a structurally valid Aave debt token', async () => {
  assert.equal(await readVariableDebtToken(client(), block.number), DEBT)
  await assert.rejects(
    () => readVariableDebtToken(client({ reserve: '0x' }), block.number),
    /usde_overlap_reserve_data_unavailable/,
  )
})

test('exclusive atomic output promotion never overwrites an existing sealed JSON', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'usde-overlap-seal-'))
  try {
    const out = join(folder, 'sealed.json')
    await writeSealedOutput(out, Buffer.from('{"ok":true}\n'))
    await assert.rejects(() => writeSealedOutput(out, Buffer.from('{"ok":false}\n')), {
      code: 'EEXIST',
    })
    assert.equal(await readFile(out, 'utf8'), '{"ok":true}\n')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

const LOCAL_SOURCE =
  '/Users/EBmic/.claude/projects/-Users-EBmic-membrane-solidity/lending-scan/routes_ab.json'
const LOCAL_RECEIPTS = '/private/tmp/usde-susde-receipts.jeBXly/receipts.json'

test(
  'offline CLI requires retained physical SHA and rejects plausible rehashed tampering',
  {
    skip: !existsSync(LOCAL_SOURCE) || !existsSync(LOCAL_RECEIPTS),
  },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'usde-overlap-verify-'))
    try {
      const source = await readFile(LOCAL_SOURCE)
      const seed = await readFile(new URL('./aug-2026-ab-vault-seed.json', import.meta.url))
      const physicalCohort = validateSourceAndSeed(source, seed)
      const document = await collectMatched(
        client(),
        physicalCohort,
        attestation,
        RECEIPT_SHA256,
        () => now,
      )
      const out = join(folder, 'reading.json')
      const original = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
      await writeFile(out, original)
      const argv = [
        '--verify',
        '--source',
        LOCAL_SOURCE,
        '--source-sha256',
        SOURCE_SHA256,
        '--receipts',
        LOCAL_RECEIPTS,
        '--out',
        out,
      ]
      await assert.rejects(() => main(argv), /usde_overlap_cli_invalid/)
      const pinned = [...argv, '--out-sha256', sha256(original)]
      assert.equal((await main(pinned)).status, 'verified')
      const tampered = structuredClone(document)
      tampered.rows[0].debtRaw = '6' // Still plausible; min(6, 4) is unchanged.
      const rehashed = reseal(tampered)
      await writeFile(out, `${JSON.stringify(rehashed, null, 2)}\n`)
      await assert.rejects(() => main(pinned), /usde_overlap_output_hash_mismatch/)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  },
)
