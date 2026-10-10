// Offline source manifest only. No outcome reads, controls, RPC, or causal claim.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readFactory } from './morpho-v2-route-census.mjs'
import {
  readRoute,
  validateCheckpoint as validateHeaders,
} from './morpho-v2-route-address-headers.mjs'

const ZERO = `0x${'0'.repeat(40)}`
const HEADER_PHYSICAL_SHA = '66595ce99bb86c86ddf38c8063c8f178bfbc4497043d61dab68762ab14deb4f6'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const lower = (value) => String(value || '').toLowerCase()
const eventKey = (row) => `${row.block}:${row.transactionIndex}:${row.logIndex}`

export function buildRouteRiskManifest({ factoryEvents, routeEvents, headers, expectedCount }) {
  if (!Array.isArray(factoryEvents) || !Array.isArray(routeEvents) || !Array.isArray(headers))
    throw new Error('Factory events, route events, and headers required')
  const factory = new Map()
  for (const row of factoryEvents) {
    const vault = lower(row.vault)
    if (
      !/^0x[0-9a-f]{40}$/.test(vault) ||
      !/^0x[0-9a-f]{40}$/.test(lower(row.asset)) ||
      !Number.isSafeInteger(row.block) ||
      row.block < 0 ||
      factory.has(vault)
    )
      throw new Error('Invalid or duplicate factory vault')
    factory.set(vault, { vault, asset: lower(row.asset), block: row.block })
  }
  const headerByBlock = new Map()
  for (const row of headers) {
    if (
      !Number.isSafeInteger(row.block) ||
      !Number.isSafeInteger(row.timestamp) ||
      !/^0x[0-9a-f]{64}$/.test(lower(row.hash)) ||
      headerByBlock.has(row.block)
    )
      throw new Error('Invalid or duplicate B header')
    headerByBlock.set(row.block, {
      block: row.block,
      hash: lower(row.hash),
      timestamp: row.timestamp,
    })
  }
  const priorByVault = new Map()
  const transitions = []
  let priorCoordinate = [-1, -1, -1]
  for (const event of routeEvents) {
    const vault = lower(event.vault)
    const source = factory.get(vault)
    if (
      !source ||
      !Number.isSafeInteger(event.block) ||
      !Number.isSafeInteger(event.transactionIndex) ||
      !Number.isSafeInteger(event.logIndex) ||
      !/^0x[0-9a-f]{40}$/.test(lower(event.adapter)) ||
      !/^0x[0-9a-f]{64}$/.test(lower(event.blockHash)) ||
      !/^0x[0-9a-f]{64}$/.test(lower(event.txHash)) ||
      !/^0x[0-9a-f]{64}$/.test(lower(event.dataTopicHash)) ||
      event.block < source.block ||
      [event.block, event.transactionIndex, event.logIndex].join(':') ===
        priorCoordinate.join(':') ||
      event.block < priorCoordinate[0] ||
      (event.block === priorCoordinate[0] && event.logIndex <= priorCoordinate[2])
    )
      throw new Error('Invalid, pre-creation, or unordered route event')
    priorCoordinate = [event.block, event.transactionIndex, event.logIndex]
    const prior = priorByVault.get(vault)
    const current = { adapter: lower(event.adapter), dataTopicHash: lower(event.dataTopicHash) }
    if (
      prior &&
      prior.adapter !== current.adapter &&
      prior.adapter !== ZERO &&
      current.adapter !== ZERO
    ) {
      const header = headerByBlock.get(event.block)
      if (!header || header.hash !== lower(event.blockHash))
        throw new Error('Missing or mismatched B header')
      const sameAssetFactoryVaultsCreatedBeforeB = [...factory.values()]
        .filter((row) => row.asset === source.asset && row.block < event.block)
        .map((row) => row.vault)
        .sort()
      transitions.push({
        vault,
        asset: source.asset,
        factoryCreationBlock: source.block,
        block: event.block,
        blockHash: lower(event.blockHash),
        transactionIndex: event.transactionIndex,
        txHash: lower(event.txHash),
        logIndex: event.logIndex,
        eventKey: eventKey(event),
        fromAdapter: prior.adapter,
        toAdapter: current.adapter,
        fromDataTopicHash: prior.dataTopicHash,
        toDataTopicHash: current.dataTopicHash,
        header,
        sameAssetFactoryVaultsCreatedBeforeB,
        sameAssetFactoryVaultCountBeforeB: sameAssetFactoryVaultsCreatedBeforeB.length,
        sourceInclusionReason: 'nonzero-to-nonzero-address-change',
        outcomeCohortInclusion: 'UNKNOWN',
        outcomeCohortReason: 'funded-holder-exit-status-unmeasured',
        fundedStatus: 'UNKNOWN',
        holderStatus: 'UNKNOWN',
        exitStatus: 'UNKNOWN',
      })
    }
    priorByVault.set(vault, current)
  }
  if (expectedCount !== undefined && transitions.length !== expectedCount)
    throw new Error(
      `Expected ${expectedCount} nonzero-to-nonzero transitions; found ${transitions.length}`,
    )
  const trainCount = Math.floor(transitions.length * 0.7)
  transitions.forEach((row, index) => {
    row.chronologicalIndex = index
    row.split = index < trainCount ? 'development' : 'held-out'
    row.splitReason = 'frozen-chronological-70-30-source-order'
  })
  const developmentVaults = new Set(transitions.slice(0, trainCount).map((row) => row.vault))
  const heldOutVaults = new Set(transitions.slice(trainCount).map((row) => row.vault))
  const sharedVaultsAcrossSplit = [...developmentVaults].filter((vault) => heldOutVaults.has(vault))
  transitions.forEach((row) => {
    row.vaultAppearsAcrossSplit = sharedVaultsAcrossSplit.includes(row.vault)
  })
  return {
    study: 'morpho-v2-route-risk-manifest-v1',
    transitionCount: transitions.length,
    split: {
      development: trainCount,
      heldOut: transitions.length - trainCount,
      sharedVaultCount: sharedVaultsAcrossSplit.length,
      vaultDisjointPartitions: sharedVaultsAcrossSplit.length === 0,
    },
    caveat:
      'Source-only chronological transition split, not an independent-vault outcome holdout. Funding, holders, executable exits and matched controls are unmeasured. No causal, predictive or exit-risk claim.',
    transitions,
  }
}

