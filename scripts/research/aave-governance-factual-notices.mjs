// Read-only research projection. The journal reader verifies the SHA chain and source.
import { DEFAULT_OUT, readJournal, SOURCE } from './aave-governance-queue-watch.mjs'

const HASH = /^0x[0-9a-f]{64}$/
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
const STATES = new Set(['created', 'queued', 'executed', 'cancelled', 'expired'])
const EVENTS = new Set(['PayloadCreated', 'PayloadQueued', 'PayloadExecuted', 'PayloadCancelled'])
const TERMINAL = new Set(['executed', 'cancelled', 'expired'])
const ms = (value) => {
  if (
    typeof value !== 'string' ||
    !UTC.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('Invalid local feature clock')
  return Date.parse(value)
}
const natural = (value, name) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || String(number) !== String(value))
    throw new Error(`Invalid ${name}`)
  return number
}
const key = (value) => String(natural(value, 'payload ID'))
const validSnapshot = (snapshot, receipt) => {
  if (
    !snapshot ||
    !STATES.has(snapshot.lifecycle) ||
    !HASH.test(snapshot.blockHash ?? '') ||
    !Number.isSafeInteger(snapshot.block) ||
    snapshot.block < receipt.from ||
    snapshot.block > receipt.to ||
    !Number.isSafeInteger(snapshot.timestamp) ||
    snapshot.timestamp < 0 ||
    snapshot.blockCloseOnly !== true ||
    snapshot.earliestExecutableAtBasis !== 'reference_code_unattested' ||
    snapshot.executionEligibility !== 'unclassified_code_unattested' ||
    snapshot.reserveImpact !== 'unclassified' ||
    snapshot.capIntent !== 'unknown'
  )
    throw new Error('Unsupported governance snapshot')
  const id = key(snapshot.payloadId)
  const queuedAt = natural(snapshot.queuedAt, 'queue time')
  const delay = natural(snapshot.delay, 'queue delay')
  const expected = queuedAt === 0 ? null : queuedAt + delay + 1
  if (
    !Number.isSafeInteger(expected ?? 0) ||
    snapshot.earliestExecutableAt !== expected ||
    (snapshot.lifecycle === 'created' && queuedAt !== 0) ||
    (['queued', 'executed'].includes(snapshot.lifecycle) && queuedAt === 0)
  )
    throw new Error('Inconsistent governance queue timing')
  return id
}

