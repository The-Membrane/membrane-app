// Corrected, outcome-blind signer-context baseline continuation. Dry by default.
// Consumes only already-collected v1 mechanical rows; never extends their raw frontier.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toHex } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  FACTORY_SHA,
  MANIFEST_SHA,
  MAX_RAW_BYTES,
  baselineSize,
  selectAnchors,
  validateRaw,
  verifyCheckpoint as verifyV1,
} from './morpho-v2-full-cohort-baseline.mjs'
import {
  FIRST_ROWS,
  guardDisk,
  holderPlan,
  loadInputs as loadFirst64Inputs,
  probe,
  sentinelReason,
  signerStratum,
  verifyCheckpoint as verifySignerSeed,
  V1_SHA,
  MAX_RPC_PER_ROW,
} from './morpho-v2-signer-baseline.mjs'

export const STUDY = 'morpho-v2-full-cohort-signer-baseline-continuation-v3'
export const SEED_SHA = '9bf2a8705910c65eae377a2f63eec73dd6a82f907d9ec1ccee7ead015dcc754e'
export const DENOMINATOR = 304
export const MAX_ROWS_PER_RUN = 8
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const BASE = resolve('data/research/venue-signals')
export const MANIFEST_PATH = resolve(BASE, 'morpho-v2-full-cohort-manifest.json')
export const FACTORY_PATH = resolve(BASE, `${FACTORY_SHA}.json`)
export const V1_SEED_PATH = resolve(BASE, 'morpho-v2-full-cohort-baseline.json')
export const V1_SOURCE_PATH = resolve(BASE, 'morpho-v2-full-cohort-baseline-continuation-v2.json')
export const SEED_PATH = resolve(BASE, 'morpho-v2-signer-baseline-v2.json')
export const OUTPUT_PATH = resolve(BASE, 'morpho-v2-signer-baseline-continuation-v3.json')
const SHA = /^[\da-f]{64}$/
const HASH = /^0x[\da-f]{64}$/
const UNSIGNED = /^(0|[1-9]\d*)$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({
  ...unsigned(value),
  checkpointSha256: sha(JSON.stringify(unsigned(value))),
})

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned physical source SHA mismatch')
  return JSON.parse(bytes)
}

function readSources(sourcePath = V1_SOURCE_PATH) {
  const manifest = pinned(MANIFEST_PATH, MANIFEST_SHA)
  const factory = pinned(FACTORY_PATH, FACTORY_SHA)
  const anchors = selectAnchors(manifest, factory)
  if (anchors.length !== DENOMINATOR) throw new Error('Frozen denominator changed')
  const firstInputs = loadFirst64Inputs({
    manifestPath: MANIFEST_PATH,
    factoryPath: FACTORY_PATH,
    v1Path: V1_SEED_PATH,
  })
  const seed = pinned(SEED_PATH, SEED_SHA)
  verifySignerSeed(seed, firstInputs)
  if (seed.rows.length !== FIRST_ROWS || seed.status !== 'complete-first64-preoutcome')
    throw new Error('Signer seed frontier mismatch')
  const v1Seed = pinned(V1_SEED_PATH, V1_SHA)
  verifyV1(v1Seed, anchors)
  const v1Source = JSON.parse(readFileSync(sourcePath, 'utf8'))
  verifyV1(v1Source, anchors)
  const lineage = JSON.parse(readFileSync(`${sourcePath}.lineage-v2.json`, 'utf8'))
  const { lineageSha256, ...lineageBody } = lineage
  if (
    sha(JSON.stringify(lineageBody)) !== lineageSha256 ||
    lineage.study !== 'morpho-v2-full-cohort-treated-baseline-continuation-v2' ||
    lineage.version !== 2 ||
    lineage.chainId !== 1 ||
    lineage.checkpointPath !== sourcePath ||
    lineage.collectorStudy !== v1Source.study ||
    lineage.seedPhysicalSha256 !== V1_SHA ||
    lineage.seedRows !== FIRST_ROWS ||
    lineage.seedRowsSha256 !== sha(JSON.stringify(v1Seed.results)) ||
    lineage.manifestSha256 !== MANIFEST_SHA ||
    lineage.factorySha256 !== FACTORY_SHA ||
    lineage.interpretation !==
      'mechanical-baseline-only; signer-control-unproven; no-future-outcomes'
  )
    throw new Error('V1 continuation lineage mismatch')
  if (v1Source.results.length < FIRST_ROWS)
    throw new Error('V1 continuation shorter than immutable seed')
  for (let i = 0; i < FIRST_ROWS; i++) {
    if (JSON.stringify(v1Source.results[i]) !== JSON.stringify(v1Seed.results[i]))
      throw new Error('V1 continuation diverges from immutable seed')
  }
  return { anchors, seed, v1Source }
}

