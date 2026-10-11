// Shared, public-chain-only evidence and immutable local-ledger primitives.
import { createHash, randomUUID } from 'node:crypto'
import { constants, statfsSync } from 'node:fs'
import { link, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CARRY_EXIT_V2_FROZEN_ROUTES,
  validateCarryExitV2RpcProof,
} from '../lib/carry-exit-v2-rpc-proof.mjs'
import { assembleCarryExitV2CallEvidence } from '../lib/carry-exit-v2-proof-assembly.mjs'
import { publicRpcClients } from './carry-public-direct-exit-issue.mjs'

export const ROUTE = CARRY_EXIT_V2_FROZEN_ROUTES.find(
  (row) =>
    row.kind === 'usd3' &&
    row.routeKey === 'USDC → USD3 [USDC]' &&
    row.destination === '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc' &&
    row.asset === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
)
if (!ROUTE) throw Error('public_usd3_frozen_route_missing')
export const HORIZONS_HOURS = Object.freeze([1, 4, 24, 48, 168])
export const CAPTURE_DEADLINE_HOURS = 2
export const MAX_RECORD_BYTES = 256 * 1024
const DISK_RESERVE_BYTES = 1_073_741_824
const MAX_ORIGIN_PAIRS = 24
const ORIGIN_RUN_MS = 8 * 60_000
export const HASH = /^[0-9a-f]{64}$/
export const BLOCK_HASH = /^0x[0-9a-f]{64}$/
export const ADDRESS = /^0x[0-9a-f]{40}$/
export const DECIMAL = /^(0|[1-9][0-9]*)$/
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const STORAGE_WORD = /^0x[0-9a-f]{64}$/
export const sha = (value) => createHash('sha256').update(value).digest('hex')
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export const withoutSeal = ({ sha256: _seal, ...body }) => body
export const nameFor = (sequence) => `${String(sequence).padStart(8, '0')}.json`

export async function assertUsd3ImplementationPair(primary, secondary, blockHash) {
  if (!BLOCK_HASH.test(blockHash ?? '') || !ADDRESS.test(ROUTE.implementation ?? ''))
    throw Error('usd3_implementation_identity_invalid')
  const pin = { blockHash, requireCanonical: true }
  const words = await Promise.all(
    [primary, secondary].map((origin) =>
      origin.request('eth_getStorageAt', [ROUTE.destination, IMPLEMENTATION_SLOT, pin]),
    ),
  )
  if (
    !words.every((word) => STORAGE_WORD.test(word ?? '')) ||
    words.some((word) => `0x${word.slice(-40)}` !== ROUTE.implementation)
  )
    throw Error('usd3_implementation_identity_invalid')
  return true
}

/** Bounded cyclic rotation reaches each candidate primary before retrying offsets. */
export function rotatingUsd3OriginPairs(urls, makeClients = publicRpcClients, clock = Date.now) {
  if (!Array.isArray(urls) || urls.length < 2 || urls.length > 8)
    throw Error('usd3_public_origins_invalid')
  const deadline = clock() + ORIGIN_RUN_MS
  const pairs = []
  for (let offset = 1; offset < urls.length && pairs.length < MAX_ORIGIN_PAIRS; offset++) {
    for (let primary = 0; primary < urls.length && pairs.length < MAX_ORIGIN_PAIRS; primary++) {
      const secondary = (primary + offset) % urls.length
      let clients
      try {
        clients = makeClients([urls[primary], urls[secondary]])
      } catch {
        continue
      }
      if (
        !Array.isArray(clients) ||
        clients.length !== 2 ||
        clients[0].provider === clients[1].provider
      )
        continue
      pairs.push(
        clients.map((client) => ({
          url: client.url,
          provider: client.provider,
          async request(method, params) {
            if (clock() >= deadline) throw Error('usd3_public_rpc_budget_exhausted')
            return client.request(method, params)
          },
          async send(envelope) {
            if (clock() >= deadline) throw Error('usd3_public_rpc_budget_exhausted')
            return client.send(envelope)
          },
        })),
      )
    }
  }
  if (!pairs.length) throw Error('usd3_two_public_origins_required')
  return pairs
}
export function utc(value) {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value)
    throw Error('usd3_clock_invalid')
  return ms
}

