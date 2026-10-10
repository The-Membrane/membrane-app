// Frozen, outcome-blind Morpho Vault V2 cap-proposal and control-risk manifest.
// Dry: node scripts/research/morpho-v2-full-cohort-manifest.mjs
// Write: node scripts/research/morpho-v2-full-cohort-manifest.mjs --run true
// Offline: node scripts/research/morpho-v2-full-cohort-manifest.mjs --verify true
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  eventKey,
  FACTORY_SHA,
  PINNED_HEAD_HASH,
  replay,
  SUBMIT_SHA,
  TO_BLOCK,
} from './morpho-v2-cap-lifecycle-census.mjs'
import { LIFECYCLE_SHA, readInputs, STAGE1_SHA } from './morpho-v2-lifecycle-getter-check.mjs'

export const STUDY = 'morpho-v2-full-cohort-manifest-v1'
export const HEAD_SOURCE_SHA = '88b0416be1fd407079d38321d9d5e199755ce51a71c8331fa556a70aaac05363'
export const RESERVE_BYTES = 2_500_000_000
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
export const CONTROL_PAGE_SIZE = 32
const DAY = 86_400
const CAP_SELECTORS = new Set(['0xf6f98fd5', '0x2438525b'])
const SHA = /^[\da-f]{64}$/
const ADDRESS = /^0x[\da-f]{40}$/
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unsigned = ({ checkpointSha256, ...rest }) => rest
const seal = (value) => ({
  ...unsigned(value),
  checkpointSha256: sha(JSON.stringify(unsigned(value))),
})

export function readHead(bytes) {
  if (sha(bytes) !== HEAD_SOURCE_SHA) throw new Error('Pinned head source SHA mismatch')
  const saved = JSON.parse(bytes)
  const head = saved.pinnedHead
  if (
    saved.study !== 'morpho-v2-cap-route-overlap-v1' ||
    saved.chainId !== 1 ||
    head?.block !== TO_BLOCK ||
    head.hash?.toLowerCase() !== PINNED_HEAD_HASH ||
    !Number.isSafeInteger(head.timestamp) ||
    head.timestamp <= 0
  )
    throw new Error('Pinned head source metadata mismatch')
  return { block: head.block, hash: PINNED_HEAD_HASH, timestamp: head.timestamp }
}

