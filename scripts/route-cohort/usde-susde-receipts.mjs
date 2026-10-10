// Historical August Borrow receipts identify the Pool behind source rows whose
// `market` is null. They do not prove where borrowed USDe went or route TVL.
import { createHash } from 'node:crypto'
import { readFile, statfs, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decodeEventLog, isAddress, parseAbiItem } from 'viem'

import { makeClient, readEnv } from '../lib/venue-reads.mjs'

export const ROUTE = 'USDe → Staked USDe [USDe]'
export const SOURCE_SHA256 = 'a0aee85535cb4c96f09d2f3bce3af3d2bcc9d1e2ee0156e24265111263c4cf63'
export const SEED_SHA256 = 'c3e85a98ff3b634c8e6c4bdd4cc64e94f3bdcc417c071125cd40cdff09a21243'
export const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
export const USDE = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
export const SUSDE = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'
export const COHORT_SIZE = 25
export const MIN_FREE_BYTES = 1_073_741_824
const SEED_PATH = fileURLToPath(new URL('./aug-2026-ab-vault-seed.json', import.meta.url))
const BORROW = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
const HEX32 = /^0x[0-9a-f]{64}$/i
const eq = (left, right) => String(left).toLowerCase() === String(right).toLowerCase()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function fail(code) {
  throw new Error(`usde_${code}`)
}

function address(value) {
  return isAddress(value, { strict: false }) ? value.toLowerCase() : null
}

function positiveInteger(value) {
  try {
    return BigInt(value) > 0n
  } catch {
    return false
  }
}

/** Pure source/seed validation; the CLI pins both physical hashes and all 25 rows. */
export function validateSourceAndSeed(
  sourceBytes,
  seedBytes,
  expected = {
    sourceSha256: SOURCE_SHA256,
    seedSha256: SEED_SHA256,
    count: COHORT_SIZE,
  },
) {
  const sourceHash = sha256(sourceBytes)
  const seedHash = sha256(seedBytes)
  if (sourceHash !== expected.sourceSha256 || seedHash !== expected.seedSha256) {
    fail('source_or_seed_hash_mismatch')
  }
  let rows
  let seed
  try {
    rows = JSON.parse(sourceBytes)
    seed = JSON.parse(seedBytes)
  } catch {
    fail('source_or_seed_json_invalid')
  }
  if (
    !Array.isArray(rows) ||
    !Array.isArray(seed?.positions) ||
    seed.schemaVersion !== 1 ||
    seed.cohortId !== 'aug-2026-ab-vault-routes' ||
    seed.source?.name !== 'routes_ab.json' ||
    seed.source.sha256 !== sourceHash
  ) {
    fail('source_or_seed_identity_invalid')
  }
  const observations = rows.filter((row) => row.route === ROUTE)
  const positions = seed.positions.filter((position) => position.routeIds?.includes(ROUTE))
  if (observations.length !== expected.count || positions.length !== expected.count) {
    fail('cohort_count_mismatch')
  }
  const seeded = new Set()
  for (const position of positions) {
    const owner = address(position.owner)
    const vault = address(position.vault)
    if (
      !owner ||
      vault !== SUSDE ||
      seeded.has(`${owner}:${vault}`) ||
      position.routeIds.filter((id) => id === ROUTE).length !== 1
    ) {
      fail('seed_pair_invalid')
    }
    seeded.add(`${owner}:${vault}`)
  }
  const seen = new Set()
  const normalized = observations.map((row) => {
    const owner = address(row.borrower)
    const vault = address(row.dest)
    const key = `${owner}:${vault}`
    if (
      row.proto !== 'Aave V3' ||
      row.market !== null ||
      address(row.asset) !== USDE ||
      vault !== SUSDE ||
      row.destKind !== 'vault' ||
      !owner ||
      !seeded.has(key) ||
      seen.has(key) ||
      !HEX32.test(row.tx || '') ||
      !Number.isSafeInteger(row.block) ||
      row.block <= 0 ||
      !positiveInteger(row.amt)
    ) {
      fail('observation_identity_invalid')
    }
    seen.add(key)
    return { owner, vault, tx: row.tx.toLowerCase(), block: row.block, amountRaw: row.amt }
  })
  if (seen.size !== seeded.size) fail('seed_pair_missing')
  return { sourceSha256: sourceHash, seedSha256: seedHash, observations: normalized }
}

/** Do not turn a missing/failed receipt into a measured zero. */
export function attestReceipt(row, receipt) {
  if (
    !receipt ||
    receipt.status !== 'success' ||
    !eq(receipt.transactionHash, row.tx) ||
    !positiveInteger(row.amountRaw) ||
    !HEX32.test(receipt.blockHash || '') ||
    BigInt(receipt.blockNumber ?? -1) !== BigInt(row.block) ||
    !Array.isArray(receipt.logs)
  ) {
    fail('receipt_missing_or_mismatched')
  }
  const matched = []
  for (const log of receipt.logs) {
    if (address(log.address) !== POOL || !Array.isArray(log.topics)) continue
    try {
      const event = decodeEventLog({ abi: [BORROW], topics: log.topics, data: log.data })
      if (
        event.eventName === 'Borrow' &&
        address(event.args.reserve) === USDE &&
        address(event.args.onBehalfOf) === row.owner &&
        event.args.amount === BigInt(row.amountRaw) &&
        Number(event.args.interestRateMode) === 2
      ) {
        matched.push({
          address: POOL,
          topics: log.topics.map((topic) => String(topic).toLowerCase()),
          data: String(log.data).toLowerCase(),
          logIndex: Number(log.logIndex),
        })
      }
    } catch {
      // Other Pool logs do not attest this observation.
    }
  }
  if (matched.length !== 1 || !Number.isSafeInteger(matched[0].logIndex) || matched[0].logIndex < 0)
    fail('pool_borrow_unproved_or_ambiguous')
  return {
    tx: row.tx,
    block: row.block,
    blockHash: receipt.blockHash.toLowerCase(),
    status: 'success',
    log: matched[0],
  }
}

