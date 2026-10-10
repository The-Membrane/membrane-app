// Fixed before collecting the non-April incident windows. This only defines
// collection/coverage; no alert threshold or outcome score is selected here.
export const COLLECTION = Object.freeze({
  version: 1,
  targetCashUsd: 100_000_000,
  preDays: 14,
  postHours: 6,
  stepBlocks: 900,
  preSteps: 112,
  postSteps: 2,
  expectedRowsPerWindow: 115,
  maxGapSeconds: 4 * 3600,
  endpointToleranceSeconds: 90 * 60,
  selection:
    'All q100-eligible cross-reserve freeze/pause incidents except Apr 18 (already dense-cached), plus each preregistered matched control; no outcome-based selection',
  coverage:
    'complete only if every scheduled block read succeeds, first sample is at/before anchor-14d+90m, last at/after anchor+6h-90m, and maximum adjacent timestamp gap <=4h',
})

export function selectWindows(study, { excludeAt } = {}) {
  if (study.status !== 'complete' || !Array.isArray(study.incidents))
    throw new Error('Complete incident study required')
  const selected = study.incidents.filter(
    (row) => row.response?.[String(COLLECTION.targetCashUsd)]?.eligible && row.at !== excludeAt,
  )
  if (selected.length !== 3 || selected.some((row) => !row.control))
    throw new Error('Expected three non-April eligible incidents with matched controls')
  return selected.flatMap((incident) => [
    {
      kind: 'incident',
      incidentAt: incident.at,
      anchorAt: incident.at,
      anchorBlock: incident.block,
    },
    {
      kind: 'control',
      incidentAt: incident.at,
      anchorAt: incident.control.at,
      anchorBlock: incident.control.block,
    },
  ])
}

export function blockGrid(anchorBlock) {
  if (
    !Number.isSafeInteger(anchorBlock) ||
    anchorBlock <= COLLECTION.preSteps * COLLECTION.stepBlocks
  )
    throw new Error('Invalid anchor block')
  return Array.from(
    { length: COLLECTION.expectedRowsPerWindow },
    (_, i) => anchorBlock + (i - COLLECTION.preSteps) * COLLECTION.stepBlocks,
  )
}

export function coverageFor(window, rows) {
  const successful = rows.filter((row) => row.status === 'ok')
  const failures = rows.filter((row) => row.status === 'failed')
  const gaps = successful.slice(1).map((row, i) => row.at - successful[i].at)
  const maxGapSeconds = gaps.length ? Math.max(...gaps) : null
  const firstAt = successful[0]?.at ?? null
  const lastAt = successful.at(-1)?.at ?? null
  const anchorRow = rows[COLLECTION.preSteps]
  const endpointStartDeltaSeconds =
    firstAt === null ? null : firstAt - (window.anchorAt - 14 * 86400)
  const endpointEndDeltaSeconds = lastAt === null ? null : lastAt - (window.anchorAt + 6 * 3600)
  return {
    scheduled: rows.length,
    successful: successful.length,
    failed: failures.length,
    firstAt,
    lastAt,
    maxGapSeconds,
    endpointStartDeltaSeconds,
    endpointEndDeltaSeconds,
    anchorTimestampDeltaSeconds: anchorRow?.status === 'ok' ? anchorRow.at - window.anchorAt : null,
    complete:
      rows.length === COLLECTION.expectedRowsPerWindow &&
      failures.length === 0 &&
      successful.length === COLLECTION.expectedRowsPerWindow &&
      anchorRow?.block === window.anchorBlock &&
      anchorRow?.at === window.anchorAt &&
      endpointStartDeltaSeconds <= COLLECTION.endpointToleranceSeconds &&
      endpointEndDeltaSeconds >= -COLLECTION.endpointToleranceSeconds &&
      maxGapSeconds <= COLLECTION.maxGapSeconds &&
      gaps.every((gap) => gap > 0),
  }
}

export function collectionStatus(windows) {
  return windows.length === 6 && windows.every((window) => window.coverage.complete)
    ? 'complete'
    : 'partial'
}
