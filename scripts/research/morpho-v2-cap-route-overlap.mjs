// Offline paired description of cap Submit anchors and same-vault adapter-address changes.
// A temporal overlap is neither a causal attribution nor a predictive backtest.
// node scripts/research/morpho-v2-cap-route-overlap.mjs
// node scripts/research/morpho-v2-cap-route-overlap.mjs --verify true
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STUDY = 'morpho-v2-cap-route-overlap-v1'
export const STAGE1_SHA = '28b4c9737df8e97f76f71ee5dc8c41d771bbd9bdcbcba01a113837ab29fa8ae9'
export const HEADERS_SHA = '66595ce99bb86c86ddf38c8063c8f178bfbc4497043d61dab68762ab14deb4f6'
export const FACTORY_SHA = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
export const HEAD_BLOCK = 26_052_740
export const HEAD_TIME = 1_790_318_495
export const HEAD_HASH = '0xf43d7e3b07870c3eef167f2681d6132a337c1c5eefc4a5223e4fdfd4843ad756'
export const WINDOWS = [86_400, 259_200, 604_800]
const HASH = /^0x[0-9a-f]{64}$/
const sha = (data) => createHash('sha256').update(data).digest('hex')
const fail = (message) => { throw new Error(message) }
const id = (change) => `${change.block}:${change.transactionIndex}:${change.logIndex}`
const sortedUnique = (values) => [...new Set(values)].sort((a, b) => a - b)
const checkpointCore = ({ checkpointSha256, ...core }) => core

export function readPinned(path, expectedSha) {
  const bytes = readFileSync(path)
  if (sha(bytes) !== expectedSha) fail(`Pinned input SHA mismatch: ${path}`)
  return JSON.parse(bytes)
}

export function windowMembership(eventTime, anchorTime, seconds) {
  if (eventTime >= anchorTime - seconds && eventTime < anchorTime) return 'pre'
  if (eventTime > anchorTime && eventTime <= anchorTime + seconds) return 'post'
  return 'outside'
}

export function validateInputs(stage, route, factory) {
  if (stage?.chainId !== 1 || stage.status !== 'complete' ||
      stage.factoryArtifactSha256 !== FACTORY_SHA || stage.to !== HEAD_BLOCK ||
      stage.pinnedHeadHash !== HEAD_HASH || !Array.isArray(stage.proposals) ||
      stage.summary?.independentEligibleCount !== 304 ||
      !Array.isArray(stage.summary.independentEligibleProposalIndexes) ||
      stage.summary.independentEligibleProposalIndexes.length !== 304)
    fail('Stage-1 cohort, pinned head, or independence gate mismatch')
  const indexes = stage.summary.independentEligibleProposalIndexes
  if (new Set(indexes).size !== 304 || indexes.some((i) =>
    !Number.isSafeInteger(i) || i < 0 || i >= stage.proposals.length ||
    !['eligible', 'mixed-eligible'].includes(stage.proposals[i].class) ||
    stage.proposals[i].qualifyingLegCount < 1))
    fail('Invalid independent eligible proposal indexes')
  if (factory?.status !== 'complete' || factory.to !== HEAD_BLOCK ||
      factory.summary?.uniqueVaultCount !== 757 || !Array.isArray(factory.events) ||
      factory.events.length !== 757)
    fail('Factory cohort mismatch')
  const creation = new Map()
  for (const event of factory.events) {
    const vault = event.vault?.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(vault || '') || creation.has(vault) ||
        !Number.isSafeInteger(event.timestamp) || event.timestamp > HEAD_TIME ||
        !Number.isSafeInteger(event.block) || event.block > HEAD_BLOCK)
      fail('Invalid factory creation')
    creation.set(vault, event.timestamp)
  }
  for (const index of indexes) {
    const anchor = stage.proposals[index]
    const created = creation.get(anchor.vault?.toLowerCase())
    if (created === undefined || !Number.isSafeInteger(anchor.timestamp) ||
        anchor.timestamp < created || anchor.timestamp > HEAD_TIME ||
        !Number.isSafeInteger(anchor.block) || anchor.block > HEAD_BLOCK)
      fail('Proposal outside factory/head history')
  }
  if (route?.chainId !== 1 || route.status !== 'complete' ||
      route.routeArtifactSha256 !== '45a7182cc2c5d38616ea066522789840559242e5758958f49a228e718fbcd786' ||
      !Array.isArray(route.changes) || !Array.isArray(route.headers) ||
      route.changes.length !== 275 || route.nextHeader !== route.headers.length ||
      route.blocks?.length !== route.headers.length ||
      sha(JSON.stringify(checkpointCore(route))) !== route.checkpointSha256)
    fail('Route-address header checkpoint mismatch')
  const byBlock = new Map()
  let previousTime = -1
  for (let i = 0; i < route.headers.length; i++) {
    const header = route.headers[i]
    if (header.block !== route.blocks[i] || !HASH.test(header.hash) ||
        !Number.isSafeInteger(header.timestamp) || header.timestamp < previousTime ||
        header.timestamp > HEAD_TIME) fail('Invalid route header order')
    byBlock.set(header.block, header)
    previousTime = header.timestamp
  }
  const changes = []
  for (const change of route.changes) {
    const header = byBlock.get(change.block)
    const created = creation.get(change.vault?.toLowerCase())
    if (!header || header.hash !== change.blockHash || created === undefined ||
        header.timestamp < created || change.block > HEAD_BLOCK ||
        change.fromAdapter === change.toAdapter ||
        !Number.isSafeInteger(change.transactionIndex) ||
        !Number.isSafeInteger(change.logIndex)) fail('Invalid route-address transition')
    changes.push({ ...change, timestamp: header.timestamp })
  }
  return { indexes, creation, changes }
}

