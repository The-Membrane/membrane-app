import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'

import {
  attestAaveBorrowReceipts,
  isPilotKindDue,
  isRecentPinnedBlock,
  loadOrAttestAaveBorrowReceipts,
  parsePinnedPilotManifest,
  PILOT_ROUTE,
  readDestinationVaultTvl,
  readDestinationVaultTvlWithWitness,
  readGhoVariableDebtToken,
  readMatchedGhoCapital,
  validateObservedGhoSeed,
  validatePilotManifest,
} from './gho-matched.mjs'
import { GHO_SGHO } from '../route-rates/exact-leg-spread.mjs'
import { filterSeed } from './run.mjs'
import { normalizeSeed } from './collector.mjs'

const GHO = GHO_SGHO.borrowAsset.toLowerCase()
const POOL = GHO_SGHO.borrowMarket.toLowerCase()
const VAULT = GHO_SGHO.destination.toLowerCase()
const DEBT = '0x00000000000000000000000000000000000000de'
const EVENT = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
const owner = (i) => `0x${i.toString(16).padStart(40, '0')}`
const tx = (i) => `0x${i.toString(16).padStart(64, '0')}`
const rows = Array.from({ length: 20 }, (_, i) => ({
  proto: 'Aave V3',
  borrower: owner(i + 1),
  block: 100 + i,
  tx: tx(i + 1),
  asset: GHO,
  market: null,
  dest: VAULT,
  destKind: 'vault',
  route: PILOT_ROUTE,
}))
const raw = JSON.stringify(rows)
const sha = createHash('sha256').update(raw).digest('hex')
const seed = {
  source: { name: 'routes_ab.json', sha256: sha },
  positions: rows.map((row) => ({ owner: row.borrower, vault: VAULT })),
}
const log = (row, address = POOL) => ({
  address,
  topics: encodeEventTopics({
    abi: [EVENT],
    eventName: 'Borrow',
    args: {
      reserve: GHO,
      onBehalfOf: row.borrower,
      referralCode: 0,
    },
  }),
  data: encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }],
    [row.borrower, 100n, 2, 1n],
  ),
})

test('exact 20 source rows require physical hash, Aave/GHO/vault identity, and owner pairs', () => {
  assert.equal(validateObservedGhoSeed(raw, seed, sha).length, 20)
  assert.throws(() => validateObservedGhoSeed(raw, seed), /source_hash/)
  const changed = JSON.stringify(rows.map((row, i) => (i === 0 ? { ...row, proto: 'Other' } : row)))
  const changedSha = createHash('sha256').update(changed).digest('hex')
  assert.throws(
    () =>
      validateObservedGhoSeed(
        changed,
        { ...seed, source: { ...seed.source, sha256: changedSha } },
        changedSha,
      ),
    /route_identity/,
  )
  const wrongMarket = JSON.stringify(
    rows.map((row, i) => (i === 0 ? { ...row, market: POOL } : row)),
  )
  const wrongSha = createHash('sha256').update(wrongMarket).digest('hex')
  assert.throws(
    () =>
      validateObservedGhoSeed(
        wrongMarket,
        { ...seed, source: { ...seed.source, sha256: wrongSha } },
        wrongSha,
      ),
    /route_identity/,
  )
})

test('checked-in portable manifest is pinned to the seed and rejects changed observation data', () => {
  const checkedSeed = filterSeed(
    JSON.parse(readFileSync(new URL('./aug-2026-ab-vault-seed.json', import.meta.url), 'utf8')),
    PILOT_ROUTE,
  )
  const manifest = JSON.parse(
    readFileSync(new URL('./gho-sgho-observations.json', import.meta.url), 'utf8'),
  )
  const physical = readFileSync(new URL('./gho-sgho-observations.json', import.meta.url), 'utf8')
  const seedHash = normalizeSeed(checkedSeed).seedHash
  assert.equal(validatePilotManifest(manifest, checkedSeed, seedHash).length, 20)
  assert.equal(parsePinnedPilotManifest(physical, checkedSeed, seedHash).length, 20)
  assert.throws(() => parsePinnedPilotManifest(`${physical} `, checkedSeed, seedHash), /file_hash/)
  assert.throws(() => validatePilotManifest(manifest, checkedSeed, sha), /manifest_identity/)
  const altered = structuredClone(manifest)
  altered.observations[0].block++
  assert.throws(() => validatePilotManifest(altered, checkedSeed, seedHash), /manifest_identity/)
})

