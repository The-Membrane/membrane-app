// Offline-only continuation pages for the frozen 304-anchor Morpho control risk set.
// Dry: node scripts/research/morpho-v2-control-pages.mjs --anchor-index 0 --offset 32
// Save: node scripts/research/morpho-v2-control-pages.mjs --anchor-index 0 --offset 32 --run true
// Verify: node scripts/research/morpho-v2-control-pages.mjs --anchor-index 0 --offset 32 --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eventKey, FACTORY_SHA, SUBMIT_SHA, replay } from './morpho-v2-cap-lifecycle-census.mjs'
import { STAGE1_SHA, LIFECYCLE_SHA } from './morpho-v2-lifecycle-getter-check.mjs'
import { load, paths } from './morpho-v2-full-cohort-manifest.mjs'
import { MANIFEST_SHA } from './morpho-v2-full-cohort-baseline.mjs'

export const STUDY = 'morpho-v2-full-cohort-control-page-v1'
export const PAGE_SIZE = 32
export const RESERVE_BYTES = 2_500_000_000
export const MAX_OUTPUT_BYTES = 128 * 1024
const DAY = 86_400
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({
  ...unsigned(value),
  checkpointSha256: sha(JSON.stringify(unsigned(value))),
})

export function computePage({ factoryEvents, rawEvents, state, anchor, treatedCreation, offset }) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < PAGE_SIZE ||
    offset % PAGE_SIZE !== 0 ||
    !Number.isSafeInteger(anchor?.block) ||
    !Number.isSafeInteger(anchor?.timestamp) ||
    !treatedCreation ||
    treatedCreation.block >= anchor.block ||
    treatedCreation.timestamp >= anchor.timestamp
  )
    throw new Error('Invalid frozen control-page input')
  const treatedAge = anchor.timestamp - treatedCreation.timestamp
  const counts = { sameAssetPreAnchor: 0, recentSevenDay: 0, pending: 0, ambiguous: 0, clean: 0 }
  const clean = []
  const priorByVault = new Map()
  for (const event of rawEvents) {
    if (event.block >= anchor.block) continue
    const key = event.vault.toLowerCase()
    if (!priorByVault.has(key)) priorByVault.set(key, [])
    priorByVault.get(key).push(event)
  }
  for (const candidate of factoryEvents) {
    const vault = candidate.vault.toLowerCase()
    if (
      vault === anchor.vault.toLowerCase() ||
      candidate.block >= anchor.block ||
      candidate.asset.toLowerCase() !== treatedCreation.asset.toLowerCase()
    )
      continue
    counts.sameAssetPreAnchor++
    const prior = priorByVault.get(vault) || []
    // Recent Submit is excluded even when already accepted/revoked.
    if (prior.some((event) => event.timestamp >= anchor.timestamp - 7 * DAY)) {
      counts.recentSevenDay++
      continue
    }
    let pending = false,
      ambiguous = false
    for (const key of new Set(prior.map(eventKey))) {
      const value = state.get(key)
      if (!value || value.ambiguous) ambiguous = true
      else if (value.pending) pending = true
    }
    if (ambiguous) {
      counts.ambiguous++
      continue
    }
    if (pending) {
      counts.pending++
      continue
    }
    counts.clean++
    const age = anchor.timestamp - candidate.timestamp
    if (age <= 0) throw new Error('Control creation is not pre-anchor')
    clean.push({
      vault,
      creationBlock: candidate.block,
      creationTimestamp: candidate.timestamp,
      ageSeconds: age,
      distance: Math.abs(Math.log((age + DAY) / (treatedAge + DAY))),
    })
  }
  if (
    counts.recentSevenDay + counts.pending + counts.ambiguous + counts.clean !==
    counts.sameAssetPreAnchor
  )
    throw new Error('Control risk-set accounting mismatch')
  clean.sort((a, b) => a.distance - b.distance || a.vault.localeCompare(b.vault))
  const stripDistance = ({ distance, ...rest }) => rest
  return {
    counts,
    totalClean: clean.length,
    firstCleanCandidates: clean.slice(0, PAGE_SIZE).map(stripDistance),
    firstNextOffset: clean.length > PAGE_SIZE ? PAGE_SIZE : null,
    candidates: clean.slice(offset, offset + PAGE_SIZE).map(stripDistance),
    nextCleanOffset: clean.length > offset + PAGE_SIZE ? offset + PAGE_SIZE : null,
  }
}

