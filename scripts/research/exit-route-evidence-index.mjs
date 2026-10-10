// Read-only route index. Assays and clocks remain separate; no exit forecast is inferred.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scrvusdPanel } from './exit-evidence-panel.mjs'
import { readAsOf } from './morpho-exit-panel-snapshot.mjs'

const utc = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const identity = (parts) => JSON.stringify(parts)
const increment = (object, key) => {
  object[key] = (object[key] ?? 0) + 1
}
const refIdentity = (ref) => identity([ref.filename, ref.physicalSha256])

function strata(rows, assay) {
  const groups = new Map()
  const seen = new Set()
  for (const row of rows) {
    const key = identity([
      assay,
      row.chainId,
      row.vault,
      row.asset,
      row.rawAssetAmount,
      row.holderPolicy,
      row.route,
    ])
    const observationKey = identity([key, row.holder ?? row.unavailableIdentity, row.anchor])
    assert(!seen.has(observationKey), 'Duplicate route, holder, size and anchor observation')
    seen.add(observationKey)
    if (!groups.has(key))
      groups.set(key, {
        assay,
        chainId: row.chainId,
        vault: row.vault,
        asset: row.asset,
        rawAssetAmount: row.rawAssetAmount,
        holderPolicy: row.holderPolicy,
        route: row.route,
        implementationIdentity: 'unverified',
        targetIdentity: 'unverified',
        dependentRowCount: 0,
        distinctHolderCount: 0,
        distinctAnchorCount: 0,
        independentEpisodeCount: null,
        classifications: {},
        horizonClasses: {},
        sourceRefs: [],
        _holders: new Set(),
        _anchors: new Set(),
        _refs: new Set(),
      })
    const group = groups.get(key)
    group.dependentRowCount++
    if (row.holder !== null) group._holders.add(row.holder)
    group._anchors.add(identity(row.anchor))
    increment(group.classifications, row.classification)
    for (const horizon of row.horizons ?? []) {
      const horizonKey = String(horizon.seconds)
      const classes = (group.horizonClasses[horizonKey] ??= {})
      increment(classes, horizon.class)
    }
    for (const ref of row.refs) {
      if (!group._refs.has(refIdentity(ref))) {
        group._refs.add(refIdentity(ref))
        group.sourceRefs.push(ref)
      }
    }
  }
  return [...groups.values()]
    .map(({ _holders, _anchors, _refs, ...group }) => ({
      ...group,
      distinctHolderCount: _holders.size,
      distinctAnchorCount: _anchors.size,
      sourceRefs: group.sourceRefs.toSorted((a, b) => refIdentity(a).localeCompare(refIdentity(b))),
    }))
    .toSorted((a, b) =>
      identity([a.assay, a.chainId, a.vault, a.asset, a.rawAssetAmount, a.route]).localeCompare(
        identity([b.assay, b.chainId, b.vault, b.asset, b.rawAssetAmount, b.route]),
      ),
    )
}