test('each archived borrow transaction must prove exact Aave Pool, GHO and borrower', async () => {
  const good = {
    async getTransactionReceipt({ hash }) {
      const row = rows.find((entry) => entry.tx === hash)
      return { status: 'success', blockNumber: BigInt(row.block), logs: [log(row)] }
    },
  }
  assert.equal((await attestAaveBorrowReceipts(good, rows)).checked, 20)
  const wrongPool = {
    async getTransactionReceipt({ hash }) {
      const row = rows.find((entry) => entry.tx === hash)
      return { status: 'success', blockNumber: BigInt(row.block), logs: [log(row, DEBT)] }
    },
  }
  await assert.rejects(attestAaveBorrowReceipts(wrongPool, rows), /borrow_unproved/)
})

test('immutable source/seed/exact-leg attestation cache avoids repeated historical receipt reads', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'gho-sgho-attest-'))
  try {
    let calls = 0
    const client = {
      async getTransactionReceipt({ hash }) {
        calls++
        const row = rows.find((entry) => entry.tx === hash)
        return { status: 'success', blockNumber: BigInt(row.block), logs: [log(row)] }
      },
    }
    const first = await loadOrAttestAaveBorrowReceipts(client, rows, sha, cache)
    assert.equal(first.checked, 20)
    assert.equal(calls, 20)
    await loadOrAttestAaveBorrowReceipts(client, rows, sha, cache)
    assert.equal(calls, 20)
    const [file] = await readdir(cache)
    const path = join(cache, file)
    const body = JSON.parse(await readFile(path, 'utf8'))
    body.proofs[0].address = DEBT
    await writeFile(path, JSON.stringify(body))
    await assert.rejects(loadOrAttestAaveBorrowReceipts(client, rows, sha, cache), /cache_mismatch/)
    assert.equal(calls, 20)
  } finally {
    await rm(cache, { recursive: true, force: true })
  }
})

test('same-block variable debt token requires reserve identity and token self-identification', async () => {
  const words = Array.from({ length: 15 }, () => '0'.repeat(64))
  words[10] = DEBT.slice(2).padStart(64, '0')
  const calls = []
  const client = {
    async request(args) {
      calls.push(args)
      return `0x${words.join('')}`
    },
    async readContract(args) {
      calls.push(args)
      if (args.functionName === 'UNDERLYING_ASSET_ADDRESS') return GHO
      if (args.functionName === 'POOL') return POOL
      if (args.functionName === 'decimals') return 18
    },
  }
  assert.equal(await readGhoVariableDebtToken(client, 123n), DEBT)
  assert.equal(calls[0].params[1], '0x7b')
  assert.ok(calls.slice(1).every((call) => call.blockNumber === 123n))
  const wrong = {
    ...client,
    async readContract(args) {
      if (args.functionName === 'POOL') return VAULT
      return client.readContract(args)
    },
  }
  await assert.rejects(readGhoVariableDebtToken(wrong, 123n), /identity_mismatch/)
})

test('matched capital is min(debt, holdings) only when all 20 pinned reads succeed', async () => {
  const snapshot = {
    blockNumber: '123',
    blockHash: tx(99),
    seedHash: sha,
    positions: rows.map((row) => ({
      owner: row.borrower,
      status: 'ok',
      assetAddress: GHO,
      assetDecimals: 18,
      assetBalanceRaw: '100000000000000000000',
    })),
  }
  const attestation = { checked: 20, borrowMarket: POOL }
  const client = {
    async readContract(args) {
      assert.equal(args.blockNumber, 123n)
      return args.args[0] === owner(1) ? 50n * 10n ** 18n : 150n * 10n ** 18n
    },
  }
  const result = await readMatchedGhoCapital(client, snapshot, DEBT, attestation)
  assert.equal(result.status, 'ok')
  assert.equal(result.data.matchedGho, 1950)
  assert.equal(result.data.receiptProofCount, 20)
  const failed = {
    async readContract(args) {
      if (args.args[0] === owner(2)) throw new Error('RPC unavailable')
      return client.readContract(args)
    },
  }
  const missing = await readMatchedGhoCapital(failed, snapshot, DEBT, attestation)
  assert.equal(missing.status, 'incomplete')
  assert.equal(missing.data.matchedGho, null)
  assert.equal(missing.data.unknownWalletCount, 1)
})

