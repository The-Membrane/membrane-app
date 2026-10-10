// Offline audit of the frozen Morpho cap study's pre-anchor control risk set.
// It does not read or score exit outcomes.
// Run: node scripts/research/morpho-v2-control-risk-correction.mjs
// Verify: node scripts/research/morpho-v2-control-risk-correction.mjs --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eventKey, FACTORY_SHA, replay, SUBMIT_SHA } from './morpho-v2-cap-lifecycle-census.mjs'
import { LIFECYCLE_SHA, STAGE1_SHA, readInputs } from './morpho-v2-lifecycle-getter-check.mjs'

export const STUDY = 'morpho-v2-control-risk-correction-v1'
export const RESERVE_BYTES = 2_500_000_000
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const DAY = 86_400
const sha = (value) => createHash('sha256').update(value).digest('hex')
const unsigned = (x) => {
  const { checkpointSha256, ...rest } = x
  return rest
}
const seal = (x) => ({ ...unsigned(x), checkpointSha256: sha(JSON.stringify(unsigned(x))) })

export function classifyPrior(prior, state, anchorTimestamp) {
  if (prior.some((x) => x.timestamp >= anchorTimestamp - 7 * DAY)) return 'recent-submit'
  const oldExclusion = prior.some((x) => Number(x.executableAt) > anchorTimestamp)
  let pending = false
  for (const key of new Set(prior.map(eventKey))) {
    const value = state.get(key)
    if (!value || value.ambiguous) return 'ambiguous'
    pending ||= value.pending
  }
  if (oldExclusion && pending) return 'both'
  if (oldExclusion) return 'old-only'
  if (pending) return 'new-only'
  return 'neither'
}

export function calculate(inputs, factory) {
  const { sources, stage1, lifecycle } = inputs
  const factoryByVault = new Map(factory.events.map((x) => [x.vault.toLowerCase(), x]))
  const priorByVault = new Map()
  for (const event of stage1.rawEvents) {
    const vault = event.vault.toLowerCase()
    if (!priorByVault.has(vault)) priorByVault.set(vault, [])
    priorByVault.get(vault).push(event)
  }
  const summary = {
    anchors: 0,
    sameAssetPreAnchorPairs: 0,
    recentSubmit: 0,
    comparablePairs: 0,
    oldOnly: 0,
    newOnly: 0,
    both: 0,
    neither: 0,
    ambiguous: 0,
    affectedAnchors: 0,
    affectedCandidateVaults: 0,
    missedInOldAgeNearest32: 0,
    anchorsWithMissInOldAgeNearest32: 0,
  }
  const affectedVaults = new Set(),
    missed = []
  for (const index of stage1.summary.independentEligibleProposalIndexes) {
    const anchor = stage1.proposals[index]
    const treated = factoryByVault.get(anchor.vault.toLowerCase())
    if (!treated || treated.block >= anchor.block) throw new Error('Invalid treated factory state')
    const treatedAge = anchor.timestamp - treated.timestamp
    const state = replay(sources, lifecycle, anchor.block - 1).state
    const rows = []
    let anchorMissed = false,
      anchorTop32Missed = false
    summary.anchors++
    for (const candidate of factory.events) {
      const vault = candidate.vault.toLowerCase()
      if (
        vault === anchor.vault.toLowerCase() ||
        candidate.block >= anchor.block ||
        candidate.asset.toLowerCase() !== treated.asset.toLowerCase()
      )
        continue
      summary.sameAssetPreAnchorPairs++
      const prior = (priorByVault.get(vault) || []).filter((x) => x.block < anchor.block)
      const classification = classifyPrior(prior, state, anchor.timestamp)
      if (classification === 'recent-submit') {
        summary.recentSubmit++
        continue
      }
      summary.comparablePairs++
      const field = {
        'old-only': 'oldOnly',
        'new-only': 'newOnly',
        both: 'both',
        neither: 'neither',
        ambiguous: 'ambiguous',
      }[classification]
      summary[field]++
      const age = anchor.timestamp - candidate.timestamp
      const distance = Math.abs(Math.log((age + DAY) / (treatedAge + DAY)))
      rows.push({ vault, classification, distance, prior })
      if (classification === 'new-only') {
        anchorMissed = true
        affectedVaults.add(vault)
      }
    }
    const oldClean = rows
      .filter((x) => !['old-only', 'both', 'ambiguous'].includes(x.classification))
      .sort((a, b) => a.distance - b.distance || a.vault.localeCompare(b.vault))
    for (let rank = 0; rank < oldClean.length; rank++) {
      const row = oldClean[rank]
      if (row.classification !== 'new-only') continue
      if (rank < 32) {
        summary.missedInOldAgeNearest32++
        anchorTop32Missed = true
      }
      const pendingKeys = [...new Set(row.prior.map(eventKey))].filter(
        (key) => state.get(key)?.pending,
      )
      missed.push({
        proposalIndex: index,
        anchorBlock: anchor.block,
        candidateVault: row.vault,
        oldAgeRank: rank,
        pendingKeySha256: pendingKeys.map((key) => sha(key)),
      })
    }
    if (anchorMissed) summary.affectedAnchors++
    if (anchorTop32Missed) summary.anchorsWithMissInOldAgeNearest32++
  }
  summary.affectedCandidateVaults = affectedVaults.size
  if (
    summary.anchors !== 304 ||
    summary.comparablePairs !==
      summary.oldOnly + summary.newOnly + summary.both + summary.neither + summary.ambiguous ||
    missed.length !== summary.newOnly
  )
    throw new Error('Control-risk accounting mismatch')
  return seal({
    study: STUDY,
    status: 'complete',
    factorySha256: FACTORY_SHA,
    submitSha256: SUBMIT_SHA,
    stage1Sha256: STAGE1_SHA,
    lifecycleSha256: LIFECYCLE_SHA,
    summary,
    missed,
  })
}