function sourceRow(sources, index) {
  const { anchors, v1Source } = sources
  const anchor = anchors[index]
  const old = v1Source.results[index]
  if (!old) throw new Error('Requested row exceeds V1 raw frontier')
  if (!HASH.test(old.preBlockHash || '')) throw new Error('V1 pre-block hash missing')
  const v1SourceRowSha256 = sha(JSON.stringify(old))
  if (!old.rawPath) {
    // V1's final header recheck can replace a Transfer censor status; retain
    // every ITT row and keep its exact source status instead of inferring a cause.
    return { anchor, old, v1SourceRowSha256, raw: null, rawSha256: null }
  }
  if (!SHA.test(old.rawSha256 || '')) throw new Error('V1 raw physical SHA missing')
  const bytes = readFileSync(old.rawPath)
  if (bytes.length > MAX_RAW_BYTES || sha(bytes) !== old.rawSha256)
    throw new Error('V1 raw physical SHA mismatch')
  const raw = validateRaw(JSON.parse(bytes), anchor, old.preBlockHash)
  return { anchor, old, v1SourceRowSha256, raw, rawSha256: old.rawSha256 }
}

function seedCheckpoint(seed) {
  return seal({
    study: STUDY,
    chainId: 1,
    status: 'partial-preoutcome',
    denominator: DENOMINATOR,
    manifestSha256: MANIFEST_SHA,
    factorySha256: FACTORY_SHA,
    v1SeedPhysicalSha256: V1_SHA,
    signerSeedPhysicalSha256: SEED_SHA,
    signerSeedRowsSha256: sha(JSON.stringify(seed.rows)),
    sourceStudy: 'morpho-v2-full-cohort-treated-baseline-continuation-v2',
    prospective: false,
    interpretation: 'mechanical-eth-call; signer-control-unproven; no-post-anchor-outcomes',
    rows: seed.rows,
  })
}

export function verifyContinuation(saved, sources) {
  const expected = seedCheckpoint(sources.seed)
  if (
    !saved ||
    !SHA.test(saved.checkpointSha256 || '') ||
    sha(JSON.stringify(unsigned(saved))) !== saved.checkpointSha256 ||
    saved.study !== STUDY ||
    saved.chainId !== 1 ||
    saved.denominator !== DENOMINATOR ||
    saved.manifestSha256 !== MANIFEST_SHA ||
    saved.factorySha256 !== FACTORY_SHA ||
    saved.v1SeedPhysicalSha256 !== V1_SHA ||
    saved.signerSeedPhysicalSha256 !== SEED_SHA ||
    saved.signerSeedRowsSha256 !== expected.signerSeedRowsSha256 ||
    saved.sourceStudy !== expected.sourceStudy ||
    saved.prospective !== false ||
    saved.interpretation !== expected.interpretation ||
    !Array.isArray(saved.rows) ||
    saved.rows.length < FIRST_ROWS ||
    saved.rows.length > DENOMINATOR ||
    saved.rows.length > sources.v1Source.results.length ||
    saved.status !==
      (saved.rows.length === DENOMINATOR ? 'complete-preoutcome' : 'partial-preoutcome')
  )
    throw new Error('Signer continuation metadata/frontier mismatch')
  for (let i = 0; i < FIRST_ROWS; i++) {
    if (JSON.stringify(saved.rows[i]) !== JSON.stringify(sources.seed.rows[i]))
      throw new Error('Signer continuation immutable seed prefix mismatch')
  }
  for (let i = FIRST_ROWS; i < saved.rows.length; i++) {
    const prefix = sourceRow(sources, i)
    const row = saved.rows[i]
    if (
      row.index !== i ||
      row.proposalIndex !== prefix.anchor.proposalIndex ||
      row.vault !== prefix.anchor.vault ||
      row.anchorBlock !== prefix.anchor.anchorBlock ||
      row.preBlock !== prefix.anchor.preBlock ||
      row.preBlockHash !== prefix.old.preBlockHash ||
      row.v1Status !== prefix.old.status ||
      row.v1SourceRowSha256 !== prefix.v1SourceRowSha256 ||
      row.v1RawSha256 !== prefix.rawSha256 ||
      !Number.isSafeInteger(row.rpcCalls) ||
      row.rpcCalls < 0 ||
      row.rpcCalls > MAX_RPC_PER_ROW ||
      !Array.isArray(row.excludedSentinels) ||
      !Array.isArray(row.examinedHolders) ||
      (row.holder && sentinelReason(row.holder) !== null)
    )
      throw new Error('Signer continuation row/source mismatch')
    if (!prefix.raw) {
      if (
        row.status !== 'source-raw-unavailable' ||
        row.rpcCalls !== 2 ||
        row.holder ||
        row.excludedSentinels.length ||
        row.examinedHolders.length
      )
        throw new Error('Signer source censor mismatch')
      continue
    }
    const plan = holderPlan(prefix.raw.logs)
    if (
      row.replayedSupply !== plan.replayedSupply ||
      JSON.stringify(row.excludedSentinels) !== JSON.stringify(plan.excluded) ||
      row.examinedHolders.length > plan.candidates.length
    )
      throw new Error('Signer holder ledger mismatch')
    for (let j = 0; j < row.examinedHolders.length; j++) {
      const attempt = row.examinedHolders[j]
      if (
        attempt.holder !== plan.candidates[j].holder ||
        attempt.shares !== plan.candidates[j].shares ||
        (j < row.examinedHolders.length - 1 && attempt.status !== 'contract-code-holder')
      )
        throw new Error('Signer examined-holder order mismatch')
    }
    if (row.holder) {
      const selected = row.examinedHolders.at(-1)
      if (
        selected?.status !== 'selected-code-empty' ||
        selected.holder !== row.holder ||
        selected.shares !== row.holderShares
      )
        throw new Error('Signer selected holder mismatch')
    } else if (row.examinedHolders.some((x) => x.status === 'selected-code-empty')) {
      throw new Error('Signer selected holder missing')
    }
    if (row.accountNonceContext !== null && row.accountNonceContext !== undefined) {
      if (
        !Number.isSafeInteger(row.accountNonceContext.nonce) ||
        row.accountNonceContext.nonce < 0 ||
        row.accountNonceContext.stratum !== signerStratum(row.accountNonceContext.nonce)
      )
        throw new Error('Signer account nonce context mismatch')
    }
    if (row.qAssets !== undefined) {
      if (
        !UNSIGNED.test(row.qAssets) ||
        !UNSIGNED.test(row.totalAssets || '') ||
        !UNSIGNED.test(row.previewRedeemable || '') ||
        row.qAssets !==
          baselineSize(BigInt(row.totalAssets), BigInt(row.previewRedeemable)).toString()
      )
        throw new Error('Signer frozen-q mismatch')
    }
    if (['baseline-success', 'baseline-revert', 'withdraw-rpc-ambiguous'].includes(row.status)) {
      if (!row.holder || !row.accountNonceContext || !row.qAssets || BigInt(row.qAssets) <= 0n)
        throw new Error('Signer withdraw context missing')
      if (row.status === 'baseline-success' && !UNSIGNED.test(row.withdrawShares || ''))
        throw new Error('Signer success result missing')
    }
  }
  return saved
}

