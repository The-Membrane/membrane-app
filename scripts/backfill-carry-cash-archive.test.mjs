import test from 'node:test'
import assert from 'node:assert/strict'

import {
  anchorGrid,
  collectAnchor,
  parseOptions,
  persistAnchor,
  readDirectCash,
  readVaultCash,
  resolveAnchorBlock,
  run,
  validateBatch,
  validateManifest,
} from './backfill-carry-cash-archive.mjs'
import { apply } from './apply-carry-cash-backfill-ddl.mjs'
import { buildSubjectManifest } from './record-carry-cash-issues.mjs'

const MANIFEST = await buildSubjectManifest()

const A = (n) => `0x${n.toString(16).padStart(40, '0')}`
const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const block = (n, seconds = n * 12n) => ({
  number: n,
  hash: H(n),
  timestamp: seconds,
  at: new Date(Number(seconds) * 1000).toISOString(),
})

test('the pilot bounds, UTC anchors, and modes fail closed', () => {
  assert.deepEqual(parseOptions([]), {
    hours: 24,
    stepHours: 1,
    asOf: undefined,
    mode: 'dry-run',
    research30dLookback: false,
  })
  assert.throws(() => parseOptions(['--hours', '25', '--step-hours', '1']), /bounds/)
  assert.throws(() => parseOptions(['--hours', '24', '--step-hours', '0']), /bounds/)
  assert.throws(() => parseOptions(['--commit', '--dry-run']), /mode_specified_twice/)
  assert.throws(
    () => parseOptions(['--research-30d-lookback', '--research-30d-lookback']),
    /lookback_flag_specified_twice/,
  )
  assert.throws(() => parseOptions(['--as-of', '2026-09-28T00:10:00.000Z']), /exact_utc_hour/)
  assert.equal(
    anchorGrid(
      parseOptions(['--hours', '2', '--step-hours', '1', '--as-of', '2026-09-28T23:00:00.000Z']),
      '2026-09-29T00:00:00.000Z',
    ).join(','),
    '2026-09-28T22:00:00.000Z,2026-09-28T23:00:00.000Z',
  )
  assert.throws(
    () =>
      anchorGrid(parseOptions(['--as-of', '2026-09-29T02:00:00.000Z']), '2026-09-29T00:00:00.000Z'),
    /outside_pilot_window/,
  )
})

test('30-day archive research lookback requires explicit opt-in and keeps 24-anchor cap', () => {
  const finalized = '2026-09-29T05:00:00.000Z'
  const older = ['--hours', '24', '--step-hours', '1', '--as-of', '2026-09-23T03:00:00.000Z']
  assert.throws(() => anchorGrid(parseOptions(older), finalized), /outside_pilot_window/)
  assert.equal(anchorGrid(parseOptions(older), '2026-09-29T04:00:00.000Z').length, 24)
  const extended = parseOptions([...older, '--research-30d-lookback'])
  const anchors = anchorGrid(extended, finalized)
  assert.equal(anchors.length, 24)
  assert.equal(anchors[0], '2026-09-22T04:00:00.000Z')
  assert.equal(anchors.at(-1), '2026-09-23T03:00:00.000Z')
  assert.throws(
    () => parseOptions([...older, '--research-30d-lookback', '--hours', '25']),
    /duplicate_or_missing_option/,
  )
  assert.throws(
    () => parseOptions(['--hours', '25', '--research-30d-lookback']),
    /bounds/,
  )
  const thirtyDays = parseOptions([
    '--hours', '24', '--step-hours', '1',
    '--as-of', '2026-08-31T03:00:00.000Z', '--research-30d-lookback',
  ])
  const boundaryFinalized = '2026-09-29T04:00:00.000Z'
  assert.equal(anchorGrid(thirtyDays, boundaryFinalized)[0], '2026-08-30T04:00:00.000Z')
  assert.throws(
    () =>
      anchorGrid(
        parseOptions([
          '--hours', '24', '--step-hours', '1',
          '--as-of', '2026-08-31T02:00:00.000Z', '--research-30d-lookback',
        ]),
        boundaryFinalized,
      ),
    /outside_pilot_window/,
  )
})

test('anchor selection is the last block at or before UTC time and checks next', async () => {
  const client = {
    getBlock: async ({ blockNumber }) => block(blockNumber, 1_700_000_000n + blockNumber * 12n),
  }
  const finalized = block(100n, 1_700_001_200n)
  const chosen = await resolveAnchorBlock(
    client,
    new Date(1_700_000_057_000).toISOString(),
    finalized,
  )
  assert.equal(chosen.number, 4n)
  let fiveReads = 0
  const dishonest = {
    getBlock: async ({ blockNumber }) =>
      block(
        blockNumber,
        1_700_000_000n + (blockNumber === 5n && ++fiveReads > 1 ? 36n : blockNumber * 12n),
      ),
  }
  await assert.rejects(
    resolveAnchorBlock(dishonest, new Date(1_700_000_057_000).toISOString(), finalized),
    /not_bracketed/,
  )
})

