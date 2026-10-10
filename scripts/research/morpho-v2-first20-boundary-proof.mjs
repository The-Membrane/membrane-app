// Independent pinned-header proof of the first-20 treated-only horizon selections.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'
import { HEAD } from './morpho-v2-treated-exit-first20.mjs'

export const STUDY = 'morpho-v2-first20-boundary-proof-v1'
export const PILOT_SHA = '7fb48d74c07eb49d06ac133fd147dcef5d80885a19815cea4c58035a2aa9b6a4'
const DAY = 86_400
const HASH = /^0x[\da-f]{64}$/i
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function pinned(path, expected) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expected) throw new Error('Pinned source SHA mismatch')
  return JSON.parse(bytes)
}
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  renameSync(temp, path)
}
function headerOf(raw) {
  const h = { block: Number(raw.number), timestamp: Number(raw.timestamp), hash: raw.hash }
  if (!Number.isSafeInteger(h.block) || !Number.isSafeInteger(h.timestamp) || !HASH.test(h.hash))
    throw new Error('Malformed historical header')
  return h
}

export function verifyBoundary({ key, target, anchorBlock, probe, selected, adjacent, head }) {
  if (probe.status === 'head-censored') {
    if (selected !== null || adjacent !== null || head.timestamp >= target)
      throw new Error('False head censor')
    return
  }
  if (!selected || !adjacent || !HASH.test(probe.hash) ||
      selected.block !== probe.block || selected.timestamp !== probe.timestamp ||
      selected.hash.toLowerCase() !== probe.hash.toLowerCase() || selected.block < anchorBlock ||
      selected.block > HEAD)
    throw new Error('Selected horizon header mismatch')
  if (key === 'preExecutable') {
    if (adjacent.block !== selected.block + 1 || selected.timestamp >= target || adjacent.timestamp < target)
      throw new Error('Pre-executable boundary mismatch')
  } else if (adjacent.block !== selected.block - 1 || selected.timestamp < target || adjacent.timestamp >= target)
    throw new Error('Post-executable boundary mismatch')
}

function targetFor(anchor, key) {
  return anchor.executableAt + (key === 'plus24h' ? DAY : key === 'plus7d' ? 7 * DAY : 0)
}

export function verifyOffline({ out, pilotPath, stage1Path }) {
  const pilot = pinned(pilotPath, PILOT_SHA)
  const stage1 = pinned(stage1Path, STAGE1_SHA)
  const bytes = readFileSync(out)
  const saved = JSON.parse(bytes)
  if (pilot.status !== 'complete' || pilot.results?.length !== 20 ||
      saved.study !== STUDY || saved.status !== 'complete' || saved.pilotSha256 !== PILOT_SHA ||
      saved.stage1Sha256 !== STAGE1_SHA || saved.head?.block !== HEAD ||
      saved.head.hash.toLowerCase() !== stage1.pinnedHeadHash.toLowerCase() ||
      saved.rows?.length !== 18)
    throw new Error('Boundary checkpoint mismatch')
  let index = 0
  for (const row of pilot.results) {
    if (row.anchor.baselineStatus !== 'baseline-success') continue
    const proof = saved.rows[index++]
    if (proof.vault !== row.anchor.vault || proof.anchorBlock !== row.anchor.anchorBlock)
      throw new Error('Boundary row provenance mismatch')
    for (const key of ['preExecutable', 'plus24h', 'plus7d']) {
      const item = proof.horizons[key]
      const target = targetFor(row.anchor, key)
      if (item.target !== target) throw new Error('Boundary target mismatch')
      verifyBoundary({ key, target, anchorBlock: row.anchor.anchorBlock,
        probe: row.probes[key], selected: item.selected, adjacent: item.adjacent, head: saved.head })
    }
  }
  return { checkpointSha256: sha(bytes), verifiedRows: saved.rows.length, verifiedHorizons: saved.rows.length * 3 }
}

export async function run({ client, out, pilotPath, stage1Path }) {
  if (existsSync(out)) return verifyOffline({ out, pilotPath, stage1Path })
  const pilot = pinned(pilotPath, PILOT_SHA)
  const stage1 = pinned(stage1Path, STAGE1_SHA)
  if (pilot.status !== 'complete' || pilot.results?.length !== 20 || (await client.getChainId()) !== 1)
    throw new Error('Frozen pilot/chain mismatch')
  const cache = new Map()
  async function get(block) {
    if (!cache.has(block)) cache.set(block, headerOf(await client.getBlock({ blockNumber: BigInt(block) })))
    return cache.get(block)
  }
  const head = await get(HEAD)
  if (head.hash.toLowerCase() !== stage1.pinnedHeadHash.toLowerCase()) throw new Error('Pinned head mismatch')
  const rows = []
  for (const row of pilot.results) {
    if (row.anchor.baselineStatus !== 'baseline-success') continue
    const horizons = {}
    for (const key of ['preExecutable', 'plus24h', 'plus7d']) {
      const probe = row.probes[key]
      const target = targetFor(row.anchor, key)
      const selected = probe.status === 'head-censored' ? null : await get(probe.block)
      const adjacent = selected ? await get(selected.block + (key === 'preExecutable' ? 1 : -1)) : null
      verifyBoundary({ key, target, anchorBlock: row.anchor.anchorBlock, probe, selected, adjacent, head })
      horizons[key] = { target, selected, adjacent }
    }
    rows.push({ vault: row.anchor.vault, anchorBlock: row.anchor.anchorBlock, horizons })
  }
  atomic(out, { study: STUDY, status: 'complete', pilotSha256: PILOT_SHA, stage1Sha256: STAGE1_SHA, head, rows })
  return verifyOffline({ out, pilotPath, stage1Path })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && args.join(' ') !== '--verify offline') throw new Error('Only --verify offline is supported')
  const paths = {
    out: resolve('data/research/venue-signals/morpho-v2-first20-boundary-proof.json'),
    pilotPath: resolve('data/research/venue-signals/morpho-v2-treated-exit-first20.json'),
    stage1Path: resolve(`data/research/venue-signals/${STAGE1_SHA}.json`),
  }
  try {
    const result = args.length ? verifyOffline(paths) : await run({ ...paths, client: makeClient(process.env.RECORDER_RPC_URL || readEnv().get('RECORDER_RPC_URL')) })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch {
    process.stderr.write('Boundary proof failed; no result was published.\n')
    process.exitCode = 1
  }
}