export function readSealedRouteRiskManifest({ factoryPath, routePath, headerPath }) {
  if (![factoryPath, routePath, headerPath].every((path) => typeof path === 'string' && path))
    throw new Error('Explicit sealed factory, route, and header paths required')
  const factoryVaults = readFactory(factoryPath)
  const factoryEvents = JSON.parse(readFileSync(factoryPath, 'utf8')).events
  if (factoryEvents.length !== factoryVaults.size) throw new Error('Factory event count mismatch')
  const route = readRoute(routePath, factoryPath)
  const headerBytes = readFileSync(headerPath)
  if (sha(headerBytes) !== HEADER_PHYSICAL_SHA)
    throw new Error('Pinned header physical SHA mismatch')
  const headerCheckpoint = validateHeaders(JSON.parse(headerBytes), route)
  if (headerCheckpoint.status !== 'complete') throw new Error('Incomplete B header cache')
  return buildRouteRiskManifest({
    factoryEvents,
    routeEvents: route.events,
    headers: headerCheckpoint.headers,
    expectedCount: 116,
  })
}

export const DEFAULT_ROUTE_PATH = resolve('data/research/venue-signals/morpho-v2-route-census.json')
export const DEFAULT_HEADER_PATH = resolve(
  'data/research/venue-signals/morpho-v2-route-address-headers.json',
)