test('vault cash preserves full uint256 digits and exact asset identity at pinned block', async () => {
  const vault = A(1)
  const asset = A(2)
  const amount = (1n << 255n) + 123n
  const seen = []
  const client = {
    getCode: async ({ address, blockNumber }) => {
      seen.push([address, blockNumber])
      return '0x1234'
    },
    readContract: async ({ address, functionName, blockNumber }) => {
      seen.push([address, functionName, blockNumber])
      if (functionName === 'asset') return asset
      if (functionName === 'decimals') return address.toLowerCase() === vault ? 18 : 6
      if (functionName === 'balanceOf') return amount
      throw new Error('unexpected_call')
    },
  }
  const result = await readVaultCash(client, vault, 1_000n)
  assert.equal(result.state, 'observed')
  assert.equal(result.asset, asset)
  assert.equal(result.assetDecimals, 6)
  assert.equal(result.cashRaw, amount.toString())
  assert.ok(seen.every((entry) => entry.at(-1) === 1_000n))
})

test('no-code vault and Twyne unassessed never manufacture zero cash', async () => {
  const noCode = await readVaultCash({ getCode: async () => '0x' }, A(1), 1n)
  assert.deepEqual(noCode, { state: 'no_code', reason: 'destination_not_deployed' })
  const twyneAddress = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
  const beforeDeployment = await readVaultCash({ getCode: async () => '0x' }, twyneAddress, 1n)
  assert.equal(beforeDeployment.state, 'no_code')
  const twyne = await readVaultCash({ getCode: async () => '0x1234' }, twyneAddress, 2n)
  assert.equal(twyne.state, 'unassessed')
  assert.equal(twyne.cashRaw, undefined)
})

test('direct market identity or decimals mismatch remains a missing row', async () => {
  const market = {
    destination: A(3),
    underlying: A(4),
    decimals: 6,
    identityFn: 'UNDERLYING_ASSET_ADDRESS',
  }
  const client = {
    getCode: async () => '0x12',
    readContract: async ({ functionName }) => {
      if (functionName === 'UNDERLYING_ASSET_ADDRESS') return A(5)
      if (functionName === 'decimals') return 6
      if (functionName === 'balanceOf') return 100n
    },
  }
  const result = await readDirectCash(client, market, 10n)
  assert.equal(result.state, 'identity_mismatch')
  assert.equal(result.cashRaw, undefined)
})

test('pinned manifest is mandatory and an observed wrong vault or direct asset is nulled', async () => {
  assert.throws(() => validateManifest(null), /manifest_invalid/)
  assert.throws(() => validateManifest({ ...MANIFEST, sha256: '0'.repeat(64) }), /manifest_invalid/)
  const b = block(100n, 1_700_000_000n)
  await assert.rejects(collectAnchor({}, b.at, b, null, {}), /manifest_invalid/)
  const firstVault = MANIFEST.subjects.find((s) => s.source_kind === 'vault')
  const rows = await collectAnchor({}, b.at, b, MANIFEST, {
    readVaultCash: async (_, vault) =>
      vault === firstVault.destination
        ? {
            state: 'observed',
            reason: null,
            asset: A(999),
            shareDecimals: 18,
            assetDecimals: 6,
            cashRaw: '123',
          }
        : { state: 'no_code', reason: 'destination_not_deployed' },
    readDirectCash: async () => ({
      state: 'observed',
      reason: null,
      asset: A(998),
      shareDecimals: 6,
      assetDecimals: 6,
      cashRaw: '456',
    }),
  })
  const affected = rows.filter((row) => row.destination === firstVault.destination)
  assert.ok(affected.length >= 1)
  assert.ok(affected.every((row) => row.state === 'identity_mismatch' && row.cashRaw === null))
  assert.ok(
    rows.slice(64).every((row) => row.state === 'identity_mismatch' && row.cashRaw === null),
  )
})

test('one anchor retains all 67 exact subjects and explicit missing states', async () => {
  const b = block(100n, 1_700_000_000n)
  const rows = await collectAnchor({}, b.at, b, MANIFEST, {
    readVaultCash: async () => ({ state: 'no_code', reason: 'destination_not_deployed' }),
    readDirectCash: async () => ({
      state: 'read_unavailable',
      reason: 'archive_state_read_failed',
    }),
  })
  assert.equal(rows.length, 67)
  assert.equal(rows.filter((row) => row.subjectKind === 'vault').length, 64)
  assert.equal(rows.filter((row) => row.subjectKind === 'direct').length, 3)
  assert.ok(rows.every((row) => row.cashRaw === null && row.captureKind === 'backfilled'))
  assert.equal(rows[0].cohortId, MANIFEST.subjects.find((s) => s.source_kind === 'vault').cohort_id)
  assert.equal(rows[0].subjectManifestSha256, MANIFEST.sha256)
  assert.equal(rows[64].cohortId, null)
  assert.equal(validateBatch(rows, b.at, b, MANIFEST), rows)
})

