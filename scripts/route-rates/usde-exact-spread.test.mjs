import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  LOOKBACK_SECONDS,
  aaveNominalAprToEffectiveApy,
  annualizeShareGrowth,
} from './exact-leg-spread.mjs'
import {
  MAX_BLOCK_AGE_MS,
  USDE_LEG,
  collectUsdeExactSpread,
  findPriorBlock,
  main,
  validateUsdeExactSpread,
} from './usde-exact-spread.mjs'

const NOW = Date.UTC(2026, 8, 27, 18, 0)
const HEAD = 1_000_000n
const DEBT = '0x1111111111111111111111111111111111111111'
const HEAD_TIME = BigInt(Math.floor((NOW - 60_000) / 1000))
const RAY = 5n * 10n ** 25n
const CURRENT_QUOTE = 1_001_000_000_000_000_000n
const PRIOR_QUOTE = 1_000_000_000_000_000_000n
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function block(number, options = {}) {
  const delta = HEAD - number
  const timestamp = options.archiveGapSeconds
    ? HEAD_TIME - ((delta + 599n) / 600n) * BigInt(options.archiveGapSeconds)
    : HEAD_TIME - delta * 12n
  return { number, timestamp, hash: `0x${number.toString(16).padStart(64, '0')}` }
}

function reserveWords(rate = RAY) {
  const words = Array.from({ length: 11 }, () => '0'.repeat(64))
  words[4] = rate.toString(16).padStart(64, '0')
  words[10] = DEBT.slice(2).padStart(64, '0')
  return `0x${words.join('')}`
}

function client(options = {}) {
  return {
    getChainId: async () => options.chainId ?? 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === 'finalized') return options.head ?? block(HEAD)
      const result = block(blockNumber, options)
      if (options.changeCurrentHash && blockNumber === HEAD)
        return { ...result, hash: `0x${'ff'.repeat(32)}` }
      if (options.missingArchive && blockNumber < HEAD) throw new Error('archive missing')
      return result
    },
    request: async ({ method, params }) => {
      assert.equal(method, 'eth_call')
      assert.equal(params[0].to.toLowerCase(), USDE_LEG.borrowMarket)
      assert.equal(params[1], `0x${HEAD.toString(16)}`)
      return options.reserve ?? reserveWords()
    },
    readContract: async ({ address, functionName, args, blockNumber }) => {
      assert.ok(blockNumber > 0n && blockNumber <= HEAD)
      if (functionName === 'UNDERLYING_ASSET_ADDRESS')
        return options.debtUnderlying ?? USDE_LEG.borrowAsset
      if (functionName === 'POOL') return options.debtPool ?? USDE_LEG.borrowMarket
      if (functionName === 'asset') return options.asset ?? USDE_LEG.borrowAsset
      if (functionName === 'decimals') {
        if (address.toLowerCase() === DEBT) return options.debtDecimals ?? 18
        return address.toLowerCase() === USDE_LEG.borrowAsset
          ? (options.assetDecimals ?? 18)
          : (options.shareDecimals ?? 18)
      }
      if (functionName === 'convertToAssets') {
        assert.equal(args[0], 10n ** 18n)
        return blockNumber === HEAD
          ? 'currentQuote' in options
            ? options.currentQuote
            : CURRENT_QUOTE
          : 'priorQuote' in options
            ? options.priorQuote
            : PRIOR_QUOTE
      }
      throw new Error('unexpected read')
    },
  }
}

const collect = (options = {}, clock = () => NOW) => collectUsdeExactSpread(client(options), clock)

test('timestamp-selected archive and exact-leg spread at one finalized chain-1 block', async () => {
  const prior = await findPriorBlock(client(), block(HEAD))
  assert.equal(prior.number, HEAD - BigInt(LOOKBACK_SECONDS / 12))
  const document = await collect()
  assert.equal(document.currentBlockNumber, HEAD.toString())
  assert.equal(document.priorBlockNumber, prior.number.toString())
  assert.equal(document.lookbackSeconds, LOOKBACK_SECONDS)
  assert.equal(document.currentVariableBorrowRateRayRaw, RAY.toString())
  assert.equal(document.variableDebtToken, DEBT)
  assert.equal(document.currentAssetsPerShareUnitRaw, CURRENT_QUOTE.toString())
  assert.equal(document.borrowApy, aaveNominalAprToEffectiveApy(RAY))
  assert.equal(
    document.yieldApy,
    annualizeShareGrowth(CURRENT_QUOTE, PRIOR_QUOTE, LOOKBACK_SECONDS),
  )
  assert.equal(document.spread, document.yieldApy - document.borrowApy)
  assert.equal(document.ageSecondsAtCapture, 60)
  assert.equal(document.collectionElapsedMs, 0)
  assert.equal(validateUsdeExactSpread(document), document)
})