export function buildPage({ inputs, manifest, anchorIndex, offset }) {
  if (
    !Number.isSafeInteger(anchorIndex) ||
    anchorIndex < 0 ||
    anchorIndex >= 304 ||
    manifest.study !== 'morpho-v2-full-cohort-manifest-v1' ||
    manifest.status !== 'complete' ||
    manifest.rows?.length !== 304 ||
    manifest.summary?.anchors !== 304
  )
    throw new Error('Frozen manifest or anchor index mismatch')
  const row = manifest.rows[anchorIndex]
  const anchor = inputs.stage1.proposals[row.proposalIndex]
  const treatedCreation = inputs.factory.events.find((x) => x.vault.toLowerCase() === row.vault)
  if (
    !anchor ||
    anchor.block !== row.anchorBlock ||
    anchor.timestamp !== row.anchorTimestamp ||
    anchor.vault.toLowerCase() !== row.vault ||
    !treatedCreation
  )
    throw new Error('Frozen anchor identity mismatch')
  // replay() itself requires a SHA-validated complete prefix through exact B−1.
  const state = replay(inputs.sources, inputs.lifecycle, anchor.block - 1).state
  const page = computePage({
    factoryEvents: inputs.factory.events,
    rawEvents: inputs.stage1.rawEvents,
    state,
    anchor,
    treatedCreation,
    offset,
  })
  if (
    JSON.stringify(page.counts) !== JSON.stringify(row.controls.counts) ||
    JSON.stringify(page.firstCleanCandidates) !==
      JSON.stringify(row.controls.firstCleanCandidates) ||
    page.firstNextOffset !== row.controls.nextCleanOffset
  )
    throw new Error('Regenerated first page differs from sealed manifest')
  if (offset >= page.totalClean) throw new Error('Offset has no continuation page')
  return seal({
    study: STUDY,
    status: 'complete-offline-page',
    chainId: 1,
    manifestSha256: MANIFEST_SHA,
    factorySha256: FACTORY_SHA,
    submitSha256: SUBMIT_SHA,
    stage1Sha256: STAGE1_SHA,
    lifecycleSha256: LIFECYCLE_SHA,
    anchorIndex,
    proposalIndex: row.proposalIndex,
    vault: row.vault,
    anchorBlock: row.anchorBlock,
    asOfBlock: row.anchorBlock - 1,
    offset,
    pageSize: PAGE_SIZE,
    totalClean: page.totalClean,
    nextCleanOffset: page.nextCleanOffset,
    candidates: page.candidates,
    firstPageVerified: true,
    denominatorStatus: '304-anchor-study-incomplete',
  })
}

export function loadPageInputs(p = paths()) {
  const inputs = load(p) // SHA-pins factory, raw Submit, Stage 1, lifecycle and head.
  const bytes = readFileSync(p.out)
  if (sha(bytes) !== MANIFEST_SHA) throw new Error('Pinned manifest physical SHA mismatch')
  return { inputs, manifest: JSON.parse(bytes) }
}

export function verifyPage(saved, expected) {
  if (
    !saved ||
    JSON.stringify(saved) !== JSON.stringify(expected) ||
    saved.checkpointSha256 !== seal(saved).checkpointSha256
  )
    throw new Error('Control page content or seal mismatch')
  return saved
}

function options(args) {
  const opts = {}
  for (let i = 0; i < args.length; i += 2) {
    if (
      !args[i]?.startsWith('--') ||
      args[i + 1] === undefined ||
      opts[args[i].slice(2)] !== undefined
    )
      throw new Error('Expected unique --key value arguments')
    opts[args[i].slice(2)] = args[i + 1]
  }
  if (
    Object.keys(opts).some(
      (x) => !['anchor-index', 'offset', 'out', 'run', 'verify'].includes(x),
    ) ||
    (opts.run && opts.run !== 'true') ||
    (opts.verify && opts.verify !== 'true') ||
    (opts.run && opts.verify)
  )
    throw new Error('Invalid control-page options')
  return opts
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = options(process.argv.slice(2))
    const anchorIndex = Number(opts['anchor-index']),
      offset = Number(opts.offset)
    const out = resolve(
      opts.out ||
        `data/research/venue-signals/morpho-v2-control-page-${anchorIndex}-${offset}.json`,
    )
    const page = buildPage({ ...loadPageInputs(), anchorIndex, offset })
    const bytes = JSON.stringify(page)
    if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES)
      throw new Error('Control page output cap reached')
    if (opts.verify) {
      verifyPage(JSON.parse(readFileSync(out, 'utf8')), page)
      process.stdout.write(
        JSON.stringify({
          mode: 'verify',
          out,
          sha256: sha(readFileSync(out)),
          count: page.candidates.length,
          nextCleanOffset: page.nextCleanOffset,
        }) + '\n',
      )
    } else if (opts.run) {
      mkdirSync(dirname(out), { recursive: true })
      const disk = statfsSync(dirname(out))
      if (Number(disk.bavail) * Number(disk.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
        throw new Error('Disk reserve reached')
      if (existsSync(out)) {
        verifyPage(JSON.parse(readFileSync(out, 'utf8')), page)
      } else {
        const temp = `${out}.${process.pid}.tmp`
        writeFileSync(temp, bytes, { mode: 0o600 })
        renameSync(temp, out)
      }
      process.stdout.write(
        JSON.stringify({
          mode: 'saved',
          out,
          sha256: sha(readFileSync(out)),
          count: page.candidates.length,
          nextCleanOffset: page.nextCleanOffset,
        }) + '\n',
      )
    } else process.stdout.write(JSON.stringify({ mode: 'dry', ...page }) + '\n')
  } catch {
    process.stderr.write(
      'Offline control page stopped; source, order, or resource validation failed.\n',
    )
    process.exitCode = 1
  }
}