/** Pure projection of the object returned by readJournal(); no side effects. */
export function projectVerifiedGovernanceJournal(journal) {
  if (!journal || !Array.isArray(journal.entries)) throw new Error('Verified journal required')
  const byId = new Map()
  let priorFeatureMs = -1
  let priorFrom = null
  let lastComplete = null
  let latestReceiptStatus = null
  for (const receipt of journal.entries) {
    latestReceiptStatus = receipt.status
    if (priorFrom !== null && receipt.from !== priorFrom)
      throw new Error('Governance journal frontier is noncontiguous')
    if (receipt.status !== 'complete') continue
    if (receipt.receiptVersion !== 2 || receipt.openSetCoverage !== 'observed_payloads_only')
      throw new Error('Unsupported governance receipt')
    const featureMs = ms(receipt.localFeatureAvailableAt)
    if (featureMs < priorFeatureMs || featureMs < ms(receipt.firstObservedAt))
      throw new Error('Regressing governance feature chronology')
    priorFeatureMs = featureMs
    priorFrom = receipt.to + 1
    lastComplete = {
      toBlock: receipt.to,
      toHash: receipt.toHash,
      localFeatureAvailableAt: receipt.localFeatureAvailableAt,
    }
    const eventsById = new Map()
    for (const event of receipt.events ?? []) {
      const id = key(event.payloadId)
      if (
        !EVENTS.has(event.kind) ||
        !HASH.test(event.blockHash ?? '') ||
        !HASH.test(event.txHash ?? '') ||
        !Number.isSafeInteger(event.block) ||
        event.block < receipt.from ||
        event.block > receipt.to ||
        !Number.isSafeInteger(event.logIndex) ||
        event.logIndex < 0 ||
        !Number.isSafeInteger(event.txIndex) ||
        event.txIndex < 0 ||
        !Number.isSafeInteger(event.timestamp) ||
        event.timestamp < 0
      )
        throw new Error('Invalid governance event coordinate')
      const events = eventsById.get(id) ?? []
      events.push({
        kind: event.kind,
        block: event.block,
        blockHash: event.blockHash,
        timestamp: event.timestamp,
        txHash: event.txHash,
        txIndex: event.txIndex,
        logIndex: event.logIndex,
      })
      eventsById.set(id, events)
    }
    // One getter snapshot is taken at each distinct payload/event block. A
    // sealed journal alone does not prove that its event and getter headers
    // agree, so reconcile their exact block, hash, and timestamp here.
    const eventSnapshotKeys = new Set()
    for (const snapshot of receipt.snapshots ?? []) {
      const id = key(snapshot.payloadId)
      const matches = (eventsById.get(id) ?? []).filter((event) => event.block === snapshot.block)
      const snapshotKey = `${id}:${snapshot.block}`
      if (
        !matches.length ||
        eventSnapshotKeys.has(snapshotKey) ||
        matches.some(
          (event) =>
            event.blockHash !== snapshot.blockHash || event.timestamp !== snapshot.timestamp,
        )
      )
        throw new Error('Governance event and pinned snapshot disagree')
      eventSnapshotKeys.add(snapshotKey)
    }
    for (const [id, events] of eventsById)
      for (const event of events)
        if (!eventSnapshotKeys.has(`${id}:${event.block}`))
          throw new Error('Governance event lacks exact pinned snapshot')
    for (const snapshot of receipt.frontierSnapshots ?? [])
      if (snapshot.block !== receipt.to || snapshot.blockHash !== receipt.toHash)
        throw new Error('Governance frontier snapshot differs from sealed boundary')
    const snapshots = [
      ...(receipt.snapshots ?? []).map((snapshot, index) => ({ snapshot, order: index })),
      ...(receipt.frontierSnapshots ?? []).map((snapshot, index) => ({
        snapshot,
        order: (receipt.snapshots?.length ?? 0) + index,
      })),
    ]
    // Event-block snapshots precede frontier rechecks; repeated frontier reads
    // update the latest state without creating another payload notice.
    snapshots.sort((a, b) => a.snapshot.block - b.snapshot.block || a.order - b.order)
    const eventsAdded = new Set()
    for (const { snapshot } of snapshots) {
      const id = validSnapshot(snapshot, receipt)
      const prior = byId.get(id)
      if (
        prior &&
        (snapshot.block < prior.latestObservedState.block ||
          snapshot.timestamp < prior.latestObservedState.timestamp ||
          (snapshot.block === prior.latestObservedState.block &&
            (snapshot.blockHash !== prior.latestObservedState.blockHash ||
              snapshot.timestamp !== prior.latestObservedState.timestamp ||
              snapshot.lifecycle !== prior.latestObservedState.lifecycle)) ||
          (TERMINAL.has(prior.latestObservedState.lifecycle) &&
            snapshot.lifecycle !== prior.latestObservedState.lifecycle) ||
          (prior.latestObservedState.lifecycle === 'queued' && snapshot.lifecycle === 'created') ||
          (prior.queuedAt !== null && snapshot.queuedAt !== prior.queuedAt) ||
          (prior.queuedAt !== null && snapshot.delay !== prior.delaySeconds))
      )
        throw new Error('Inconsistent governance payload chronology')
      const observations = prior?.sourceEvents ?? []
      if (!eventsAdded.has(id)) {
        const seen = new Set(
          observations.map((event) => `${event.blockHash}:${event.txHash}:${event.logIndex}`),
        )
        for (const event of eventsById.get(id) ?? []) {
          const coordinate = `${event.blockHash}:${event.txHash}:${event.logIndex}`
          if (!seen.has(coordinate)) observations.push(event)
          seen.add(coordinate)
        }
        eventsAdded.add(id)
      }
      byId.set(id, {
        payloadId: id,
        firstLocalFeatureAvailableAt:
          prior?.firstLocalFeatureAvailableAt ?? receipt.localFeatureAvailableAt,
        firstQueuedLocalFeatureAvailableAt:
          prior?.firstQueuedLocalFeatureAvailableAt ??
          (snapshot.lifecycle === 'queued' ? receipt.localFeatureAvailableAt : null),
        latestLocalFeatureAvailableAt: receipt.localFeatureAvailableAt,
        firstObservedAt: prior?.firstObservedAt ?? receipt.firstObservedAt,
        latestObservedState: {
          lifecycle: snapshot.lifecycle,
          block: snapshot.block,
          blockHash: snapshot.blockHash,
          timestamp: snapshot.timestamp,
        },
        queuedAt: snapshot.queuedAt || null,
        delaySeconds: snapshot.delay,
        earliestExecutableAt: snapshot.earliestExecutableAt,
        earliestExecutableAtBasis: 'reference_code_unattested',
        executionEligibility: 'unclassified_code_unattested',
        reserveImpact: 'unclassified',
        exitImpact: 'unclassified',
        sourceEvents: observations,
        source: {
          chainId: SOURCE.chainId,
          controller: SOURCE.controller,
          latestBlockHash: snapshot.blockHash,
        },
        notificationEnabled: false,
      })
    }
    // An event without a matching pinned snapshot is not a complete feature.
    for (const id of eventsById.keys())
      if (!eventsAdded.has(id)) throw new Error('Governance event lacks pinned snapshot')
  }
  const candidates = [...byId.values()].sort((a, b) => Number(a.payloadId) - Number(b.payloadId))
  const available = latestReceiptStatus === 'complete'
  return {
    candidates,
    coverage: {
      status: available ? 'observed_payloads_only' : 'unavailable',
      reason:
        journal.entries.length === 0
          ? 'empty_journal'
          : available
            ? 'bounded_single_provider_observations'
            : latestReceiptStatus,
      latestComplete: lastComplete,
      nonCreatedLogCompleteness: 'uncorroborated_single_provider',
      globalQuietClaimEligible: false,
    },
    notificationEnabled: false,
    forecastEligible: false,
  }
}

/** Verify journal bytes before projecting factual, non-notifying candidates. */
export function readFactualGovernanceNotices(path = DEFAULT_OUT) {
  return projectVerifiedGovernanceJournal(readJournal(path))
}
