// Durable, read-only research inputs. No RPC or database access.
// node scripts/research/local-artifacts.mjs import --name scrvusd-120d --source /private/tmp/samples.json
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  closeSync,
} from 'node:fs'

export const DEFAULT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/research/venue-signals',
)
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const HASH = /^[a-f0-9]{64}$/
const SOURCE_BASENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json(?:\.gz)?$/

function assertNoSymlinks(path) {
  // macOS exposes /var and /tmp as system aliases under /private.
  const expanded =
    path === '/var' || path.startsWith('/var/')
      ? `/private${path}`
      : path === '/tmp' || path.startsWith('/tmp/')
        ? `/private${path}`
        : path
  let part = resolve(expanded)
  const paths = []
  while (part !== dirname(part)) {
    paths.push(part)
    part = dirname(part)
  }
  for (const candidate of paths.reverse()) {
    try {
      if (lstatSync(candidate).isSymbolicLink())
        throw new Error(`Symlink path refused: ${candidate}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

function storageRoot(root) {
  const path = resolve(root)
  assertNoSymlinks(path)
  mkdirSync(path, { recursive: true })
  assertNoSymlinks(path)
  return path
}

function validatedName(name) {
  if (typeof name !== 'string' || !NAME.test(name))
    throw new Error('Name must be lowercase letters, digits and hyphens (1–64 characters)')
  return name
}

function manifestPath(root) {
  return join(root, 'manifest.json')
}
function readManifest(root) {
  const path = manifestPath(root)
  if (!existsSync(path)) return { version: 1, artifacts: {} }
  assertNoSymlinks(path)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (
    manifest?.version !== 1 ||
    !manifest.artifacts ||
    Array.isArray(manifest.artifacts) ||
    typeof manifest.artifacts !== 'object'
  )
    throw new Error('Malformed artifact manifest')
  for (const [name, item] of Object.entries(manifest.artifacts)) {
    validatedName(name)
    if (
      !HASH.test(item?.sha256) ||
      ![`${item.sha256}.json`, `${item.sha256}.json.gz`].includes(item.file) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1
    )
      throw new Error(`Malformed manifest entry: ${name}`)
  }
  return manifest
}

function atomicWrite(path, bytes) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  let created = false
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    created = true
    renameSync(temp, path)
  } finally {
    if (created && existsSync(temp)) unlinkSync(temp)
  }
}

export function inspectArtifact(bytes, compressed = false) {
  let data
  try {
    // Limit expansion before JSON parsing so a corrupt gzip cannot exhaust memory.
    const decoded = compressed ? gunzipSync(bytes, { maxOutputLength: 350_000_000 }) : bytes
    data = JSON.parse(decoded.toString('utf8'))
  } catch {
    throw new Error('Source is not valid JSON')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Unsupported or malformed research artifact')
  let rows, kind, study, rowCheck
  if (data.study === 'morpho-v2-cap-submit-stage1-v1') {
    const rawSha = '00ecf6280cf2b6cca5adf595fb823d3178d82b127d6a2535702dbb9032adcdb4'
    const factorySha = '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa'
    const from = 23_375_073
    const to = 26_052_740
    const chunks = Math.ceil((to - from + 1) / 8_000)
    const hash = /^0x[a-fA-F0-9]{64}$/
    if (
      compressed ||
      data.status !== 'complete' ||
      data.chainId !== 1 ||
      data.factoryArtifactSha256 !== factorySha ||
      data.rawArtifactSha256 !== rawSha ||
      !hash.test(data.pinnedHeadHash) ||
      data.from !== from ||
      data.to !== to ||
      data.chunkBlocks !== 8_000 ||
      data.nextChunk !== chunks ||
      data.coverage?.fromBlock !== from ||
      data.coverage?.throughBlock !== to ||
      data.coverage?.chunksComplete !== chunks ||
      data.coverage?.chunksExpected !== chunks ||
      data.coverage?.complete !== true ||
      !Array.isArray(data.rawEvents) ||
      !Array.isArray(data.classifications) ||
      data.nextEvent !== data.rawEvents.length ||
      data.classifications.length !== data.rawEvents.length ||
      !Array.isArray(data.proposals) ||
      !data.summary
    )
      throw new Error('Malformed Morpho V2 cap Stage 1 artifact')
    const selectorCounts = { absolute: 0, relative: 0 }
    const vaults = new Set()
    for (const event of data.rawEvents) {
      vaults.add(event.vault.toLowerCase())
      if (event.selector === '0xf6f98fd5') selectorCounts.absolute++
      else if (event.selector === '0x2438525b') selectorCounts.relative++
      else throw new Error('Malformed Morpho V2 cap selector')
    }
    const rawSnapshot = {
      study: 'morpho-v2-cap-submit-raw-v1',
      chainId: 1,
      factoryArtifactSha256: factorySha,
      pinnedHeadHash: data.pinnedHeadHash,
      from,
      to,
      chunkBlocks: 8_000,
      topic0: data.topic0,
      selectorTopics: data.selectorTopics,
      coverage: data.coverage,
      rawEvents: data.rawEvents,
      summary: {
        rawSubmitCount: data.rawEvents.length,
        selectorCounts,
        uniqueVaultCount: vaults.size,
      },
    }
    if (createHash('sha256').update(JSON.stringify(rawSnapshot)).digest('hex') !== rawSha)
      throw new Error('Morpho V2 Stage 1 raw source hash mismatch')
    const classes = new Set([
      'short-lead',
      'eligible',
      'ambiguous',
      'unfunded',
      'non-increasing',
      'malformed',
      'abdicated',
    ])
    const classCounts = {}
    for (const row of data.classifications) {
      if (!classes.has(row?.class) || typeof row.reason !== 'string')
        throw new Error('Malformed Morpho V2 cap classification')
      classCounts[row.class] = (classCounts[row.class] || 0) + 1
      if (
        row.class === 'eligible' &&
        (!['absolute', 'relative'].includes(row.kind) ||
          !hash.test(row.allocationId) ||
          !Number.isSafeInteger(row.leadSeconds) ||
          row.leadSeconds < 21_600 ||
          row.preState?.abdicated !== false ||
          !/^\d+$/.test(row.preState?.oldCap) ||
          !/^\d+$/.test(row.preState?.supplyAtSubmit) ||
          BigInt(row.preState.supplyAtSubmit) <= 0n ||
          !/^\d+$/.test(row.proposedCap) ||
          BigInt(row.proposedCap) <= BigInt(row.preState.oldCap))
      )
        throw new Error('Ineligible Morpho V2 cap leg labeled eligible')
    }
    const covered = new Set()
    const proposalClassCounts = {}
    const eligible = []
    for (let p = 0; p < data.proposals.length; p++) {
      const proposal = data.proposals[p]
      if (!Array.isArray(proposal?.rawEventIndexes) || !proposal.rawEventIndexes.length)
        throw new Error('Malformed Morpho V2 cap proposal')
      const legs = proposal.rawEventIndexes.map((index) => {
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= data.rawEvents.length ||
          covered.has(index)
        )
          throw new Error('Duplicate or invalid Morpho V2 proposal leg')
        covered.add(index)
        const event = data.rawEvents[index]
        if (
          event.vault.toLowerCase() !== proposal.vault.toLowerCase() ||
          event.txHash.toLowerCase() !== proposal.txHash.toLowerCase()
        )
          throw new Error('Morpho V2 proposal/event mismatch')
        return data.classifications[index]
      })
      const qualifying = legs.filter((leg) => leg.class === 'eligible').length
      const expectedClass =
        qualifying === legs.length ? 'eligible' : qualifying > 0 ? 'mixed-eligible' : legs[0].class
      if (
        proposal.qualifyingLegCount !== qualifying ||
        proposal.class !== expectedClass ||
        proposal.timestamp !== data.rawEvents[proposal.rawEventIndexes[0]].timestamp ||
        proposal.block !== data.rawEvents[proposal.rawEventIndexes[0]].block ||
        JSON.stringify(proposal.classes) !== JSON.stringify(legs.map((leg) => leg.class)) ||
        JSON.stringify(proposal.executableAts) !==
          JSON.stringify(
            proposal.rawEventIndexes.map((index) => data.rawEvents[index].executableAt),
          ) ||
        JSON.stringify(proposal.leadSeconds) !==
          JSON.stringify(legs.map((leg) => leg.leadSeconds ?? null)) ||
        (proposal.allocationId !== null &&
          legs.some((leg) => leg.allocationId !== proposal.allocationId))
      )
        throw new Error('Morpho V2 proposal classification mismatch')
      proposalClassCounts[proposal.class] = (proposalClassCounts[proposal.class] || 0) + 1
      if (qualifying > 0)
        eligible.push({
          index: p,
          vault: proposal.vault.toLowerCase(),
          timestamp: proposal.timestamp,
        })
    }
    if (covered.size !== data.rawEvents.length)
      throw new Error('Morpho V2 ungrouped cap submission')
    eligible.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index)
    const lastAnchor = new Map()
    const independent = []
    for (const proposal of eligible) {
      const prior = lastAnchor.get(proposal.vault)
      if (prior === undefined || proposal.timestamp - prior > 604_800) {
        lastAnchor.set(proposal.vault, proposal.timestamp)
        independent.push(proposal.index)
      }
    }
    const totals = data.summary
    if (
      totals.rawSubmitCount !== data.rawEvents.length ||
      totals.classifiedCount !== data.classifications.length ||
      totals.proposalCount !== data.proposals.length ||
      JSON.stringify(totals.classCounts) !== JSON.stringify(classCounts) ||
      JSON.stringify(totals.proposalClassCounts) !== JSON.stringify(proposalClassCounts) ||
      totals.eligibleProposalCount !== eligible.length ||
      JSON.stringify(totals.eligibleDates) !==
        JSON.stringify(
          eligible.map((proposal) =>
            new Date(proposal.timestamp * 1000).toISOString().slice(0, 10),
          ),
        ) ||
      totals.independentEligibleCount !== independent.length ||
      JSON.stringify(totals.independentEligibleProposalIndexes) !== JSON.stringify(independent) ||
      JSON.stringify(totals.independentEligibleDates) !==
        JSON.stringify(
          independent.map((index) =>
            new Date(data.proposals[index].timestamp * 1000).toISOString().slice(0, 10),
          ),
        ) ||
      totals.independenceWindowSeconds !== 604_800 ||
      totals.preregisteredMinimum !== 20 ||
      totals.followThroughPermitted !== independent.length >= 20
    )
      throw new Error('Morpho V2 Stage 1 summary mismatch')
    return {
      kind: 'morpho-v2-cap-submit-stage1',
      study: data.study,
      count: data.rawEvents.length,
      firstBlock: data.rawEvents[0].block,
      lastBlock: data.rawEvents.at(-1).block,
      firstTimestamp: data.rawEvents[0].timestamp,
      lastTimestamp: data.rawEvents.at(-1).timestamp,
    }
  }
  if (data.study === 'morpho-v2-cap-submit-raw-v1') {
    const from = 23_375_073
    const to = 26_052_740
    const expectedChunks = Math.ceil((to - from + 1) / 8_000)
    const address = /^0x[a-fA-F0-9]{40}$/
    const hash = /^0x[a-fA-F0-9]{64}$/
    const hex = /^0x(?:[a-fA-F0-9]{2})*$/
    const absolute = '0xf6f98fd5'
    const relative = '0x2438525b'
    const topic0 = '0x8b18afeb361b83b025999ed5b42f1d90c68aaa5a0fd49c015f04c3b8b81e80eb'
    if (
      compressed ||
      data.chainId !== 1 ||
      data.factoryArtifactSha256 !==
        '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa' ||
      !hash.test(data.pinnedHeadHash) ||
      data.from !== from ||
      data.to !== to ||
      data.chunkBlocks !== 8_000 ||
      data.topic0 !== topic0 ||
      JSON.stringify(data.selectorTopics) !==
        JSON.stringify(
          [absolute, relative].map((selector) => `0x${selector.slice(2).padEnd(64, '0')}`),
        ) ||
      data.coverage?.fromBlock !== from ||
      data.coverage?.throughBlock !== to ||
      data.coverage?.chunksComplete !== expectedChunks ||
      data.coverage?.chunksExpected !== expectedChunks ||
      data.coverage?.complete !== true ||
      !Array.isArray(data.rawEvents) ||
      data.rawEvents.length === 0 ||
      data.summary?.rawSubmitCount !== data.rawEvents.length
    )
      throw new Error('Malformed Morpho V2 raw cap Submit census')
    let previousBlock = -1
    let previousIndex = -1
    let previousTimestamp = -1
    const vaults = new Set()
    let absoluteCount = 0
    let relativeCount = 0
    for (const event of data.rawEvents) {
      if (
        !address.test(event?.vault) ||
        !hash.test(event.blockHash) ||
        !hash.test(event.txHash) ||
        !Number.isSafeInteger(event.block) ||
        event.block < from ||
        event.block > to ||
        !Number.isSafeInteger(event.transactionIndex) ||
        event.transactionIndex < 0 ||
        !Number.isSafeInteger(event.logIndex) ||
        event.logIndex < 0 ||
        !Number.isSafeInteger(event.timestamp) ||
        event.timestamp < previousTimestamp ||
        !hex.test(event.data) ||
        ![absolute, relative].includes(event.selector) ||
        !/^\d+$/.test(event.executableAt) ||
        event.block < previousBlock ||
        (event.block === previousBlock && event.logIndex <= previousIndex)
      )
        throw new Error('Malformed or unordered Morpho V2 raw cap Submit event')
      vaults.add(event.vault.toLowerCase())
      if (event.selector === absolute) absoluteCount++
      else relativeCount++
      previousBlock = event.block
      previousIndex = event.logIndex
      previousTimestamp = event.timestamp
    }
    if (
      data.summary.selectorCounts?.absolute !== absoluteCount ||
      data.summary.selectorCounts?.relative !== relativeCount ||
      data.summary.uniqueVaultCount !== vaults.size
    )
      throw new Error('Morpho V2 raw cap Submit summary mismatch')
    return {
      kind: 'morpho-v2-cap-submit-raw',
      study: data.study,
      count: data.rawEvents.length,
      firstBlock: data.rawEvents[0].block,
      lastBlock: data.rawEvents.at(-1).block,
      firstTimestamp: data.rawEvents[0].timestamp,
      lastTimestamp: previousTimestamp,
    }
  }
  if (data.study === 'morpho-v2-factory-create-v1') {
    const from = 23_375_073
    const to = 26_052_740
    const expectedChunks = Math.ceil((to - from + 1) / 10_000)
    const address = /^0x[a-fA-F0-9]{40}$/
    const hash = /^0x[a-fA-F0-9]{64}$/
    if (
      compressed ||
      data.status !== 'complete' ||
      data.factory?.toLowerCase() !== '0xa1d94f746defa1928926b84fb2596c06926c0405' ||
      data.topic0?.toLowerCase() !==
        '0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e' ||
      data.from !== from ||
      data.to !== to ||
      data.chunkBlocks !== 10_000 ||
      data.nextChunk !== expectedChunks ||
      data.coverage?.fromBlock !== from ||
      data.coverage?.throughBlock !== to ||
      data.coverage?.chunksComplete !== expectedChunks ||
      data.coverage?.chunksExpected !== expectedChunks ||
      !Array.isArray(data.events) ||
      data.events.length === 0 ||
      data.summary?.eventCount !== data.events.length ||
      data.summary?.uniqueVaultCount !== data.events.length ||
      data.summary?.duplicateVaultCount !== 0 ||
      data.summary?.containsSkyVault !== true
    )
      throw new Error('Malformed Morpho V2 factory census')
    const seen = new Set()
    let previousBlock = -1
    let previousLog = -1
    let previousTimestamp = -1
    for (const event of data.events) {
      if (
        !Number.isSafeInteger(event?.block) ||
        event.block < from ||
        event.block > to ||
        !hash.test(event.blockHash) ||
        !hash.test(event.txHash) ||
        !Number.isSafeInteger(event.transactionIndex) ||
        event.transactionIndex < 0 ||
        !Number.isSafeInteger(event.logIndex) ||
        event.logIndex < 0 ||
        !Number.isSafeInteger(event.timestamp) ||
        event.timestamp < previousTimestamp ||
        !address.test(event.owner) ||
        !address.test(event.asset) ||
        !address.test(event.vault) ||
        !hash.test(event.salt) ||
        event.block < previousBlock ||
        (event.block === previousBlock && event.logIndex <= previousLog) ||
        seen.has(event.vault.toLowerCase())
      )
        throw new Error('Malformed or duplicate Morpho V2 factory event')
      seen.add(event.vault.toLowerCase())
      previousBlock = event.block
      previousLog = event.logIndex
      previousTimestamp = event.timestamp
    }
    if (!seen.has('0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11'))
      throw new Error('Morpho V2 factory census missing known vault')
    return {
      kind: 'morpho-v2-factory-create',
      study: data.study,
      count: data.events.length,
      firstBlock: data.events[0].block,
      lastBlock: data.events.at(-1).block,
      firstTimestamp: data.events[0].timestamp,
      lastTimestamp: previousTimestamp,
    }
  }
  if (compressed) {
    if (
      data.study !== 'scrvUSD raw Curve TokenExchange logs' ||
      data.chainId !== 1 ||
      !Number.isSafeInteger(data.fromBlock) ||
      !Number.isSafeInteger(data.toBlock) ||
      data.fromBlock < 0 ||
      data.toBlock < data.fromBlock ||
      !Array.isArray(data.poolAddresses) ||
      data.poolAddresses.length !== 2 ||
      !data.poolAddresses.every((address) => /^0x[a-fA-F0-9]{40}$/.test(address)) ||
      !Array.isArray(data.swaps) ||
      data.swaps.length === 0 ||
      data.decodedSwaps !== data.swaps.length
    )
      throw new Error('Unsupported or malformed compressed swap artifact')
    let prevBlock = -1,
      prevIndex = -1
    for (const swap of data.swaps) {
      if (
        !Number.isSafeInteger(swap?.block) ||
        swap.block < data.fromBlock ||
        swap.block > data.toBlock ||
        !Number.isSafeInteger(swap.logIndex) ||
        swap.logIndex < 0 ||
        swap.block < prevBlock ||
        (swap.block === prevBlock && swap.logIndex <= prevIndex) ||
        !data.poolAddresses.some((address) => address.toLowerCase() === swap.pool?.toLowerCase()) ||
        ![0, 1].includes(swap.soldId) ||
        ![0, 1].includes(swap.boughtId) ||
        swap.soldId === swap.boughtId ||
        !/^\d+$/.test(swap.tokensSold) ||
        !/^\d+$/.test(swap.tokensBought) ||
        !Number.isFinite(swap.netCrvUsd)
      )
        throw new Error('Malformed or nonmonotonic swap row')
      prevBlock = swap.block
      prevIndex = swap.logIndex
    }
    return {
      kind: 'curve-token-exchange-swaps',
      study: data.study,
      count: data.swaps.length,
      firstBlock: data.fromBlock,
      lastBlock: data.toBlock,
    }
  }
  if (data.study === 'Curve crvUSD exit-pool RampA/StopRampA census') {
    const addresses = [
      '0x390f3595bca2df7d23783dfd126427cceb997bf4',
      '0x4dece678ceceb27446b35c672dc7d61f30bad69e',
    ]
    const isFull = data.from === 23_178_731 && data.to === 26_051_931
    const isControl = data.from === 22_200_000 && data.to === 22_600_000
    const expectedChunks = Math.ceil((data.to - data.from + 1) / 8_000)
    if (
      data.status !== 'complete' ||
      (!isFull && !isControl) ||
      data.chunkBlocks !== 8_000 ||
      data.nextChunk !== expectedChunks ||
      !Array.isArray(data.pools) ||
      data.pools.length !== 2 ||
      !data.pools.every(
        (pool, i) =>
          pool?.address?.toLowerCase() === addresses[i] &&
          typeof pool.name === 'string' &&
          pool.name.length > 0,
      ) ||
      !Array.isArray(data.source) ||
      data.source.length !== 2 ||
      !data.source.every(
        (url, i) => url === `https://etherscan.io/address/${data.pools[i].address}#code`,
      ) ||
      !Array.isArray(data.events) ||
      (isFull && data.events.length !== 0) ||
      (isControl && data.events.length !== 2) ||
      data.summary?.total !== data.events.length ||
      !data.summary?.byPool ||
      Object.keys(data.summary.byPool).length !== 2
    )
      throw new Error('Malformed Curve A-ramp census')
    const counts = Object.fromEntries(
      addresses.map((address) => [address, { RampA: 0, StopRampA: 0 }]),
    )
    let previousBlock = -1
    let previousLogIndex = -1
    let previousTimestamp = -1
    for (const event of data.events) {
      const pool = event?.pool?.toLowerCase()
      const args = event?.args
      if (
        !addresses.includes(pool) ||
        !['RampA', 'StopRampA'].includes(event.type) ||
        !Number.isSafeInteger(event.block) ||
        event.block < data.from ||
        event.block > data.to ||
        !Number.isSafeInteger(event.logIndex) ||
        event.logIndex < 0 ||
        !Number.isSafeInteger(event.timestamp) ||
        event.timestamp < previousTimestamp ||
        !/^0x[a-fA-F0-9]{64}$/.test(event.txHash) ||
        event.block < previousBlock ||
        (event.block === previousBlock && event.logIndex <= previousLogIndex) ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        (event.type === 'RampA' &&
          (Object.keys(args).sort().join(',') !== 'future_time,initial_time,new_A,old_A' ||
            !['old_A', 'new_A', 'initial_time', 'future_time'].every((key) =>
              /^\d+$/.test(args[key]),
            ) ||
            BigInt(args.initial_time) !== BigInt(event.timestamp) ||
            BigInt(args.future_time) <= BigInt(args.initial_time))) ||
        (event.type === 'StopRampA' &&
          (Object.keys(args).sort().join(',') !== 'A,t' ||
            !['A', 't'].every((key) => /^\d+$/.test(args[key])) ||
            BigInt(args.t) !== BigInt(event.timestamp)))
      )
        throw new Error('Malformed or nonmonotonic Curve A-ramp event')
      counts[pool][event.type]++
      previousBlock = event.block
      previousLogIndex = event.logIndex
      previousTimestamp = event.timestamp
    }
    for (let i = 0; i < addresses.length; i++) {
      const byPool = data.summary.byPool[data.pools[i].address]
      if (
        !byPool ||
        Object.keys(byPool).sort().join(',') !== 'RampA,StopRampA' ||
        byPool.RampA !== counts[addresses[i]].RampA ||
        byPool.StopRampA !== counts[addresses[i]].StopRampA
      )
        throw new Error('Curve A-ramp summary mismatch')
    }
    if (
      isControl &&
      (data.events.some(
        (event, i) =>
          event.type !== 'RampA' ||
          event.pool.toLowerCase() !== addresses[i] ||
          event.block !== 22_393_005 ||
          event.txHash.toLowerCase() !==
            '0x45c7034b910949a868db843f7257bfb6bef20487fd07ec7c3f1de840f33d6639',
      ) ||
        data.events[0].timestamp !== data.events[1].timestamp)
    )
      throw new Error('Curve A-ramp positive control mismatch')
    return {
      kind: isFull ? 'curve-ramp-events-400d' : 'curve-ramp-positive-control',
      study: data.study,
      count: data.events.length,
      firstBlock: data.from,
      lastBlock: data.to,
    }
  }
  if (data.study === 'Aave V3 Ethereum cross-reserve configuration event census') {
    if (
      data.status !== 'complete' ||
      !/^0x[a-fA-F0-9]{40}$/.test(data.configurator) ||
      !Number.isSafeInteger(data.from) ||
      !Number.isSafeInteger(data.to) ||
      !Array.isArray(data.events) ||
      data.events.length === 0 ||
      data.events.length > 100_000
    )
      throw new Error('Malformed Aave configuration event census')
    let previousBlock = -1,
      previousIndex = -1,
      previousAt = -1
    for (const event of data.events) {
      if (
        !['ReserveFrozen', 'ReservePaused'].includes(event?.type) ||
        typeof event.enabled !== 'boolean' ||
        !/^0x[a-fA-F0-9]{40}$/.test(event.asset) ||
        !/^0x[a-fA-F0-9]{64}$/.test(event.txHash) ||
        !Number.isSafeInteger(event.block) ||
        event.block < data.from ||
        event.block > data.to ||
        !Number.isSafeInteger(event.at) ||
        event.at < previousAt ||
        !Number.isSafeInteger(event.logIndex) ||
        event.logIndex < 0 ||
        event.block < previousBlock ||
        (event.block === previousBlock && event.logIndex <= previousIndex)
      )
        throw new Error('Malformed or nonmonotonic Aave configuration event')
      previousBlock = event.block
      previousIndex = event.logIndex
      previousAt = event.at
    }
    return {
      kind: 'aave-config-events',
      study: data.study,
      count: data.events.length,
      firstBlock: data.events[0].block,
      lastBlock: previousBlock,
    }
  }
  if (data.status === 'complete' && data.census && data.incidents && data.summary) {
    if (
      data.prereg?.version !== 1 ||
      !Number.isSafeInteger(data.census.from) ||
      !Number.isSafeInteger(data.census.to) ||
      !Number.isSafeInteger(data.census.events) ||
      !Array.isArray(data.incidents) ||
      data.incidents.length === 0 ||
      data.incidents.length > 100_000 ||
      ![10000000, 50000000, 100000000].every(
        (q) =>
          Number.isSafeInteger(data.summary[q]?.eligibleEvents) &&
          Number.isSafeInteger(data.summary[q]?.eventCrossings),
      )
    )
      throw new Error('Malformed Aave freeze incident study')
    let previousBlock = -1,
      previousAt = -1
    for (const incident of data.incidents) {
      if (
        !Number.isSafeInteger(incident?.block) ||
        incident.block <= previousBlock ||
        !Number.isSafeInteger(incident.at) ||
        incident.at <= previousAt ||
        !Number.isFinite(incident.preCash) ||
        incident.preCash < 0 ||
        !Array.isArray(incident.events) ||
        incident.events.length === 0 ||
        !Array.isArray(incident.path) ||
        incident.path.length !== 7 ||
        !incident.path.every(
          (point, i) => point.hour === 6 + i * 3 && Number.isFinite(point.cash) && point.cash >= 0,
        ) ||
        ![10000000, 50000000, 100000000].every(
          (q) =>
            typeof incident.response?.[q]?.eligible === 'boolean' &&
            typeof incident.response?.[q]?.crossed === 'boolean',
        )
      )
        throw new Error('Malformed or nonmonotonic Aave freeze incident')
      previousBlock = incident.block
      previousAt = incident.at
    }
    return {
      kind: 'aave-freeze-incidents',
      study: 'Aave cross-reserve freeze/pause response',
      count: data.incidents.length,
      firstBlock: data.incidents[0].block,
      lastBlock: previousBlock,
    }
  }
  if (
    data.status === 'complete' &&
    data.exploratory === true &&
    data.rule ===
      'positive cross-reserve configuration incident then trailing 6h USDe cash drop > 14d pre-anchor p95 at +3h or +6h'
  ) {
    if (
      !Array.isArray(data.results) ||
      data.results.length === 0 ||
      data.results.length > 100_000 ||
      !data.results.every(
        (result) =>
          typeof result.label === 'string' &&
          Number.isSafeInteger(result.anchorAt) &&
          ['unavailable', '14d pre-anchor p95'].includes(result.baseline) &&
          Number.isSafeInteger(result.coverage?.rows) &&
          (result.baseline === 'unavailable' ||
            (Number.isFinite(result.p95) &&
              result.p95 >= 0 &&
              Array.isArray(result.checkpoints) &&
              result.checkpoints.length === 2 &&
              result.checkpoints.every((point) => typeof point.flagged === 'boolean'))),
      )
    )
      throw new Error('Malformed exploratory Aave two-stage study')
    return {
      kind: 'aave-freeze-cash-two-stage',
      study: data.rule,
      count: data.results.length,
      firstTimestamp: data.results[0].anchorAt,
      lastTimestamp: data.results.at(-1).anchorAt,
    }
  }
  if (data.study === 'Aave USDe dense pre-incident cash windows and matched controls') {
    if (
      data.status !== 'complete' ||
      data.collection?.version !== 1 ||
      data.collection?.targetCashUsd !== 100_000_000 ||
      data.collection?.expectedRowsPerWindow !== 115 ||
      !/^0x[a-fA-F0-9]{40}$/.test(data.provenance?.aToken) ||
      !/^0x[a-fA-F0-9]{40}$/.test(data.provenance?.underlying) ||
      !/^[a-f0-9]{64}$/.test(data.signature) ||
      !Array.isArray(data.windows) ||
      data.windows.length !== 6 ||
      !Array.isArray(data.uniqueRows) ||
      data.uniqueScheduledBlocks !== data.uniqueRows.length ||
      data.uniqueRows.length < 600 ||
      data.uniqueRows.length > 690
    )
      throw new Error('Malformed Aave dense event-window artifact')
    let previousBlock = -1,
      previousAt = -1
    const byBlock = new Map()
    for (const row of data.uniqueRows) {
      if (
        row?.status !== 'ok' ||
        !Number.isSafeInteger(row.block) ||
        row.block <= previousBlock ||
        !Number.isSafeInteger(row.at) ||
        row.at <= previousAt ||
        !Number.isFinite(row.cash) ||
        row.cash < 0 ||
        (row.cashRaw !== undefined && !/^\d+$/.test(row.cashRaw))
      )
        throw new Error('Malformed or nonmonotonic Aave dense cash row')
      byBlock.set(row.block, row)
      previousBlock = row.block
      previousAt = row.at
    }
    if (
      data.rpcRange?.firstBlock !== data.uniqueRows[0].block ||
      data.rpcRange?.lastBlock !== previousBlock
    )
      throw new Error('Malformed Aave dense RPC range')
    for (const window of data.windows) {
      if (
        !['incident', 'control'].includes(window?.kind) ||
        !Number.isSafeInteger(window.anchorAt) ||
        !Number.isSafeInteger(window.anchorBlock) ||
        window.coverage?.complete !== true ||
        window.coverage?.failed !== 0 ||
        window.coverage?.successful !== 115 ||
        !Array.isArray(window.rows) ||
        window.rows.length !== 115 ||
        !window.rows.every(
          (row) =>
            byBlock.get(row.block)?.at === row.at && byBlock.get(row.block)?.cash === row.cash,
        ) ||
        window.rows[112]?.block !== window.anchorBlock ||
        window.rows[112]?.at !== window.anchorAt
      )
        throw new Error('Malformed Aave dense window')
    }
    return {
      kind: 'aave-freeze-dense-cash-windows',
      study: data.study,
      count: data.uniqueRows.length,
      firstBlock: data.uniqueRows[0].block,
      lastBlock: previousBlock,
    }
  }
  if (data.exploratory === true && data.ruleFrozenBeforeMissingWindowCollection === true) {
    if (
      data.status !== 'complete' ||
      data.target !== 'q=$100m USDe cash crossing at 6–24h sampled outcome points' ||
      !Array.isArray(data.results) ||
      data.results.length !== 8 ||
      data.summary?.eligibleIncidents !== 4 ||
      data.summary?.eligibleControls !== 4 ||
      data.summary?.scoredIncidents !== 4 ||
      data.summary?.scoredControls !== 4 ||
      data.summary?.minimumSampleGatePassed !== false ||
      data.results.filter((row) => row.kind === 'incident').length !== 4 ||
      data.results.filter((row) => row.kind === 'control').length !== 4 ||
      !data.results.every(
        (row) =>
          row.status === 'scored' &&
          Number.isSafeInteger(row.anchorAt) &&
          Number.isFinite(row.baseline?.p95Usd) &&
          row.baseline.p95Usd >= 0 &&
          Array.isArray(row.checkpoints) &&
          row.checkpoints.length === 2 &&
          row.checkpoints.every(
            (point, i) =>
              point.hour === 3 + i * 3 &&
              Number.isFinite(point.sixHourDropUsd) &&
              typeof point.flagged === 'boolean',
          ) &&
          typeof row.flagged === 'boolean' &&
          typeof row.crossedQ100m === 'boolean',
      )
    )
      throw new Error('Malformed expanded Aave two-stage score')
    return {
      kind: 'aave-freeze-cash-expanded-score',
      study: data.signal,
      count: data.results.length,
      firstTimestamp: data.results[0].anchorAt,
      lastTimestamp: data.results.at(-1).anchorAt,
    }
  }
  if (data.exploratory === true && data.rule?.eventGate?.includes('independent 24h suppression')) {
    const validArm = (arm) =>
      Number.isSafeInteger(arm?.alerts) &&
      arm.alerts >= 0 &&
      Number.isSafeInteger(arm.hits) &&
      arm.hits >= 0 &&
      Number.isSafeInteger(arm.falseAlerts) &&
      arm.falseAlerts === arm.alerts - arm.hits &&
      Array.isArray(arm.alertsDetail) &&
      arm.alertsDetail.length === arm.alerts &&
      arm.alertsDetail.every(
        (alert) =>
          Number.isSafeInteger(alert.at) &&
          Number.isFinite(alert.cash) &&
          alert.cash >= data.rule.qUsd &&
          Number.isFinite(alert.sixHourDrop) &&
          Number.isFinite(alert.past14dP95) &&
          alert.sixHourDrop > alert.past14dP95 &&
          (alert.targetAt === null || Number.isSafeInteger(alert.targetAt)),
      ) &&
      arm.alertsDetail.every(
        (alert, i) => i === 0 || alert.at - arm.alertsDetail[i - 1].at >= 24 * 3600,
      )
    if (
      data.status !== 'complete' ||
      data.rule.qUsd !== 100_000_000 ||
      data.rule.suppressionHours !== 24 ||
      data.samples !== 559 ||
      !Array.isArray(data.independentEpisodes) ||
      !validArm(data.cashOnly) ||
      !validArm(data.eventGated) ||
      !data.eventGated.alertsDetail.every((alert) => alert.precedingEvent?.enabled === true)
    )
      throw new Error('Malformed Aave cash/event ablation artifact')
    return {
      kind: 'aave-cash-event-ablation',
      study: 'cash-only versus event-gated early warning',
      count: data.samples,
      firstTimestamp: Date.parse(data.span.first) / 1000,
      lastTimestamp: Date.parse(data.span.last) / 1000,
    }
  }
  if (
    data.study === 'Compound III Ethereum USDC-USDT weekly cash prevalence screen' ||
    data.study === 'Compound III Ethereum USDS weekly cash prevalence expansion'
  ) {
    const isUsds = data.study === 'Compound III Ethereum USDS weekly cash prevalence expansion'
    const markets = isUsds
      ? [
          {
            name: 'cUSDSv3',
            comet: '0x5D409e56D886231aDAf00c8775665AD0f9897b56',
            base: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
            decimals: 18,
          },
        ]
      : [
          {
            name: 'cUSDCv3',
            comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
            base: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            decimals: 6,
          },
          {
            name: 'cUSDTv3',
            comet: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
            base: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
            decimals: 6,
          },
        ]
    const first = 23_229_806
    const last = 26_052_206
    const step = 50_400
    const perMarket = (last - first) / step + 1
    if (
      data.version !== 1 ||
      data.chainId !== 1 ||
      data.status !== 'complete' ||
      data.grid?.first !== first ||
      data.grid?.last !== last ||
      data.grid?.step !== step ||
      JSON.stringify(data.markets) !== JSON.stringify(markets) ||
      JSON.stringify(data.scenariosUsdAssumingPeg) !==
        JSON.stringify([1_000_000, 10_000_000, 100_000_000]) ||
      data.semantics !==
        'Pinned baseToken.balanceOf(Comet); Comet totalSupply/totalBorrow accrued present values plus totalsBasic principal/index; isWithdrawPaused. Cash assumes $1 peg.' ||
      data.failedReadCount !== 0 ||
      !Array.isArray(data.failures) ||
      data.failures.length !== 0 ||
      !Array.isArray(data.rows) ||
      data.rows.length !== markets.length * perMarket ||
      data.coverage?.expected !== markets.length * perMarket ||
      data.coverage?.present !== markets.length * perMarket ||
      data.coverage?.missing !== 0 ||
      data.coverage?.complete !== true ||
      !data.coverage.markets ||
      Object.keys(data.coverage.markets).sort().join(',') !==
        markets
          .map((m) => m.name)
          .sort()
          .join(',')
    )
      throw new Error('Malformed Compound weekly artifact')
    const timestamps = []
    for (let m = 0; m < markets.length; m++) {
      const market = markets[m]
      let previousAt = -1
      let maxGapSeconds = 0
      let maxGapBlocks = null
      for (let i = 0; i < perMarket; i++) {
        const row = data.rows[m * perMarket + i]
        const block = first + i * step
        const rawFields = [
          'cashRaw',
          'totalSupplyRaw',
          'totalBorrowRaw',
          'totalSupplyBaseRaw',
          'totalBorrowBaseRaw',
          'baseSupplyIndexRaw',
          'baseBorrowIndexRaw',
        ]
        if (
          row?.market !== market.name ||
          row.comet !== market.comet ||
          row.base !== market.base ||
          row.decimals !== market.decimals ||
          row.block !== block ||
          !Number.isSafeInteger(row.at) ||
          row.at <= previousAt ||
          (m > 0 && row.at !== timestamps[i]) ||
          typeof row.withdrawPaused !== 'boolean' ||
          !rawFields.every((field) => typeof row[field] === 'string' && /^\d+$/.test(row[field])) ||
          !Number.isFinite(row.cashUsdAssumingPeg) ||
          row.cashUsdAssumingPeg !== Number(row.cashRaw) / 10 ** market.decimals ||
          !Number.isSafeInteger(row.lastAccrualTime) ||
          row.lastAccrualTime < 0 ||
          row.lastAccrualTime > row.at
        )
          throw new Error('Malformed or nonmonotonic Compound weekly row')
        if (i) {
          const gap = row.at - previousAt
          if (gap > maxGapSeconds) {
            maxGapSeconds = gap
            maxGapBlocks = [block - step, block]
          }
        }
        if (m === 0) timestamps.push(row.at)
        previousAt = row.at
      }
      const state = data.coverage.markets[market.name]
      if (
        state?.expected !== perMarket ||
        state.present !== perMarket ||
        state.missing !== 0 ||
        state.firstBlock !== first ||
        state.lastBlock !== last ||
        state.maxGapSeconds !== maxGapSeconds ||
        JSON.stringify(state.maxGapBlocks) !== JSON.stringify(maxGapBlocks)
      )
        throw new Error('Compound weekly coverage mismatch')
    }
    return {
      kind: isUsds ? 'compound-comet-usds-weekly-cash-screen' : 'compound-comet-weekly-cash-screen',
      study: data.study,
      count: data.rows.length,
      firstBlock: first,
      lastBlock: last,
      firstTimestamp: timestamps[0],
      lastTimestamp: timestamps.at(-1),
    }
  }
  if (data.study === 'Aave V3 USDe full 400d pinned cash grid') {
    if (
      data.status !== 'complete' ||
      data.version !== 1 ||
      data.chainId !== 1 ||
      !['pool', 'underlying', 'aToken', 'variableDebtToken'].every((key) =>
        /^0x[a-fA-F0-9]{40}$/.test(data[key]),
      ) ||
      data.grid?.first !== 23_229_806 ||
      data.grid?.last !== 26_052_206 ||
      data.grid?.step !== 900 ||
      data.coverage?.expected !== 3137 ||
      data.coverage?.present !== 3137 ||
      data.coverage?.missing !== 0 ||
      data.coverage?.complete !== true ||
      data.coverage?.maxGapSeconds > 4 * 3600 ||
      data.failedReadCount !== 0 ||
      !Array.isArray(data.failures) ||
      data.failures.length !== 0 ||
      !Array.isArray(data.rows) ||
      data.rows.length !== 3137
    )
      throw new Error('Malformed Aave full-grid artifact')
    let priorAt = -1
    for (let i = 0; i < data.rows.length; i++) {
      const row = data.rows[i]
      if (
        row?.block !== data.grid.first + i * 900 ||
        !Number.isSafeInteger(row.at) ||
        row.at <= priorAt ||
        (i && row.at - priorAt > 4 * 3600) ||
        !['cash', 'debt', 'liquidityRatePct', 'borrowRatePct'].every(
          (key) => Number.isFinite(row[key]) && row[key] >= 0,
        ) ||
        !['active', 'frozen', 'paused'].every((key) => typeof row[key] === 'boolean') ||
        !['archive-read', 'aave-usde-cash-mar-jun-2026', 'aave-usde-cash-sparse-400d'].includes(
          row.source,
        )
      )
        throw new Error('Malformed or gapped Aave full-grid row')
      priorAt = row.at
    }
    if (
      data.coverage.firstBlock !== data.rows[0].block ||
      data.coverage.lastBlock !== data.rows.at(-1).block
    )
      throw new Error('Malformed Aave full-grid bounds')
    return {
      kind: 'aave-usde-full-cash-grid',
      study: data.study,
      count: data.rows.length,
      firstBlock: data.rows[0].block,
      lastBlock: data.rows.at(-1).block,
      firstTimestamp: data.rows[0].at,
      lastTimestamp: priorAt,
    }
  }
  if (data.study === 'Fixed full-400d walk-forward Aave USDe cash and cross-asset-event ablation') {
    const validPeriod = (period) =>
      Array.isArray(period?.episodes) &&
      Number.isSafeInteger(period.independentControls) &&
      period.independentControls >= 0 &&
      ['cashOnly', 'eventGated'].every((key) => {
        const arm = period[key]
        return (
          Number.isSafeInteger(arm?.alerts) &&
          Number.isSafeInteger(arm.hits) &&
          Number.isSafeInteger(arm.falseAlerts) &&
          arm.hits + arm.falseAlerts === arm.alerts &&
          Array.isArray(arm.alertsDetail) &&
          arm.alertsDetail.length === arm.alerts &&
          arm.independentEpisodes === period.episodes.length
        )
      })
    if (
      data.status !== 'complete' ||
      data.exploratory !== true ||
      data.sources?.cashSha256 !==
        '8489c2135c2d0a981d948876b16fd40e409e710e9f1d169ef3c23aa99c7b9681' ||
      data.sources?.eventCensusSha256 !==
        'b9492de70a178957531a810917232e7e50a3c4fbe85fe3cf464c88d772df120f' ||
      data.rule?.qUsd !== 100_000_000 ||
      data.rule?.promotionGate?.minIndependentEpisodes !== 20 ||
      data.samples !== 3137 ||
      data.grid?.first !== 23_229_806 ||
      data.grid?.last !== 26_052_206 ||
      data.grid?.complete !== true ||
      data.split?.boundaryIndex !== Math.floor(3137 * 0.7) ||
      data.split?.purgeSeconds !== 86400 ||
      !validPeriod(data.train) ||
      !validPeriod(data.holdout) ||
      !['unassessable', 'failed', 'passed'].includes(data.promotion?.status)
    )
      throw new Error('Malformed Aave full-grid evaluation')
    return {
      kind: 'aave-usde-full-grid-evaluation',
      study: data.study,
      count: data.samples,
      firstTimestamp: Date.parse(data.span.first) / 1000,
      lastTimestamp: Date.parse(data.span.last) / 1000,
    }
  }
  if (data.study === 'scrvUSD historical direct quotes') {
    if (
      !Number.isSafeInteger(data.days) ||
      data.days < 1 ||
      !Number.isSafeInteger(data.stepBlocks) ||
      data.stepBlocks < 1
    )
      throw new Error('Malformed quote artifact metadata')
    rows = data.rows
    kind = 'curve-quote-samples'
    study = data.study
    rowCheck = (row) =>
      Array.isArray(row.pools) &&
      row.pools.length === 2 &&
      [10000, 1000000, 20000000].every(
        (size) => Number.isFinite(row.quotes?.[size]) && row.quotes[size] > 0,
      )
  } else if (
    data.study === 'exploratory fixed-grid split route; post-outcome redesign, no promotion'
  ) {
    rows = data.rows
    kind = 'curve-split-route-samples'
    study = data.study
    rowCheck = (row) =>
      Number.isFinite(row.singleQuote) &&
      Number.isFinite(row.splitQuote) &&
      Array.isArray(row.grid) &&
      row.grid.length > 0
  } else if (data.study === 'ETH/USD Chainlink as-of pinned Curve quote blocks') {
    rows = data.prices
    kind = 'chainlink-eth-prices'
    study = data.study
    rowCheck = (row) =>
      Number.isFinite(row.price) &&
      row.price > 0 &&
      Number.isSafeInteger(row.oracleUpdatedAt) &&
      row.oracleUpdatedAt <= row.at
  } else if (
    data.summary?.study === 'scrvUSD upstream flow, peg, and registered PegKeeper exploratory test'
  ) {
    rows = data.features
    kind = 'curve-upstream-features'
    study = data.summary.study
    rowCheck = (row) =>
      Number.isFinite(row.quote20m) &&
      row.quote20m > 0 &&
      Array.isArray(row.pools) &&
      Array.isArray(row.keepers)
  } else if (data.study === 'fixed-size two-pool scrvUSD secondary exits') {
    if (
      data.sampleCount !== data.rows?.length ||
      data.firstBlock !== data.rows?.[0]?.block ||
      data.lastBlock !== data.rows?.at(-1)?.block ||
      !data.sizes?.['100000'] ||
      !data.sizes?.['1000000'] ||
      !Array.isArray(data.caveats)
    )
      throw new Error('Malformed size-aware Curve artifact metadata')
    rows = data.rows
    kind = 'curve-size-aware-secondary-exits'
    study = data.study
    rowCheck = (row) =>
      Number.isFinite(row.vaultAssetsCrvUsd) &&
      row.vaultAssetsCrvUsd > 0 &&
      [100000, 1000000].every((size) => {
        const route = row.routes?.[size]
        const shares = [0, 0.25, 0.5, 0.75, 1]
        return (
          Number.isFinite(route?.bestQuote) &&
          route.bestQuote > 0 &&
          Array.isArray(route.grid) &&
          route.grid.length === shares.length &&
          route.grid.every(
            (point, i) =>
              point.usdtShare === shares[i] && Number.isFinite(point.output) && point.output >= 0,
          ) &&
          Math.abs(route.bestQuote - Math.max(...route.grid.map((point) => point.output)) / size) <
            1e-10
        )
      })
  } else if (data.study === 'Aave V3 USDe unencumbered supplier cash-exit runway') {
    if (
      data.version !== 1 ||
      data.status !== 'complete' ||
      data.chainId !== 1 ||
      !/^0x[a-fA-F0-9]{40}$/.test(data.pool) ||
      !/^0x[a-fA-F0-9]{40}$/.test(data.underlying) ||
      !/^0x[a-fA-F0-9]{40}$/.test(data.aToken) ||
      !/^0x[a-fA-F0-9]{40}$/.test(data.variableDebtToken) ||
      !Number.isSafeInteger(data.stepBlocks) ||
      data.stepBlocks < 1
    )
      throw new Error('Malformed Aave cash-runway artifact metadata')
    rows = data.rows
    kind = 'aave-usde-cash-runway'
    study = data.study
    rowCheck = (row) =>
      Number.isFinite(row.cash) &&
      row.cash >= 0 &&
      Number.isFinite(row.debt) &&
      row.debt >= 0 &&
      Number.isFinite(row.liquidityRatePct) &&
      row.liquidityRatePct >= 0 &&
      Number.isFinite(row.borrowRatePct) &&
      row.borrowRatePct >= 0 &&
      typeof row.active === 'boolean' &&
      typeof row.frozen === 'boolean' &&
      typeof row.paused === 'boolean'
  } else if (data.study === 'sky-litepsm-usdc-runway-v1') {
    const validAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(value)
    const validRaw = (value) => typeof value === 'string' && /^\d+$/.test(value)
    const validEvent = (event) =>
      Number.isSafeInteger(event?.block) &&
      Number.isSafeInteger(event?.at) &&
      Number.isSafeInteger(event?.logIndex) &&
      /^0x[a-fA-F0-9]{64}$/.test(event?.tx) &&
      event.block <= data.source?.headBlock
    if (
      data.protocol?.study !== data.study ||
      data.protocol.positionUsdc !== 20_000_000 ||
      !Number.isSafeInteger(data.days) ||
      data.days < 1 ||
      data.days > 7 ||
      !['wrapper', 'psm', 'pocket', 'usdc', 'usds'].every((key) =>
        validAddress(data.addresses?.[key]),
      ) ||
      !Number.isSafeInteger(data.source?.headBlock) ||
      !Number.isSafeInteger(data.source?.startBlock) ||
      data.source?.stepBlocks !== 900 ||
      !Array.isArray(data.transfers) ||
      data.transfers.length > 1_000_000 ||
      !data.transfers.every(
        (event) =>
          validEvent(event) && validRaw(event.usdcRaw) && ['in', 'out'].includes(event.direction),
      ) ||
      !Array.isArray(data.psmEvents) ||
      data.psmEvents.length > 1_000_000 ||
      !data.psmEvents.every(
        (event) =>
          validEvent(event) &&
          (event.type === 'File'
            ? /^0x[a-fA-F0-9]{64}$/.test(event.what) && validRaw(event.dataRaw)
            : ['BuyGem', 'SellGem'].includes(event.type) &&
              validRaw(event.valueRaw) &&
              validRaw(event.feeRaw)),
      )
    )
      throw new Error('Malformed Sky LitePSM pilot artifact')
    rows = data.samples
    kind = 'sky-litepsm-pocket-pilot'
    study = data.study
    rowCheck = (row) => validRaw(row.pocketUsdcRaw) && validRaw(row.toutRaw)
  } else if (data.study === 'sky-litepsm-pocket-weekly-screen-v1') {
    const validAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(value)
    const validRaw = (value) => typeof value === 'string' && /^\d+$/.test(value)
    if (
      data.horizonDays !== 400 ||
      data.positionUsdc !== 20_000_000 ||
      !['psm', 'pocket', 'usdc'].every((key) => validAddress(data.addresses?.[key])) ||
      !Number.isSafeInteger(data.source?.headBlock) ||
      data.source?.stepBlocks !== 50_400
    )
      throw new Error('Malformed Sky LitePSM weekly artifact')
    rows = data.samples
    kind = 'sky-litepsm-pocket-weekly-screen'
    study = data.study
    rowCheck = (row) => validRaw(row.pocketUsdcRaw) && validRaw(row.toutRaw)
  } else {
    throw new Error('Unsupported research artifact study; add an explicit schema before importing')
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1_000_000)
    throw new Error('Malformed research artifact row collection')
  let previousBlock = -1
  let previousAt = -1
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row?.block) ||
      row.block <= previousBlock ||
      !Number.isSafeInteger(row?.at) ||
      row.at <= previousAt ||
      !rowCheck(row)
    )
      throw new Error('Malformed or nonmonotonic sample row')
    previousBlock = row.block
    previousAt = row.at
  }
  return {
    kind,
    study,
    count: rows.length,
    firstBlock: rows[0].block,
    lastBlock: previousBlock,
    firstTimestamp: rows[0].at,
    lastTimestamp: previousAt,
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function importArtifact({ name, source, root = DEFAULT_ROOT }) {
  validatedName(name)
  if (typeof source !== 'string' || !isAbsolute(source) || source.split(sep).includes('..'))
    throw new Error('Source must be an absolute path without traversal')
  assertNoSymlinks(source)
  if (!lstatSync(source).isFile()) throw new Error('Source must be a regular file')
  const sourceBasename = basename(source)
  if (!SOURCE_BASENAME.test(sourceBasename))
    throw new Error('Source basename is not a safe JSON filename')
  const bytes = readFileSync(source)
  if (bytes.length > 150_000_000) throw new Error('Artifact exceeds 150 MB compressed/file limit')
  const compressed = sourceBasename.endsWith('.json.gz')
  const details = inspectArtifact(bytes, compressed)
  const sha256 = digest(bytes)
  const targetRoot = storageRoot(root)
  const lock = join(targetRoot, '.import.lock')
  assertNoSymlinks(lock)
  let handle
  try {
    handle = openSync(lock, 'wx', 0o600)
    const manifest = readManifest(targetRoot)
    const existing = manifest.artifacts[name]
    if (existing) {
      if (existing.sha256 !== sha256)
        throw new Error(`Name already exists with different content: ${name}`)
      verifyEntry(targetRoot, name, existing)
      return { name, status: 'already-present', ...existing }
    }
    const file = `${sha256}.json${compressed ? '.gz' : ''}`
    const target = join(targetRoot, file)
    if (existsSync(target)) {
      assertNoSymlinks(target)
      if (digest(readFileSync(target)) !== sha256) throw new Error(`Corrupt existing blob: ${file}`)
    } else {
      atomicWrite(target, bytes)
    }
    const entry = {
      file,
      sha256,
      bytes: bytes.length,
      sourceBasename,
      importedAt: new Date().toISOString(),
      ...details,
    }
    manifest.artifacts[name] = entry
    atomicWrite(manifestPath(targetRoot), JSON.stringify(manifest, null, 2) + '\n')
    return { name, status: 'imported', ...entry }
  } finally {
    if (handle !== undefined) {
      closeSync(handle)
      unlinkSync(lock)
    }
  }
}

function verifyEntry(root, name, entry) {
  const path = join(root, entry.file)
  assertNoSymlinks(path)
  if (!existsSync(path)) throw new Error(`Missing blob for ${name}`)
  const bytes = readFileSync(path)
  if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
    throw new Error(`Hash or byte-length mismatch for ${name}`)
  const details = inspectArtifact(bytes, entry.file.endsWith('.json.gz'))
  for (const key of Object.keys(details))
    if (details[key] !== entry[key]) throw new Error(`Metadata mismatch for ${name}: ${key}`)
  return path
}

export function verifyArtifacts({ root = DEFAULT_ROOT } = {}) {
  const targetRoot = storageRoot(root)
  const manifest = readManifest(targetRoot)
  const names = Object.keys(manifest.artifacts).sort()
  for (const name of names) verifyEntry(targetRoot, name, manifest.artifacts[name])
  return { verified: names.length, names }
}

export function listArtifacts({ root = DEFAULT_ROOT } = {}) {
  const manifest = readManifest(storageRoot(root))
  return Object.entries(manifest.artifacts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({ name, ...entry }))
}

export function artifactPath({ name, root = DEFAULT_ROOT }) {
  validatedName(name)
  const targetRoot = storageRoot(root)
  const entry = readManifest(targetRoot).artifacts[name]
  if (!entry) throw new Error(`Unknown artifact: ${name}`)
  return verifyEntry(targetRoot, name, entry)
}

function cli() {
  const [command, ...args] = process.argv.slice(2)
  const allowed =
    command === 'import'
      ? new Set(['name', 'source'])
      : command === 'path'
        ? new Set(['name'])
        : command === 'verify' || command === 'list'
          ? new Set()
          : null
  if (!allowed)
    throw new Error(
      'Usage: local-artifacts.mjs import --name NAME --source PATH | verify | list | path --name NAME',
    )
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
      throw new Error('Expected --name VALUE or --source PATH')
    const key = args[i].slice(2)
    if (!allowed.has(key) || Object.hasOwn(options, key))
      throw new Error(`Unknown or repeated option: --${key}`)
    options[key] = args[i + 1]
  }
  if (command === 'import') return importArtifact({ name: options.name, source: options.source })
  if (command === 'verify') return verifyArtifacts()
  if (command === 'list') return listArtifacts()
  if (command === 'path') return { name: options.name, path: artifactPath({ name: options.name }) }
  throw new Error(
    'Usage: local-artifacts.mjs import --name NAME --source PATH | verify | list | path --name NAME',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(cli()) + '\n')
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message }) + '\n')
    process.exitCode = 1
  }
}
