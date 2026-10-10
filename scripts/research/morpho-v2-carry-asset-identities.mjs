// Independently attest the displayed August Carry cohort's Morpho Vault V2
// asset identities against canonical Ethereum transaction receipts.
// node scripts/research/morpho-v2-carry-asset-identities.mjs --write
// node scripts/research/morpho-v2-carry-asset-identities.mjs --verify
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeCreation, FACTORY, TOPIC0, EVENT } from './morpho-v2-factory-census.mjs'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { toEventSelector } from 'viem'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SOURCE = 'data/research/venue-signals/morpho-v2-factory-census.json'
const SEED = 'scripts/route-cohort/aug-2026-ab-vault-seed.json'
const BOARD = 'components/Carry/fixtures.ts'
const MANIFEST = 'lib/carry/morpho-v2-asset-identities.json'
// The source census is intentionally ignored by git. Keep its canonical hash
// here so an offline verifier cannot silently accept rewritten provenance.
export const SOURCE_SHA256 = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
const ADDR = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const lower = (value) => String(value || '').toLowerCase()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const safeInteger = (value) =>
  (typeof value === 'number' || typeof value === 'bigint') &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0

function cohortVaults(boardSource, seed) {
  const routeKeys = [...boardSource.matchAll(/routeKey:\s*['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  )
  if (routeKeys.length !== 25 || new Set(routeKeys).size !== 25)
    throw new Error('displayed_board_changed')
  const displayed = new Set(routeKeys)
  const morphoRoutes = new Set(routeKeys.filter((key) => key.includes('→ VaultV2 [')))
  if (morphoRoutes.size !== 7 || !Array.isArray(seed.positions) || !seed.cohortId) {
    throw new Error('morpho_cohort_changed')
  }
  const displayedVaults = new Set()
  const morphoVaults = new Set()
  for (const position of seed.positions) {
    const address = lower(position.vault)
    if (!ADDR.test(address) || !Array.isArray(position.routeIds))
      throw new Error('invalid_seed_position')
    if (position.routeIds.some((key) => displayed.has(key))) displayedVaults.add(address)
    if (position.routeIds.some((key) => morphoRoutes.has(key))) morphoVaults.add(address)
  }
  if (displayedVaults.size !== 63 || morphoVaults.size !== 49)
    throw new Error('displayed_cohort_changed')
  return morphoVaults
}

export function selectCandidates({ boardSource, seed, census, sourceHash }) {
  if (
    toEventSelector(EVENT).toLowerCase() !== TOPIC0 ||
    census?.status !== 'complete' ||
    lower(census.factory) !== lower(FACTORY) ||
    lower(census.topic0) !== TOPIC0 ||
    sourceHash !== SOURCE_SHA256
  ) {
    throw new Error('invalid_factory_source')
  }
  const morphoVaults = cohortVaults(boardSource, seed)
  const byVault = new Map()
  for (const event of census.events || []) {
    const address = lower(event.vault)
    if (!morphoVaults.has(address)) continue
    if (byVault.has(address)) throw new Error('duplicate_factory_event')
    byVault.set(address, event)
  }
  if (byVault.size !== morphoVaults.size) throw new Error('missing_factory_event')
  return {
    cohortId: seed.cohortId,
    sourceSha256: sourceHash,
    provenance: 'census',
    candidates: [...byVault.values()].sort((a, b) => lower(a.vault).localeCompare(lower(b.vault))),
  }
}

export function selectManifestCandidates({ boardSource, seed, manifest }) {
  if (
    toEventSelector(EVENT).toLowerCase() !== TOPIC0 ||
    manifest?.schemaVersion !== 1 ||
    manifest.chainId !== 1 ||
    manifest.cohortId !== seed.cohortId ||
    lower(manifest.factory) !== lower(FACTORY) ||
    lower(manifest.eventTopic0) !== TOPIC0 ||
    manifest.sourceArtifact?.path !== SOURCE ||
    manifest.sourceArtifact.sha256 !== SOURCE_SHA256 ||
    !safeInteger(manifest.verification?.blockNumber) ||
    !HASH.test(lower(manifest.verification?.blockHash)) ||
    !safeInteger(manifest.verification?.timestamp) ||
    manifest.verification?.method !== 'ethereum_finalized_header_and_exact_transaction_receipt' ||
    !Array.isArray(manifest.entries)
  ) {
    throw new Error('invalid_manifest_metadata')
  }
  const morphoVaults = cohortVaults(boardSource, seed)
  const found = new Set()
  const candidates = manifest.entries.map((entry) => {
    const vault = lower(entry.vault)
    const creation = entry.creation
    if (
      !morphoVaults.has(vault) ||
      found.has(vault) ||
      !ADDR.test(vault) ||
      !ADDR.test(lower(entry.asset)) ||
      !safeInteger(creation?.blockNumber) ||
      !HASH.test(lower(creation?.blockHash)) ||
      !HASH.test(lower(creation?.txHash)) ||
      !safeInteger(creation?.transactionIndex) ||
      !safeInteger(creation?.logIndex)
    ) {
      throw new Error('invalid_manifest_entry')
    }
    found.add(vault)
    return {
      vault,
      asset: lower(entry.asset),
      block: creation.blockNumber,
      blockHash: lower(creation.blockHash),
      txHash: lower(creation.txHash),
      transactionIndex: creation.transactionIndex,
      logIndex: creation.logIndex,
    }
  })
  if (found.size !== morphoVaults.size) throw new Error('manifest_cohort_incomplete')
  candidates.sort((a, b) => a.vault.localeCompare(b.vault))
  return {
    cohortId: seed.cohortId,
    sourceSha256: SOURCE_SHA256,
    provenance: 'manifest',
    candidates,
  }
}

export async function verifyCandidates({ client, selection, pinnedBlock }) {
  if ((await client.getChainId()) !== 1) throw new Error('wrong_chain')
  const pin =
    pinnedBlock === undefined
      ? await client.getBlock({ blockTag: 'finalized' })
      : await client.getBlock({ blockNumber: BigInt(pinnedBlock) })
  if (!safeInteger(pin.number) || !safeInteger(pin.timestamp) || !HASH.test(lower(pin.hash))) {
    throw new Error('invalid_verification_block')
  }
  const entries = []
  for (const event of selection.candidates) {
    if (
      !safeInteger(event.block) ||
      Number(event.block) > Number(pin.number) ||
      !HASH.test(lower(event.blockHash)) ||
      !HASH.test(lower(event.txHash)) ||
      !safeInteger(event.logIndex) ||
      !safeInteger(event.transactionIndex)
    ) {
      throw new Error('invalid_source_event')
    }
    const [block, receipt] = await Promise.all([
      client.getBlock({ blockNumber: BigInt(event.block) }),
      client.getTransactionReceipt({ hash: event.txHash }),
    ])
    if (
      lower(block.hash) !== lower(event.blockHash) ||
      !safeInteger(block.timestamp) ||
      (selection.provenance !== 'manifest' && Number(block.timestamp) !== event.timestamp) ||
      lower(receipt.blockHash) !== lower(event.blockHash) ||
      Number(receipt.blockNumber) !== event.block ||
      lower(receipt.transactionHash) !== lower(event.txHash) ||
      Number(receipt.transactionIndex) !== event.transactionIndex ||
      receipt.status !== 'success'
    ) {
      throw new Error('factory_receipt_coordinate_mismatch')
    }
    const matches = receipt.logs.filter((log) => Number(log.logIndex) === event.logIndex)
    if (matches.length !== 1) throw new Error('factory_log_missing_or_duplicate')
    const decoded = decodeCreation(matches[0], Number(block.timestamp))
    const addressFields =
      selection.provenance === 'manifest' ? ['asset', 'vault'] : ['owner', 'asset', 'vault']
    const hashFields =
      selection.provenance === 'manifest'
        ? ['blockHash', 'txHash']
        : ['blockHash', 'txHash', 'salt']
    if (
      decoded.block !== event.block ||
      decoded.logIndex !== event.logIndex ||
      decoded.transactionIndex !== event.transactionIndex ||
      (selection.provenance !== 'manifest' && decoded.timestamp !== event.timestamp) ||
      addressFields.some((key) => lower(decoded[key]) !== lower(event[key])) ||
      hashFields.some((key) => lower(decoded[key]) !== lower(event[key]))
    ) {
      throw new Error('factory_event_payload_mismatch')
    }
    entries.push({
      vault: lower(decoded.vault),
      asset: lower(decoded.asset),
      creation: {
        blockNumber: decoded.block,
        blockHash: lower(decoded.blockHash),
        txHash: lower(decoded.txHash),
        transactionIndex: decoded.transactionIndex,
        logIndex: decoded.logIndex,
      },
    })
  }
  return {
    schemaVersion: 1,
    chainId: 1,
    cohortId: selection.cohortId,
    sourceArtifact: { path: SOURCE, sha256: selection.sourceSha256 },
    factory: lower(FACTORY),
    eventTopic0: TOPIC0,
    verification: {
      blockNumber: Number(pin.number),
      blockHash: lower(pin.hash),
      timestamp: Number(pin.timestamp),
      method: 'ethereum_finalized_header_and_exact_transaction_receipt',
    },
    entries,
  }
}

export function loadSelection(existing = null, sourcePath = resolve(ROOT, SOURCE)) {
  const boardSource = readFileSync(resolve(ROOT, BOARD), 'utf8')
  const seed = JSON.parse(readFileSync(resolve(ROOT, SEED), 'utf8'))
  if (existsSync(sourcePath)) {
    const sourceBytes = readFileSync(sourcePath)
    return selectCandidates({
      boardSource,
      seed,
      census: JSON.parse(sourceBytes),
      sourceHash: sha256(sourceBytes),
    })
  }
  if (!existing) throw new Error('factory_source_missing_for_generation')
  return selectManifestCandidates({ boardSource, seed, manifest: existing })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  if (!['--write', '--verify'].includes(mode) || process.argv.length !== 3) {
    throw new Error('Use --write or --verify')
  }
  try {
    const existing =
      mode === '--verify' ? JSON.parse(readFileSync(resolve(ROOT, MANIFEST), 'utf8')) : null
    const rpc =
      process.env.RECORDER_RPC_URLS ||
      process.env.RECORDER_RPC_URL ||
      readEnv().get('RECORDER_RPC_URLS') ||
      readEnv().get('RECORDER_RPC_URL')
    if (!rpc) throw new Error('rpc_missing')
    const result = await verifyCandidates({
      client: makeClient(rpc),
      selection: loadSelection(existing),
      pinnedBlock: existing?.verification?.blockNumber,
    })
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(result)) throw new Error('manifest_mismatch')
    } else {
      writeFileSync(resolve(ROOT, MANIFEST), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    }
    process.stdout.write(
      JSON.stringify({
        status: 'verified',
        vaults: result.entries.length,
        blockNumber: result.verification.blockNumber,
        manifest: MANIFEST,
      }) + '\n',
    )
  } catch {
    // RPC errors can contain credential-bearing URLs. Never print the cause.
    process.stderr.write('Morpho Carry asset identity attestation failed closed.\n')
    process.exitCode = 1
  }
}