export async function readNumbered(out) {
  let names
  try {
    names = (await readdir(out)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const name of names) {
    if (name !== nameFor(rows.length + 1)) throw Error('usd3_ledger_gap')
    const handle = await open(join(out, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw Error('usd3_record_too_large')
      bytes = await handle.readFile()
    } finally {
      await handle.close()
    }
    if (bytes.length > MAX_RECORD_BYTES) throw Error('usd3_record_too_large')
    const row = JSON.parse(bytes.toString('utf8'))
    if (
      bytes.toString('utf8') !== `${JSON.stringify(row)}\n` ||
      row.sequence !== rows.length + 1 ||
      row.previousSha256 !== (rows.at(-1)?.sha256 ?? null) ||
      row.sha256 !== sha(JSON.stringify(withoutSeal(row)))
    )
      throw Error('usd3_ledger_chain_invalid')
    rows.push(row)
  }
  return rows
}

export async function appendNumbered(
  row,
  out,
  verify,
  stat = statfsSync,
  { linkFile = link } = {},
) {
  await mkdir(out, { recursive: true })
  const prior = await verify(out)
  if (
    row.sequence !== prior.length + 1 ||
    row.previousSha256 !== (prior.at(-1)?.sha256 ?? null) ||
    row.sha256 !== sha(JSON.stringify(withoutSeal(row)))
  )
    throw Error('usd3_ledger_changed')
  const serialized = `${JSON.stringify(row)}\n`
  const size = Buffer.byteLength(serialized)
  if (size > MAX_RECORD_BYTES) throw Error('usd3_record_too_large')
  const disk = stat(out)
  if (Number(disk.bavail) * Number(disk.bsize) < DISK_RESERVE_BYTES + size)
    throw Error('usd3_disk_reserve')
  const temporary = join(out, `.usd3-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(serialized)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await linkFile(temporary, join(out, nameFor(row.sequence)))
    const directory = await open(out, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
  return { sequence: row.sequence, sha256: row.sha256 }
}

export function verifyUsd3Measurement({
  holder,
  assetsRaw,
  blockNumber,
  blockHash,
  blockAtUtc,
  source,
  measurement,
  beforeAtUtc,
  afterAtUtc,
}) {
  const evidence = measurement?.evidence
  if (
    !ADDRESS.test(holder ?? '') ||
    !DECIMAL.test(assetsRaw ?? '') ||
    BigInt(assetsRaw) === 0n ||
    !DECIMAL.test(blockNumber ?? '') ||
    !BLOCK_HASH.test(blockHash ?? '') ||
    evidence?.verificationStatus !== 'verified' ||
    !HASH.test(measurement.evidenceSha256 ?? '') ||
    measurement.evidenceSha256 !== sha(JSON.stringify(evidence)) ||
    evidence.identityEvidence?.holder !== holder ||
    evidence.identityEvidence?.asset !== ROUTE.asset ||
    evidence.identityEvidence?.destination !== ROUTE.destination ||
    evidence.identityEvidence?.blockNumber !== blockNumber ||
    evidence.identityEvidence?.blockHash !== blockHash ||
    evidence.identityEvidence?.source !== source ||
    evidence.replayEvidenceDoc?.blockNumber !== blockNumber ||
    evidence.replayEvidenceDoc?.blockHash !== blockHash ||
    utc(evidence.replayEvidenceDoc?.observedAt) < utc(beforeAtUtc) ||
    utc(evidence.replayEvidenceDoc?.observedAt) > utc(afterAtUtc)
  )
    throw Error('usd3_measurement_identity_invalid')
  for (const origin of ['primary', 'secondary'])
    for (const phase of ['before', 'after']) {
      const target = evidence.replayEvidenceDoc.headers?.[origin]?.[phase]?.target
      if (
        target?.hash !== blockHash ||
        BigInt(target?.number ?? -1) !== BigInt(blockNumber) ||
        new Date(Number(BigInt(target?.timestamp ?? -1)) * 1000).toISOString() !== blockAtUtc
      )
        throw Error('usd3_measurement_header_invalid')
    }
  const frozen = { ...ROUTE, holder, assetsRaw, blockNumber, blockHash }
  const decoded = validateCarryExitV2RpcProof({ proof: evidence, ...frozen })
  const reconstructed = assembleCarryExitV2CallEvidence({
    frozen,
    collector: {
      status: 'raw_rpc_collected',
      blockNumber,
      blockHash,
      routeKind: 'usd3',
      provider: evidence.identityEvidence.provider,
      source,
      proof: evidence,
      identityEvidence: evidence.identityEvidence,
    },
    replay: {
      status: 'verified',
      verdict: { simulationStatus: decoded.simulationStatus, coveredRevert: decoded.coveredRevert },
      replayEvidenceDoc: evidence.replayEvidenceDoc,
    },
  })
  if (
    !same(reconstructed, evidence) ||
    measurement.simulationStatus !== decoded.simulationStatus ||
    measurement.holderSharesRaw !== decoded.holderCoverageRaw ||
    measurement.previewWithdrawSharesRaw !== decoded.requiredCoverageRaw ||
    measurement.burnedSharesRaw !== decoded.actualConsumedRaw ||
    measurement.coveredRevert !== decoded.coveredRevert
  )
    throw Error('usd3_measurement_replay_invalid')
  if (
    decoded.simulationStatus === 'success' &&
    (!DECIMAL.test(decoded.actualConsumedRaw ?? '') || BigInt(decoded.actualConsumedRaw) === 0n)
  )
    throw Error('usd3_success_burn_invalid')
  return decoded
}