function save(out, value, stat) {
  const bytes = JSON.stringify(seal(value))
  if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES) throw new Error('Signer output cap reached')
  guardDisk(out, Buffer.byteLength(bytes), stat)
  mkdirSync(dirname(out), { recursive: true })
  const temp = `${out}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, out)
  return JSON.parse(bytes)
}

async function header(client, out, anchor, stat) {
  guardDisk(out, 0, stat)
  const block = await client.request({
    method: 'eth_getBlockByNumber',
    params: [toHex(anchor.preBlock), false],
  })
  guardDisk(out, 0, stat)
  const atAnchor = await client.request({
    method: 'eth_getBlockByNumber',
    params: [toHex(anchor.anchorBlock), false],
  })
  if (
    !block ||
    Number(BigInt(block.number)) !== anchor.preBlock ||
    !atAnchor ||
    Number(BigInt(atAnchor.number)) !== anchor.anchorBlock ||
    block.hash?.toLowerCase() !== anchor.preBlockHash ||
    atAnchor.hash?.toLowerCase() !== anchor.anchorBlockHash ||
    atAnchor.parentHash?.toLowerCase() !== block.hash?.toLowerCase()
  )
    throw new Error('Frozen source headers changed')
}

export async function continueSigner({
  mode = 'dry',
  out = OUTPUT_PATH,
  sourcePath = V1_SOURCE_PATH,
  through,
  maxRows = MAX_ROWS_PER_RUN,
  client,
  stat = statfsSync,
  probeSigner = probe,
} = {}) {
  if (!['dry', 'verify', 'run'].includes(mode)) throw new Error('Invalid mode')
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS_PER_RUN)
    throw new Error('max-rows must be 1..8')
  out = resolve(out)
  sourcePath = resolve(sourcePath)
  if (
    [SEED_PATH, V1_SEED_PATH, V1_SOURCE_PATH, MANIFEST_PATH, FACTORY_PATH, sourcePath].includes(out)
  )
    throw new Error('Output may not overwrite a source')
  const sources = readSources(sourcePath)
  const available = sources.v1Source.results.length
  let saved = existsSync(out)
    ? verifyContinuation(JSON.parse(readFileSync(out, 'utf8')), sources)
    : seedCheckpoint(sources.seed)
  const target = through === undefined ? Math.min(available, saved.rows.length + maxRows) : through
  if (!Number.isSafeInteger(target) || target < FIRST_ROWS || target > DENOMINATOR)
    throw new Error('through must be 64..304')
  if (target > available) throw new Error('Requested row exceeds V1 raw frontier')
  if (target < saved.rows.length) throw new Error('Requested frontier precedes checkpoint')
  if (mode === 'run' && target - saved.rows.length > maxRows)
    throw new Error('Run exceeds bounded max-rows')
  if (mode === 'dry') return { mode, completed: saved.rows.length, available, next: target }
  if (mode === 'verify') {
    if (!existsSync(out)) throw new Error('Continuation checkpoint missing')
    return { mode, completed: saved.rows.length, available, checkpoint: saved }
  }
  if (target === saved.rows.length)
    return { mode, completed: saved.rows.length, available, checkpoint: saved }
  if (!client) throw new Error('Missing RPC client')
  // The inherited guard stats the output's parent only when it exists.
  // Materialize a custom parent first so a separate filesystem is checked.
  mkdirSync(dirname(out), { recursive: true })
  guardDisk(out, 0, stat)
  if (Number(BigInt(await client.request({ method: 'eth_chainId', params: [] }))) !== 1)
    throw new Error('Wrong chain ID')
  for (let i = saved.rows.length; i < target; i++) {
    const prefix = sourceRow(sources, i)
    let rowCalls = 0
    const boundedClient = {
      request: async (args) => {
        guardDisk(out, 0, stat)
        if (rowCalls >= MAX_RPC_PER_ROW) throw new Error('Per-row RPC cap reached')
        rowCalls++
        return client.request(args)
      },
    }
    let row
    if (prefix.raw) {
      row = await probeSigner({ client: boundedClient, prefix, out, stat })
    } else {
      row = {
        index: prefix.anchor.index,
        proposalIndex: prefix.anchor.proposalIndex,
        vault: prefix.anchor.vault,
        anchorBlock: prefix.anchor.anchorBlock,
        preBlock: prefix.anchor.preBlock,
        preBlockHash: prefix.old.preBlockHash,
        v1Status: prefix.old.status,
        excludedSentinels: [],
        examinedHolders: [],
        status: 'source-raw-unavailable',
        rpcCalls: 0,
      }
    }
    await header(
      boundedClient,
      out,
      {
        ...prefix.anchor,
        preBlockHash: prefix.old.preBlockHash,
      },
      stat,
    )
    row.rpcCalls = rowCalls
    saved = save(
      out,
      {
        ...saved,
        rows: [
          ...saved.rows,
          {
            ...row,
            v1SourceRowSha256: prefix.v1SourceRowSha256,
            v1RawSha256: prefix.rawSha256,
          },
        ],
        status: i + 1 === DENOMINATOR ? 'complete-preoutcome' : 'partial-preoutcome',
      },
      stat,
    )
    verifyContinuation(saved, sources)
  }
  if (sha(readFileSync(SEED_PATH)) !== SEED_SHA || sha(readFileSync(V1_SEED_PATH)) !== V1_SHA)
    throw new Error('Immutable seeds changed during run')
  return { mode, completed: saved.rows.length, available, checkpoint: saved }
}

function options(args) {
  const opts = {}
  for (let i = 0; i < args.length; i += 2) {
    if (
      !args[i]?.startsWith('--') ||
      args[i + 1] === undefined ||
      opts[args[i].slice(2)] !== undefined
    )
      throw new Error('Expected unique --key value options')
    opts[args[i].slice(2)] = args[i + 1]
  }
  if (
    Object.keys(opts).some(
      (x) => !['run', 'verify', 'out', 'source', 'through', 'max-rows'].includes(x),
    ) ||
    (opts.run && opts.run !== 'true') ||
    (opts.verify && opts.verify !== 'true') ||
    (opts.run && opts.verify)
  )
    throw new Error('Invalid continuation options')
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2))
    const mode = opts.run ? 'run' : opts.verify ? 'verify' : 'dry'
    const client =
      mode === 'run'
        ? makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL'))
        : undefined
    const result = await continueSigner({
      mode,
      client,
      out: opts.out || OUTPUT_PATH,
      sourcePath: opts.source || V1_SOURCE_PATH,
      through: opts.through === undefined ? undefined : Number(opts.through),
      maxRows: opts['max-rows'] === undefined ? MAX_ROWS_PER_RUN : Number(opts['max-rows']),
    })
    process.stdout.write(JSON.stringify({ ...result, checkpoint: undefined }) + '\n')
  } catch {
    // Provider errors may contain credential-bearing URLs.
    process.stderr.write('Signer continuation stopped; source, RPC, or resource check failed.\n')
    process.exitCode = 1
  }
}