test('chain, current-block age, and completion-time age are strict', async () => {
  await assert.rejects(() => collect({ chainId: 10 }), /usde_spread_wrong_chain/)
  await assert.rejects(
    () => collect({ head: { ...block(HEAD), timestamp: HEAD_TIME - 8000n } }),
    /usde_spread_finalized_block_stale/,
  )
  let calls = 0
  const clock = () => (calls++ === 0 ? NOW : NOW + MAX_BLOCK_AGE_MS)
  await assert.rejects(() => collect({}, clock), /usde_spread_finalized_block_stale/)
  let quickCalls = 0
  const quick = () => (quickCalls++ === 0 ? NOW : NOW + 5000)
  const document = await collect({}, quick)
  assert.equal(document.collectionElapsedMs, 5000)
  assert.equal(document.ageSecondsAtCapture, 65)
})

test('a supplied daily anchor pins the numeric block and rejects a divergent head hash', async () => {
  const anchor = {
    blockNumber: HEAD.toString(),
    blockHash: block(HEAD).hash,
    blockTimestamp: new Date(Number(HEAD_TIME) * 1000).toISOString(),
  }
  assert.equal(
    (
      await collectUsdeExactSpread(
        client({ head: { ...block(HEAD), hash: '0xdead' } }),
        () => NOW,
        anchor,
      )
    ).currentBlockNumber,
    anchor.blockNumber,
  )
  await assert.rejects(
    () => collectUsdeExactSpread(client({ changeCurrentHash: true }), () => NOW, anchor),
    /usde_spread_anchor_mismatch/,
  )
})

test('vault asset and both asset/share decimal identities are mandatory', async () => {
  for (const options of [
    { asset: USDE_LEG.destination },
    { assetDecimals: 6 },
    { shareDecimals: 6 },
    { currentQuote: 0n },
    { priorQuote: null },
  ])
    await assert.rejects(() => collect(options), /usde_spread_/)
})

test('reserve data, archive history, and block-hash stability fail closed', async () => {
  for (const options of [
    { reserve: '0x' },
    { reserve: `0x${'0'.repeat(64 * 11)}` },
    { debtUnderlying: USDE_LEG.destination },
    { debtPool: USDE_LEG.destination },
    { debtDecimals: 6 },
    { missingArchive: true },
    { archiveGapSeconds: 10_000 },
    { changeCurrentHash: true },
  ])
    await assert.rejects(() => collect(options), /usde_spread_|archive missing/)
})

test('offline verifier recomputes rates and refuses plausible resealed wrong arithmetic', async () => {
  const document = await collect()
  const changed = structuredClone(document)
  changed.spread += 0.001
  const { documentSha256: _ignored, ...body } = changed
  changed.documentSha256 = sha256(JSON.stringify(body))
  assert.throws(() => validateUsdeExactSpread(changed), /usde_spread_document_rate_invalid/)
})

test('CLI seals atomically, refuses overwrite, and requires external physical SHA to verify', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'usde-spread-'))
  try {
    const out = join(folder, 'reading.json')
    const argv = ['--run', '--out', out]
    const dependencies = {
      client: client(),
      clock: () => NOW,
      env: { get: () => 'https://redacted.invalid' },
    }
    const sealed = await main(argv, dependencies)
    assert.equal(sealed.status, 'sealed')
    assert.equal(sha256(await readFile(out)), sealed.outputSha256)
    await assert.rejects(() => main(argv, dependencies), { code: 'EEXIST' })
    await assert.rejects(() => main(['--verify', '--out', out]), /usde_spread_cli_invalid/)
    assert.equal(
      (await main(['--verify', '--out', out, '--out-sha256', sealed.outputSha256])).status,
      'verified',
    )
    const document = JSON.parse(await readFile(out, 'utf8'))
    document.currentAssetsPerShareUnitRaw = '1002000000000000000'
    document.yieldApy = annualizeShareGrowth(
      document.currentAssetsPerShareUnitRaw,
      document.priorAssetsPerShareUnitRaw,
      document.lookbackSeconds,
    )
    document.spread = document.yieldApy - document.borrowApy
    const { documentSha256: _old, ...body } = document
    document.documentSha256 = sha256(JSON.stringify(body))
    await writeFile(out, `${JSON.stringify(document, null, 2)}\n`)
    await assert.rejects(
      () => main(['--verify', '--out', out, '--out-sha256', sealed.outputSha256]),
      /usde_spread_output_hash_mismatch/,
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