export function controlRiskSet({ factoryEvents, priorByVault, state, anchor, treatedCreation }) {
  if (
    !treatedCreation ||
    treatedCreation.block >= anchor.block ||
    treatedCreation.timestamp >= anchor.timestamp
  )
    throw new Error('Invalid treated factory creation')
  const treatedAge = anchor.timestamp - treatedCreation.timestamp
  const counts = { sameAssetPreAnchor: 0, recentSevenDay: 0, pending: 0, ambiguous: 0, clean: 0 }
  const clean = []
  for (const candidate of factoryEvents) {
    const vault = candidate.vault.toLowerCase()
    if (
      vault === anchor.vault.toLowerCase() ||
      candidate.block >= anchor.block ||
      candidate.asset.toLowerCase() !== treatedCreation.asset.toLowerCase()
    )
      continue
    counts.sameAssetPreAnchor++
    const prior = (priorByVault.get(vault) || []).filter((x) => x.block < anchor.block)
    // A recent Submit is excluded unconditionally. Settlement after Submit does not erase
    // exposure to the same warning within the seven-day independence window.
    if (prior.some((x) => x.timestamp >= anchor.timestamp - 7 * DAY)) {
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
    if (ambiguous) counts.ambiguous++
    else if (pending) counts.pending++
    else {
      counts.clean++
      const age = anchor.timestamp - candidate.timestamp
      if (age <= 0) throw new Error('Control creation is not pre-anchor')
      const distance = Math.abs(Math.log((age + DAY) / (treatedAge + DAY)))
      clean.push({
        vault,
        creationBlock: candidate.block,
        creationTimestamp: candidate.timestamp,
        ageSeconds: age,
        distance,
      })
    }
  }
  if (
    Object.values(counts)
      .slice(1)
      .reduce((a, b) => a + b, 0) !== counts.sameAssetPreAnchor
  )
    throw new Error('Control risk-set accounting mismatch')
  clean.sort((a, b) => a.distance - b.distance || a.vault.localeCompare(b.vault))
  return {
    counts,
    firstCleanCandidates: clean.slice(0, CONTROL_PAGE_SIZE).map(({ distance, ...row }) => row),
    nextCleanOffset: clean.length > CONTROL_PAGE_SIZE ? CONTROL_PAGE_SIZE : null,
  }
}

export function horizonStatus(executableAt, headTimestamp) {
  if (!Number.isSafeInteger(executableAt) || !Number.isSafeInteger(headTimestamp))
    throw new Error('Invalid horizon time')
  const plus24hTarget = executableAt + DAY
  const plus7dTarget = executableAt + 7 * DAY
  return {
    plus24h: {
      targetTimestamp: plus24hTarget,
      status: headTimestamp >= plus24hTarget ? 'available' : 'head-censored',
    },
    plus7d: {
      targetTimestamp: plus7dTarget,
      status: headTimestamp >= plus7dTarget ? 'available' : 'head-censored',
    },
  }
}

export function buildManifest({ sources, stage1, lifecycle, factory, head }) {
  const factoryByVault = new Map(factory.events.map((x) => [x.vault.toLowerCase(), x]))
  const priorByVault = new Map()
  for (const event of stage1.rawEvents) {
    const vault = event.vault.toLowerCase()
    if (!priorByVault.has(vault)) priorByVault.set(vault, [])
    priorByVault.get(vault).push(event)
  }
  const indexes = stage1.summary.independentEligibleProposalIndexes
  if (indexes.length !== 304 || new Set(indexes).size !== 304)
    throw new Error('Frozen cohort changed')
  const rows = []
  for (const proposalIndex of indexes) {
    const anchor = stage1.proposals[proposalIndex]
    if (!anchor || !Number.isSafeInteger(anchor.block) || !Number.isSafeInteger(anchor.timestamp))
      throw new Error('Invalid frozen proposal')
    const treatedCreation = factoryByVault.get(anchor.vault.toLowerCase())
    const legs = anchor.rawEventIndexes.flatMap((rawEventIndex, i) => {
      if (anchor.classes[i] !== 'eligible') return []
      const event = stage1.rawEvents[rawEventIndex]
      if (
        !event ||
        event.vault.toLowerCase() !== anchor.vault.toLowerCase() ||
        event.block !== anchor.block ||
        event.txHash.toLowerCase() !== anchor.txHash.toLowerCase() ||
        !CAP_SELECTORS.has(event.selector.toLowerCase()) ||
        event.executableAt !== anchor.executableAts[i]
      )
        throw new Error('Eligible cap leg identity mismatch')
      return [
        {
          rawEventIndex,
          selector: event.selector.toLowerCase(),
          txHash: event.txHash.toLowerCase(),
          logIndex: event.logIndex,
          dataSha256: sha(Buffer.from(event.data.slice(2), 'hex')),
          executableAt: Number(event.executableAt),
        },
      ]
    })
    if (
      !legs.length ||
      legs.length !== anchor.qualifyingLegCount ||
      legs.some((x) => !Number.isSafeInteger(x.executableAt))
    )
      throw new Error('Eligible leg count or clock mismatch')
    const earliestExecutableAt = Math.min(...legs.map((x) => x.executableAt))
    const state = replay(sources, lifecycle, anchor.block - 1).state
    const controls = controlRiskSet({
      factoryEvents: factory.events,
      priorByVault,
      state,
      anchor,
      treatedCreation,
    })
    rows.push({
      proposalIndex,
      vault: anchor.vault.toLowerCase(),
      asset: treatedCreation.asset.toLowerCase(),
      anchorBlock: anchor.block,
      anchorBlockHash: stage1.rawEvents[anchor.rawEventIndexes[0]].blockHash.toLowerCase(),
      anchorTimestamp: anchor.timestamp,
      anchorTxHash: anchor.txHash.toLowerCase(),
      eligibleLegs: legs,
      earliestExecutableAt,
      horizons: horizonStatus(earliestExecutableAt, head.timestamp),
      controls,
    })
  }
  const summary = {
    anchors: rows.length,
    uniqueVaults: new Set(rows.map((x) => x.vault)).size,
    plus24hAvailable: rows.filter((x) => x.horizons.plus24h.status === 'available').length,
    plus7dAvailable: rows.filter((x) => x.horizons.plus7d.status === 'available').length,
    noCleanControl: rows.filter((x) => x.controls.counts.clean === 0).length,
    sameAssetPreAnchorPairs: rows.reduce((n, x) => n + x.controls.counts.sameAssetPreAnchor, 0),
    recentSevenDayPairs: rows.reduce((n, x) => n + x.controls.counts.recentSevenDay, 0),
  }
  if (
    summary.anchors !== 304 ||
    summary.plus24hAvailable !== 297 ||
    summary.plus7dAvailable !== 286 ||
    summary.sameAssetPreAnchorPairs !== 55_017 ||
    summary.recentSevenDayPairs !== 2_655
  )
    throw new Error('Frozen denominator or horizon accounting changed')
  return seal({
    study: STUDY,
    status: 'complete',
    chainId: 1,
    factorySha256: FACTORY_SHA,
    submitSha256: SUBMIT_SHA,
    stage1Sha256: STAGE1_SHA,
    lifecycleSha256: LIFECYCLE_SHA,
    headSourceSha256: HEAD_SOURCE_SHA,
    pinnedHead: head,
    controlOrder:
      'same-asset/pre-anchor factory; exclude prior-7d Submit unconditionally; exclude full-key pending/ambiguous at B-1; ascending abs(log((candidateAgeSeconds+86400)/(treatedAgeSeconds+86400))), address ascending; offset is rank among clean candidates',
    controlPageSize: CONTROL_PAGE_SIZE,
    summary,
    rows,
  })
}

export function paths() {
  const base = 'data/research/venue-signals/'
  return {
    factoryPath: resolve(`${base}${FACTORY_SHA}.json`),
    submitPath: resolve(`${base}${SUBMIT_SHA}.json`),
    stage1Path: resolve(`${base}${STAGE1_SHA}.json`),
    lifecyclePath: resolve(`${base}morpho-v2-cap-lifecycle-census.json`),
    headPath: resolve(`${base}morpho-v2-cap-route-overlap.json`),
    out: resolve(`${base}morpho-v2-full-cohort-manifest.json`),
  }
}

export function load(p = paths()) {
  const inputs = readInputs(p)
  const factory = JSON.parse(readFileSync(p.factoryPath, 'utf8')) // readInputs SHA-pins this file.
  const head = readHead(readFileSync(p.headPath))
  if (
    factory.events.length !== 757 ||
    !factory.events.every((x) => ADDRESS.test(x.vault.toLowerCase()))
  )
    throw new Error('Invalid frozen factory')
  return { ...inputs, factory, head }
}

export function verify(saved, inputs) {
  const expected = buildManifest(inputs)
  if (
    !SHA.test(saved?.checkpointSha256 || '') ||
    JSON.stringify(saved) !== JSON.stringify(expected)
  )
    throw new Error('Manifest content or seal mismatch')
  return saved
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const arg =
      process.argv.length === 2
        ? 'dry'
        : process.argv.length === 4 && process.argv[3] === 'true'
          ? process.argv[2]
          : null
    if (!['dry', '--run', '--verify'].includes(arg)) throw new Error('Invalid arguments')
    const p = paths(),
      inputs = load(p)
    const result = buildManifest(inputs)
    const bytes = JSON.stringify(result)
    if (Buffer.byteLength(bytes) > MAX_OUTPUT_BYTES) throw new Error('Manifest output cap reached')
    if (arg === '--verify') {
      const savedBytes = readFileSync(p.out)
      verify(JSON.parse(savedBytes), inputs)
      process.stdout.write(
        JSON.stringify({ summary: result.summary, sha256: sha(savedBytes) }) + '\n',
      )
    } else if (arg === '--run') {
      if (existsSync(p.out)) throw new Error('Existing manifest; use --verify true')
      const disk = statfsSync(dirname(p.out))
      if (Number(disk.bavail) * Number(disk.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
        throw new Error('Disk reserve reached')
      mkdirSync(dirname(p.out), { recursive: true })
      const temp = `${p.out}.${process.pid}.tmp`
      writeFileSync(temp, bytes, { mode: 0o600 })
      renameSync(temp, p.out)
      process.stdout.write(
        JSON.stringify({ summary: result.summary, sha256: sha(readFileSync(p.out)) }) + '\n',
      )
    } else
      process.stdout.write(
        JSON.stringify({
          summary: result.summary,
          bytes: Buffer.byteLength(bytes),
          output: p.out,
        }) + '\n',
      )
  } catch {
    process.stderr.write(
      'Full-cohort manifest stopped; frozen source or resource validation failed.\n',
    )
    process.exitCode = 1
  }
}