function concentration(rows, side) {
  const vaults = new Map()
  for (const row of rows) {
    const hit = row[side]
    if (!hit.length) continue
    const value = vaults.get(row.vault) || { vault: row.vault, anchorHits: 0, transitionPairs: 0 }
    value.anchorHits++
    value.transitionPairs += hit.length
    vaults.set(row.vault, value)
  }
  const ranked = [...vaults.values()].sort((a, b) => b.transitionPairs - a.transitionPairs ||
    b.anchorHits - a.anchorHits || a.vault.localeCompare(b.vault))
  return { uniqueHitVaults: ranked.length, topVaults: ranked.slice(0, 10),
    maxVaultTransitionShare: ranked.length
      ? ranked[0].transitionPairs / ranked.reduce((sum, v) => sum + v.transitionPairs, 0)
      : 0 }
}

export function compare(stage, route, factory) {
  const { indexes, creation, changes } = validateInputs(stage, route, factory)
  const byVault = new Map()
  for (const change of changes) {
    const key = change.vault.toLowerCase()
    const list = byVault.get(key) || []
    list.push(change)
    byVault.set(key, list)
  }
  const windows = WINDOWS.map((seconds) => {
    const rows = [], missing = { preCrossesFactoryCreation: [], postCrossesPinnedHead: [] }
    for (const proposalIndex of indexes) {
      const proposal = stage.proposals[proposalIndex]
      const vault = proposal.vault.toLowerCase(), anchorTime = proposal.timestamp
      const preCrossesFactory = anchorTime - seconds < creation.get(vault)
      const postCrossesHead = anchorTime + seconds > HEAD_TIME
      if (preCrossesFactory) missing.preCrossesFactoryCreation.push(proposalIndex)
      if (postCrossesHead) missing.postCrossesPinnedHead.push(proposalIndex)
      if (preCrossesFactory || postCrossesHead) continue
      const events = byVault.get(vault) || []
      const pre = events.filter((x) => windowMembership(x.timestamp, anchorTime, seconds) === 'pre')
      const post = events.filter((x) => windowMembership(x.timestamp, anchorTime, seconds) === 'post')
      rows.push({ proposalIndex, vault, anchorTime,
        pre: pre.map(id), post: post.map(id) })
    }
    const both = rows.filter((x) => x.pre.length && x.post.length).length
    const postOnly = rows.filter((x) => !x.pre.length && x.post.length).length
    const preOnly = rows.filter((x) => x.pre.length && !x.post.length).length
    const neither = rows.length - both - postOnly - preOnly
    const preTransitionPairs = rows.reduce((n, x) => n + x.pre.length, 0)
    const postTransitionPairs = rows.reduce((n, x) => n + x.post.length, 0)
    return { seconds, eligibleAnchors: indexes.length, completePairedAnchors: rows.length,
      missing: Object.fromEntries(Object.entries(missing).map(([key, values]) =>
        [key, sortedUnique(values)])),
      both, postOnly, preOnly, neither,
      preAnchorHits: both + preOnly, postAnchorHits: both + postOnly,
      preTransitionPairs, postTransitionPairs,
      preConcentration: concentration(rows, 'pre'), postConcentration: concentration(rows, 'post'),
      rows }
  })
  return { study: STUDY, chainId: 1, sourceSha256: {
    stage1: STAGE1_SHA, routeAddressHeaders: HEADERS_SHA, factory: FACTORY_SHA },
    pinnedHead: { block: HEAD_BLOCK, hash: HEAD_HASH, timestamp: HEAD_TIME },
    interpretation: 'Same-vault temporal overlap only; neither predictive nor causal evidence.',
    windowRule: 'pre [-T,0), post (0,T]; exclude anchor unless both full windows observed',
    windows }
}

