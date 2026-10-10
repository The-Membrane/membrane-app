// Offline research projection from the verified prospective queue journal.
// Syntax candidates are not reserve changes, executable exits, or alerts.
import { classifyAaveDirectConfiguratorAction } from './aave-direct-configurator-intent.mjs'
import { DEFAULT_OUT, readJournal } from './aave-governance-queue-watch.mjs'

const ACTION_FIELDS = [
  'target',
  'withDelegateCall',
  'accessLevel',
  'value',
  'signature',
  'callData',
]
const TERMINAL = new Set(['PayloadExecuted', 'PayloadCancelled'])

function sameActions(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length > 0 &&
    left.length === right.length &&
    left.every(
      (action, index) =>
        action &&
        right[index] &&
        ACTION_FIELDS.every((field) => action[field] === right[index][field]),
    )
  )
}

function eventOrder(left, right) {
  return left.block - right.block || left.txIndex - right.txIndex || left.logIndex - right.logIndex
}

function classify(actions, event, lifecycle) {
  const classified = actions.map((action, index) => ({
    index,
    intent: classifyAaveDirectConfiguratorAction({
      ...action,
      observationBlockHash: event.blockHash,
      lifecycle,
    }),
  }))
  return {
    status: classified.every((item) => item.intent.status === 'candidate')
      ? 'candidate'
      : 'unknown',
    actions: classified,
  }
}

function unknown(reason) {
  return { status: 'unknown', reason, actions: [] }
}

/**
 * Read-only and fail-closed. readJournal verifies the receipt SHA chain, source,
 * complete v2 clock and coverage invariants before any projection is returned.
 * Retryable failures contribute no observations; canonical conflicts and legacy
 * complete receipts abort rather than becoming a partial feed.
 */
export function projectAaveGovernanceIntentJournal(path = DEFAULT_OUT) {
  const { entries } = readJournal(path)
  if (entries.some((entry) => entry.status === 'canonical_conflict'))
    throw new Error('Queue journal contains a canonical conflict')
  const completeEntries = entries.filter((entry) => entry.status === 'complete')
  if (!completeEntries.length) throw new Error('No verified complete queue receipts')

  const created = new Map()
  const result = []
  let priorFeatureAvailableAt = -Infinity
  for (const receipt of completeEntries) {
    const featureAvailableAt = Date.parse(receipt.localFeatureAvailableAt)
    if (featureAvailableAt < priorFeatureAvailableAt)
      throw new Error('Queue feature clock regressed across complete receipts')
    priorFeatureAvailableAt = featureAvailableAt
    const events = [...receipt.events].sort(eventOrder)
    const snapshotsByEvent = new Map()
    for (const snapshot of receipt.snapshots) {
      const key = `${snapshot.payloadId}:${snapshot.block}`
      const prior = snapshotsByEvent.get(key)
      snapshotsByEvent.set(key, prior ? null : snapshot)
    }
    for (const event of events) {
      if (event.kind !== 'PayloadCreated' && event.kind !== 'PayloadQueued') continue
      const sameBlockTerminal = events.some(
        (other) =>
          other.payloadId === event.payloadId &&
          other.block === event.block &&
          TERMINAL.has(other.kind),
      )
      const laterEvent = (other) =>
        other.payloadId === event.payloadId && eventOrder(other, event) > 0
      const terminalBeforeAvailable = events.some(
        (other) => laterEvent(other) && TERMINAL.has(other.kind),
      )
      const queuedBeforeAvailable =
        event.kind === 'PayloadCreated' &&
        events.some((other) => laterEvent(other) && other.kind === 'PayloadQueued')
      const base = {
        payloadId: event.payloadId,
        lifecycle: event.kind === 'PayloadCreated' ? 'created' : 'queued',
        block: event.block,
        blockHash: event.blockHash,
        txHash: event.txHash,
        logIndex: event.logIndex,
        localFeatureAvailableAt: receipt.localFeatureAvailableAt,
        alertEligible: false,
        executableExitCapacity: 'not_inferred',
      }
      const snapshot = snapshotsByEvent.get(`${event.payloadId}:${event.block}`)
      let projection
      if (sameBlockTerminal || terminalBeforeAvailable) {
        projection = unknown(
          sameBlockTerminal
            ? 'same_block_terminal_transition'
            : 'terminal_before_feature_available',
        )
      } else if (queuedBeforeAvailable) {
        projection = unknown('superseded_by_queue_before_feature_available')
      } else if (event.kind === 'PayloadCreated') {
        if (!Array.isArray(event.actions) || !event.actions.length)
          projection = unknown('created_actions_missing')
        else if (
          !snapshot ||
          snapshot.blockCloseOnly !== true ||
          snapshot.blockHash !== event.blockHash ||
          snapshot.payloadId !== event.payloadId ||
          !['created', 'queued'].includes(snapshot.lifecycle)
        )
          projection = unknown('created_pinned_snapshot_unavailable')
        else if (!sameActions(event.actions, snapshot.actions))
          projection = unknown('created_actions_mismatch_getter')
        else projection = classify(event.actions, event, 'created')
      } else {
        const origin = created.get(event.payloadId)
        if (!origin) projection = unknown('created_payload_not_observed')
        else if (eventOrder(origin, event) >= 0) projection = unknown('queue_not_after_created')
        else if (
          !snapshot ||
          snapshot.blockCloseOnly !== true ||
          snapshot.blockHash !== event.blockHash ||
          snapshot.payloadId !== event.payloadId ||
          snapshot.lifecycle !== 'queued'
        )
          projection = unknown('queued_pinned_snapshot_unavailable')
        else if (!sameActions(origin.actions, snapshot.actions))
          projection = unknown('queued_actions_mismatch_created')
        else projection = classify(origin.actions, event, 'queued')
      }
      result.push({ ...base, ...projection })
      if (
        event.kind === 'PayloadCreated' &&
        !created.has(event.payloadId) &&
        !sameBlockTerminal &&
        !terminalBeforeAvailable &&
        snapshot?.blockCloseOnly === true &&
        snapshot.blockHash === event.blockHash &&
        snapshot.payloadId === event.payloadId &&
        ['created', 'queued'].includes(snapshot.lifecycle) &&
        sameActions(event.actions, snapshot?.actions)
      )
        created.set(event.payloadId, event)
    }
  }
  return result
}