test('destination totalAssets is an independent all-depositor TVL leg, never missing-as-zero', async () => {
  const client = {
    async readContract(args) {
      assert.equal(args.blockNumber, 123n)
      if (args.functionName === 'asset') return GHO
      if (args.functionName === 'decimals') return 18
      if (args.functionName === 'totalAssets') return 123n * 10n ** 18n
      if (args.functionName === 'paused') return false
      if (args.functionName === 'balanceOf') {
        assert.equal(args.address.toLowerCase(), GHO)
        return 100n * 10n ** 18n
      }
    },
  }
  const result = await readDestinationVaultTvl(client, 123n)
  assert.equal(result.totalAssetsGho, 123)
  assert.equal(result.vaultCashGho, 100)
  assert.equal(result.withdrawalsPaused, false)
  assert.match(result.vaultCashMeaning, /not any wallet maxRedeem/)
  assert.match(result.measurement, /all_depositors/)
  const missing = {
    async readContract(args) {
      if (args.functionName === 'totalAssets') throw new Error('missing')
      return client.readContract(args)
    },
  }
  await assert.rejects(readDestinationVaultTvl(missing, 123n), /missing/)
  const missingCash = {
    async readContract(args) {
      if (args.functionName === 'balanceOf') throw new Error('cash unavailable')
      return client.readContract(args)
    },
  }
  await assert.rejects(readDestinationVaultTvl(missingCash, 123n), /cash unavailable/)
  const missingPause = {
    async readContract(args) {
      if (args.functionName === 'paused') throw new Error('pause unavailable')
      return client.readContract(args)
    },
  }
  await assert.rejects(readDestinationVaultTvl(missingPause, 123n), /pause unavailable/)
})

test('destination cash/totalAssets/pause use one host matching the saved block hash', async () => {
  const goodHash = tx(1234)
  const otherHash = tx(1235)
  const block = { number: 123n, hash: goodHash }
  const candidate = (hashes, chainId = 1) => {
    let headers = 0
    return {
      getChainId: async () => chainId,
      getBlock: async ({ blockNumber }) => {
        assert.equal(blockNumber, 123n)
        return { hash: hashes[headers++] ?? hashes.at(-1) }
      },
      readContract: async ({ blockNumber, functionName }) => {
        assert.equal(blockNumber, 123n)
        if (functionName === 'asset') return GHO
        if (functionName === 'decimals') return 18
        if (functionName === 'totalAssets') return 123n * 10n ** 18n
        if (functionName === 'balanceOf') return 100n * 10n ** 18n
        if (functionName === 'paused') return false
        throw new Error('unexpected function')
      },
    }
  }
  const data = await readDestinationVaultTvlWithWitness(
    [candidate([otherHash]), candidate([goodHash, goodHash])],
    block,
  )
  assert.equal(data.vaultCashGho, 100)
  await assert.rejects(
    readDestinationVaultTvlWithWitness([candidate([goodHash, otherHash])], block),
    /sgho_single_host_read_unavailable/,
  )
  await assert.rejects(
    readDestinationVaultTvlWithWitness([candidate([goodHash, goodHash], 10)], block),
    /sgho_single_host_read_unavailable/,
  )
})

test('destination TVL, August overlap, and prospective overlap have independent daily success clocks', () => {
  const now = Date.parse('2026-09-27T10:00:00Z')
  const rows = [
    { kind: 'destination_tvl', route_key: PILOT_ROUTE, recorded_at: '2026-09-27T09:00:00Z' },
  ]
  assert.equal(isPilotKindDue(rows, 'destination_tvl', now), false)
  assert.equal(isPilotKindDue(rows, 'matched_capital', now), true)
  rows.push({
    kind: 'matched_capital',
    route_key: PILOT_ROUTE,
    recorded_at: '2026-09-26T09:00:00Z',
  })
  assert.equal(isPilotKindDue(rows, 'matched_capital', now), true)
  assert.equal(isPilotKindDue(rows, 'destination_tvl', now), false)
  assert.equal(isPilotKindDue(rows, 'prospective_overlap', now), true)
  rows.push({
    kind: 'prospective_overlap',
    route_key: PILOT_ROUTE,
    recorded_at: '2026-09-27T09:00:00Z',
  })
  assert.equal(isPilotKindDue(rows, 'prospective_overlap', now), false)
})

test('new value readings reject old/future finalized blocks while a prior good value remains', () => {
  const now = Date.parse('2026-09-27T10:00:00Z')
  assert.equal(isRecentPinnedBlock((now - 2 * 60 * 60 * 1000) / 1000, now), true)
  assert.equal(isRecentPinnedBlock((now - 2 * 60 * 60 * 1000 - 1000) / 1000, now), false)
  assert.equal(isRecentPinnedBlock((now + 121_000) / 1000, now), false)
})