export function seal(result) {
  const { artifactSha256, ...core } = result
  return { ...core, artifactSha256: sha(JSON.stringify(core)) }
}

export function verify(result, stage, route, factory) {
  const expected = seal(compare(stage, route, factory))
  if (JSON.stringify(result) !== JSON.stringify(expected)) fail('Overlap artifact mismatch')
  return result
}

function atomic(path, output) {
  mkdirSync(dirname(path), { recursive: true })
  const bytes = JSON.stringify(output)
  const disk = statfsSync(dirname(path))
  if (Number(disk.bavail) * Number(disk.bsize) - Buffer.byteLength(bytes) < 2_500_000_000)
    fail('Disk reserve reached')
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, bytes, { mode: 0o600 })
  renameSync(temp, path)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length % 2 || args.some((x, i) => i % 2 === 0 && !x.startsWith('--')))
    fail('Expected --key value arguments')
  const opts = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) =>
    [args[2 * i].slice(2), args[2 * i + 1]]))
  const stage = readPinned(resolve(opts.stage || 'data/research/venue-signals/morpho-v2-cap-submit-stage1.json'), STAGE1_SHA)
  const route = readPinned(resolve(opts.route || 'data/research/venue-signals/morpho-v2-route-address-headers.json'), HEADERS_SHA)
  const factory = readPinned(resolve(opts.factory || 'data/research/venue-signals/morpho-v2-factory-census.json'), FACTORY_SHA)
  const out = resolve(opts.out || 'data/research/venue-signals/morpho-v2-cap-route-overlap.json')
  const result = opts.verify === 'true' ? verify(JSON.parse(readFileSync(out, 'utf8')), stage, route, factory)
    : seal(compare(stage, route, factory))
  if (opts.verify !== 'true') atomic(out, result)
  process.stdout.write(JSON.stringify({ path: out, artifactSha256: result.artifactSha256,
    windows: result.windows.map((w) => ({ seconds: w.seconds, n: w.completePairedAnchors,
      postAnchorHits: w.postAnchorHits, preAnchorHits: w.preAnchorHits,
      postTransitionPairs: w.postTransitionPairs, preTransitionPairs: w.preTransitionPairs })) }) + '\n')
}