function paths() {
  const base = 'data/research/venue-signals/'
  return {
    factoryPath: resolve(`${base}${FACTORY_SHA}.json`),
    submitPath: resolve(`${base}${SUBMIT_SHA}.json`),
    stage1Path: resolve(`${base}${STAGE1_SHA}.json`),
    lifecyclePath: resolve(`${base}morpho-v2-cap-lifecycle-census.json`),
    out: resolve(`${base}morpho-v2-control-risk-correction.json`),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const verify =
      process.argv.length === 4 && process.argv[2] === '--verify' && process.argv[3] === 'true'
    if (process.argv.length !== 2 && !verify) throw new Error('Invalid arguments')
    const p = paths()
    const inputs = readInputs(p)
    const result = calculate(inputs, JSON.parse(readFileSync(p.factoryPath, 'utf8')))
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES)
      throw new Error('Output size cap')
    if (verify) {
      const bytes = readFileSync(p.out)
      if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(result))
        throw new Error('Saved result mismatch')
      process.stdout.write(JSON.stringify({ summary: result.summary, sha256: sha(bytes) }) + '\n')
    } else {
      const disk = statfsSync(dirname(p.out))
      if (
        Number(disk.bavail) * Number(disk.bsize) - Buffer.byteLength(JSON.stringify(result)) <
        RESERVE_BYTES
      )
        throw new Error('Disk reserve reached')
      mkdirSync(dirname(p.out), { recursive: true })
      if (existsSync(p.out)) throw new Error('Existing artifact; use --verify true')
      const temp = `${p.out}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(result), { mode: 0o600 })
      renameSync(temp, p.out)
      process.stdout.write(
        JSON.stringify({ summary: result.summary, sha256: sha(readFileSync(p.out)) }) + '\n',
      )
    }
  } catch {
    process.stderr.write(
      'Control risk-set correction stopped; source or resource validation failed.\n',
    )
    process.exitCode = 1
  }
}