test('archive batch rejects BigInt to Number loss and duplicate route/destination', async () => {
  const b = block(100n, 1_700_000_000n)
  const rows = await collectAnchor({}, b.at, b, MANIFEST, {
    readVaultCash: async () => ({ state: 'no_code', reason: 'destination_not_deployed' }),
    readDirectCash: async () => ({ state: 'no_code', reason: 'market_or_asset_not_deployed' }),
  })
  const imprecise = rows.map((row) => ({ ...row }))
  const expectedAsset = MANIFEST.subjects.find(
    (subject) =>
      subject.route_key === imprecise[0].routeKey &&
      subject.destination === imprecise[0].destination,
  ).asset
  imprecise[0] = {
    ...imprecise[0],
    state: 'observed',
    reason: null,
    asset: expectedAsset,
    shareDecimals: 18,
    assetDecimals: 18,
    cashRaw: Number(1n << 200n),
  }
  assert.throws(() => validateBatch(imprecise, b.at, b, MANIFEST), /invalid_archive_cash/)
  imprecise[0].cashRaw = '1'
  imprecise[0].shareDecimals = 256
  assert.throws(() => validateBatch(imprecise, b.at, b, MANIFEST), /invalid_archive_cash/)
  const duplicate = rows.map((row) => ({ ...row }))
  duplicate[1] = { ...duplicate[0] }
  assert.throws(() => validateBatch(duplicate, b.at, b, MANIFEST), /invalid_archive_batch_identity/)
})

test('DDL is historical-only and conflict SQL requires byte-identical payload', async () => {
  const ddl = []
  const fake = (strings) => {
    ddl.push(strings.join(''))
    return Promise.resolve()
  }
  await apply(fake)
  assert.match(ddl.join('\n'), /capture_kind text NOT NULL DEFAULT 'backfilled'/)
  assert.doesNotMatch(ddl.join('\n'), /CREATE TABLE IF NOT EXISTS carry_route_vault_observations/)
  const b = block(100n, 1_700_000_000n)
  const rows = await collectAnchor({}, b.at, b, MANIFEST, {
    readVaultCash: async () => ({ state: 'no_code', reason: 'destination_not_deployed' }),
    readDirectCash: async () => ({ state: 'no_code', reason: 'market_or_asset_not_deployed' }),
  })
  const queries = []
  const sql = (strings, ...values) => ({ text: strings.join('?'), values })
  sql.transaction = async (entries) => {
    queries.push(...entries)
  }
  await persistAnchor(sql, rows, b.at, b, MANIFEST)
  assert.match(queries[0].text, /ON CONFLICT \(anchor_at, route_key, destination\) DO NOTHING/)
  assert.match(queries[1].text, /b\.payload_bytes = r\.payload_bytes/)
  const encoded = JSON.parse(queries[0].values[0])
  assert.equal(encoded.length, 67)
  assert.equal(encoded[0].payload_bytes, JSON.stringify(rows[0]))
  assert.notEqual(JSON.stringify({ ...rows[0], reason: 'changed' }), encoded[0].payload_bytes)
})

test('a changed archive block hash aborts before persistence', async () => {
  const anchor = '2023-11-14T22:00:00.000Z'
  const anchorSeconds = BigInt(Date.parse(anchor) / 1000)
  const first = block(1n, anchorSeconds - 1n)
  const finalized = block(2n, anchorSeconds + 3_600n)
  let calls = 0
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === 'finalized') return finalized
      if (blockNumber === 1n) return calls++ >= 1 ? { ...first, hash: H(9) } : first
      return finalized
    },
    getCode: async () => '0x',
  }
  const options = parseOptions(['--hours', '1', '--as-of', anchor, '--commit'])
  let writes = 0
  await assert.rejects(
    run(
      client,
      {
        transaction: async () => {
          writes++
        },
      },
      options,
      MANIFEST,
      () => Number(finalized.timestamp) * 1000 + 1_000,
    ),
    /archive_block_changed/,
  )
  assert.equal(writes, 0)
})

test('a stale finalized head and transient reads cannot commit historical rows', async () => {
  const anchor = '2023-11-14T22:00:00.000Z'
  const anchorSeconds = BigInt(Date.parse(anchor) / 1000)
  const first = block(1n, anchorSeconds - 1n)
  const finalized = block(2n, anchorSeconds + 3_600n)
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockTag, blockNumber }) =>
      blockTag === 'finalized' ? finalized : blockNumber === 1n ? first : finalized,
    getCode: async () => {
      throw new Error('archive host rate limit')
    },
  }
  const options = parseOptions(['--hours', '1', '--as-of', anchor, '--commit'])
  let writes = 0
  const sql = {
    transaction: async () => {
      writes++
    },
  }
  await assert.rejects(
    run(client, sql, options, MANIFEST, () => Number(finalized.timestamp) * 1000 + 3 * 3_600_000),
    /finalized_head_stale/,
  )
  await assert.rejects(
    run(client, sql, options, MANIFEST, () => Number(finalized.timestamp) * 1000 + 1_000),
    /transient_read_unavailable/,
  )
  assert.equal(writes, 0)
})