export function validateAttestation(document, cohort) {
  if (
    document?.schemaVersion !== 1 ||
    document.route !== ROUTE ||
    document.sourceSha256 !== cohort.sourceSha256 ||
    document.seedSha256 !== cohort.seedSha256 ||
    document.pool !== POOL ||
    document.borrowAsset !== USDE ||
    document.destination !== SUSDE ||
    document.claim !== 'borrow_receipt_identity_only_not_route_tvl' ||
    !Array.isArray(document.proofs) ||
    document.proofs.length !== cohort.observations.length ||
    document.checked !== cohort.observations.length ||
    !Number.isFinite(Date.parse(document.observedAt)) ||
    !/^[a-f0-9]{64}$/.test(document.documentSha256 || '')
  ) {
    fail('attestation_header_invalid')
  }
  const { documentSha256, ...body } = document
  if (sha256(JSON.stringify(body)) !== documentSha256) fail('attestation_hash_mismatch')
  for (let i = 0; i < cohort.observations.length; i += 1) {
    const proof = document.proofs[i]
    const row = cohort.observations[i]
    const checked = attestReceipt(row, {
      status: proof?.status,
      transactionHash: proof?.tx,
      blockNumber: proof?.block,
      blockHash: proof?.blockHash,
      logs: proof?.log ? [proof.log] : [],
    })
    if (JSON.stringify(checked) !== JSON.stringify(proof)) fail('attestation_proof_invalid')
  }
  return document
}

export async function collectReceipts(client, cohort, observedAt = new Date().toISOString()) {
  if ((await client.getChainId()) !== 1) fail('wrong_chain')
  const proofs = []
  for (const row of cohort.observations) {
    const receipt = await client.getTransactionReceipt({ hash: row.tx })
    proofs.push(attestReceipt(row, receipt))
  }
  const body = {
    schemaVersion: 1,
    route: ROUTE,
    sourceSha256: cohort.sourceSha256,
    seedSha256: cohort.seedSha256,
    pool: POOL,
    borrowAsset: USDE,
    destination: SUSDE,
    claim: 'borrow_receipt_identity_only_not_route_tvl',
    observedAt,
    checked: cohort.observations.length,
    proofs,
  }
  return validateAttestation({ ...body, documentSha256: sha256(JSON.stringify(body)) }, cohort)
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--run' || token === '--verify') {
      if (options.mode) fail('cli_invalid')
      options.mode = token
    } else if (['--source', '--source-sha256', '--out'].includes(token)) {
      if (options[token]) fail('cli_invalid')
      options[token] = argv[++i]
    } else fail('cli_invalid')
  }
  if (
    !options.mode ||
    !options['--source'] ||
    !options['--source-sha256'] ||
    !options['--out'] ||
    options['--source-sha256'] !== SOURCE_SHA256 ||
    !resolve(options['--out']).endsWith('.json')
  )
    fail('cli_invalid')
  return {
    mode: options.mode,
    source: resolve(options['--source']),
    out: resolve(options['--out']),
  }
}

async function assertDiskFloor(out, bytes) {
  const stats = await statfs(dirname(out))
  if (Number(stats.bavail) * Number(stats.bsize) - bytes < MIN_FREE_BYTES) {
    fail('disk_reserve_reached')
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
  const sourceBytes = await readFile(args.source)
  const seedBytes = await readFile(SEED_PATH)
  const cohort = validateSourceAndSeed(sourceBytes, seedBytes)
  if (args.mode === '--verify') {
    const output = await readFile(args.out)
    const document = JSON.parse(output)
    validateAttestation(document, cohort)
    return {
      status: 'verified',
      checked: document.checked,
      sourceSha256: cohort.sourceSha256,
      outputSha256: sha256(output),
    }
  }
  const env = dependencies.env ?? readEnv()
  const rpc = env.get('RECORDER_RPC_URLS') || env.get('RECORDER_RPC_URL')
  if (!rpc) fail('rpc_unavailable')
  // Bind the chain check and all 25 receipts to one host. Retry a failed
  // collection as a fresh whole pass, never mix hosts within one artifact.
  const client = dependencies.client ?? makeClient(rpc.split(',')[0].trim())
  const document = await collectReceipts(client, cohort)
  const output = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
  await assertDiskFloor(args.out, output.length)
  await writeFile(args.out, output, { flag: 'wx', mode: 0o600 })
  return {
    status: 'sealed',
    checked: document.checked,
    sourceSha256: cohort.sourceSha256,
    outputSha256: sha256(output),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      // Provider errors may embed credential-bearing URLs: print only our own codes.
      process.stderr.write(
        `${/^usde_[a-z_]+$/.test(error?.message) ? error.message : 'usde_receipt_collection_failed'}\n`,
      )
      process.exitCode = 1
    },
  )
}