export function indexFromSources({ asOfUtc, scrvusd, morpho }) {
  assert(utc(asOfUtc), 'Invalid as-of UTC')
  assert(scrvusd?.schema === 'scrvusd-exit-evidence-panel-v1', 'Invalid scrvUSD panel')
  assert(scrvusd.asOfUtc === asOfUtc, 'scrvUSD cutoff differs')
  assert(
    morpho === null || morpho?.receipt?.study === 'morpho-exit-panel-snapshot-v3',
    'Invalid Morpho v3 receipt',
  )
  if (morpho) assert(morpho.receipt.issuedAtUtc <= asOfUtc, 'Morpho receipt is future evidence')

  const scrvRows = scrvusd.rows.map((row) => {
    assert(
      row.venue?.chainId && row.venue.vault && row.venue.asset && row.rawAssetAmount,
      'Incomplete scrvUSD route identity',
    )
    assert(row.anchor?.block?.hash && row.holder, 'Incomplete scrvUSD observation identity')
    return {
      chainId: row.venue.chainId,
      vault: row.venue.vault,
      asset: row.venue.asset,
      rawAssetAmount: row.rawAssetAmount,
      holderPolicy: 'fixed_same_holder_at_anchor',
      route: row.route,
      holder: row.holder,
      anchor: [row.anchor.block.number, row.anchor.block.hash],
      classification: row.future.observation.status,
      horizons: row.future.horizons,
      refs: [
        row.sourceRefs.durationIssue,
        row.sourceRefs.flowContextIssue,
        row.sourceRefs.latestScore,
      ]
        .filter((ref) => ref?.physicalSha256)
        .map(({ filename, physicalSha256 }) => ({ filename, physicalSha256 })),
    }
  })
  const scrvStrata = strata(scrvRows, 'scrvusd_same_holder_direct_withdraw')
  const scrvClassifications = {}
  for (const row of scrvRows) increment(scrvClassifications, row.classification)

  const morphoRows = morpho?.receipt.summary.rows ?? []
  const morphoRef = morpho
    ? { filename: morpho.filename, physicalSha256: morpho.physicalSha256 }
    : null
  const morphoStrata = strata(
    morphoRows.map((row) => {
      assert(
        row.vault && row.asset && Number.isSafeInteger(row.anchorBlock),
        'Incomplete Morpho route identity',
      )
      assert(
        row.classification === 'baseline-ineligible' || (row.holder && row.qAssets),
        'Eligible Morpho row lacks holder or fixed amount',
      )
      return {
        chainId: morpho.receipt.evidenceScope.chainId,
        vault: row.vault,
        asset: row.asset,
        rawAssetAmount: row.qAssets ?? null,
        holderPolicy: row.holder
          ? 'fixed_same_holder_simulated_withdraw'
          : 'holder_unavailable_baseline_ineligible',
        route: morpho.receipt.evidenceScope.route,
        holder: row.holder,
        unavailableIdentity: row.proposalIndex ?? row.index,
        anchor: row.anchorBlock,
        classification: row.classification,
        refs: [morphoRef],
      }
    }),
    'morpho_historical_first64_simulated_withdraw',
  )
  const morphoClassifications = {}
  for (const row of morphoRows) increment(morphoClassifications, row.classification)

  return {
    schema: 'exit-route-evidence-index-v1',
    asOfUtc,
    status: 'descriptive_uncalibrated',
    forecast: { status: 'unavailable', reason: 'no_independent_route_calibration' },
    sources: {
      scrvusd: {
        status: scrvRows.length ? 'available' : 'absent',
        assay: 'scrvusd_same_holder_direct_withdraw',
        clock: 'frozen_anchor_block_time',
        horizonSeconds: scrvusd.horizonsSeconds,
        dependentRowCount: scrvRows.length,
        dependence: scrvusd.dependence,
        classifications: scrvClassifications,
        stratumCount: scrvStrata.length,
      },
      morpho: morpho
        ? {
            status: 'available',
            assay: 'morpho_historical_first64_simulated_withdraw',
            issueClock: 'local-operator-system-clock-claim',
            baselineClock: 'pre-block-B-minus-1',
            scheduledClock: 'first-eligible-executableAt-not-verified-execution',
            prospectiveLead: 'unavailable',
            receiptRef: morphoRef,
            issuedAtUtc: morpho.receipt.issuedAtUtc,
            dependentRowCount: morphoRows.length,
            baselineEligible: morpho.receipt.summary.counts.baselineEligible,
            dependence: {
              uniqueVaults: morpho.receipt.summary.dependence.uniqueVaults,
              uniqueHolders: morpho.receipt.summary.dependence.uniqueHolders,
              independentEpisodeCount: null,
            },
            classifications: morphoClassifications,
            stratumCount: morphoStrata.length,
          }
        : { status: 'absent', reason: 'no_v3_receipt_at_as_of_cutoff' },
    },
    strata: [...scrvStrata, ...morphoStrata],
    caveat:
      'Each assay retains its own dependent denominator and clock. Sampled success, censoring and historical flow do not establish continuous or future exit capacity. Implementation and target code identity are unverified in this index.',
  }
}

export function readIndex({
  asOfUtc,
  horizons = [],
  scrvusdOptions = {},
  morphoOptions = {},
} = {}) {
  assert(utc(asOfUtc), 'Invalid as-of UTC')
  const scrvusd = scrvusdPanel({ asOfUtc, horizons, ...scrvusdOptions })
  const morpho = readAsOf({ asOfUtc, ...morphoOptions })
  return indexFromSources({ asOfUtc, scrvusd, morpho })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [asOfUtc, ...horizonArgs] = process.argv.slice(2)
    assert(
      horizonArgs.every((value) => /^\d+$/.test(value)),
      'Invalid horizon seconds',
    )
    process.stdout.write(
      `${JSON.stringify(readIndex({ asOfUtc, horizons: horizonArgs.map(Number) }))}\n`,
    )
  } catch (error) {
    process.stderr.write(`[exit-route-evidence-index] ${error.message}\n`)
    process.exitCode = 1
  }
}
