#!/usr/bin/env node
/**
 * Offline capped proxy for the August 2026 measured carry cohort's held capital.
 *
 * This is NOT live TVL, destination-protocol TVL, or the value of a single vault.
 * Display route labels often collapse many destination contracts and borrow venues.
 * Rebuild: node scripts/research/carry-route-capital.mjs
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_SOURCE_DIR =
  '/Users/EBmic/.claude/projects/-Users-EBmic-membrane-solidity/lending-scan'
const DEFAULT_OUTPUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../components/Carry/route-capital.json',
)
const SOURCE_FILES = [
  'routes_ab.json',
  'carries_wide.json',
  'carry_tvl.json',
  'unified_routes.json',
  'morpho_markets.json',
]

// Contract-address and decimals pairing is fixed by the app's curated
// historyScan.ts asset catalog, except RLUSD from docs/research/venue-capacity-drivers.md.
// All prices here are expressly APPROXIMATED at $1/token, not historical oracle prices.
export const STABLE_DECIMALS = Object.freeze({
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // USDT
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f': 18, // USDS
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': 18, // GHO
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': 6, // PYUSD
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 18, // USDe
  '0x8292bb45bf1ee4d140127049757c2e0ff06317ed': 18, // RLUSD
})

const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : value)
const groupKey = (row) =>
  `${row.proto}|${lower(row.borrower ?? row.owner)}|${lower(row.dest ?? row.vault)}`
const eventKey = (row) =>
  [
    row.proto,
    lower(row.borrower),
    lower(row.dest),
    row.block,
    lower(row.tx),
    lower(row.asset),
    lower(row.market),
    row.amt,
  ].join('|')
const cents = (value) => Math.round((value + Number.EPSILON) * 100) / 100

function amountUsdApprox(row, morphoMarkets) {
  const token = lower(row.asset ?? morphoMarkets[lower(row.market)]?.loan)
  const decimals = STABLE_DECIMALS[token]
  if (decimals === undefined || !/^\d+$/.test(String(row.amt))) return null
  return Number(BigInt(row.amt)) / 10 ** decimals
}

/** Pure transformation for fixture tests and offline regeneration. */
export function deriveRouteCapital({
  routesAb,
  carriesWide,
  carryTvl,
  unifiedRoutes,
  morphoMarkets,
}) {
  const holdings = new Map(
    carryTvl
      .filter((row) => row.open && Number.isFinite(row.usd) && row.usd > 0)
      .map((row) => [groupKey(row), row]),
  )
  const allInflows = new Map()
  for (const row of carriesWide) {
    const key = eventKey(row)
    if (!allInflows.has(key)) allInflows.set(key, row) // one duplicate in saved scan
  }
  const inflowsByGroup = new Map()
  for (const row of allInflows.values()) {
    const key = groupKey(row)
    if (!inflowsByGroup.has(key)) inflowsByGroup.set(key, [])
    inflowsByGroup.get(key).push(row)
  }
  const selectedByRoute = new Map()
  for (const row of routesAb) {
    if (!selectedByRoute.has(row.route)) selectedByRoute.set(row.route, [])
    selectedByRoute.get(row.route).push(row)
  }

  return unifiedRoutes.map((display, index) => {
    const selected = selectedByRoute.get(display.route) ?? []
    const byGroup = new Map()
    for (const row of selected) {
      const key = groupKey(row)
      if (!byGroup.has(key)) byGroup.set(key, [])
      byGroup.get(key).push(row)
    }
    let capital = 0
    let pricedGroups = 0
    let matchedHoldings = 0
    let missingHoldings = 0
    let unsupportedAssets = 0
    let incompleteInflows = 0
    for (const [key, routeRows] of byGroup) {
      const holding = holdings.get(key)
      if (!holding) {
        missingHoldings++
        continue
      }
      matchedHoldings++
      const all = inflowsByGroup.get(key) ?? []
      const allKeys = new Set(all.map(eventKey))
      if (routeRows.some((row) => !allKeys.has(eventKey(row)))) {
        incompleteInflows++
        continue
      }
      const allAmounts = all.map((row) => amountUsdApprox(row, morphoMarkets))
      const routeAmounts = routeRows.map((row) => amountUsdApprox(row, morphoMarkets))
      if ([...allAmounts, ...routeAmounts].some((amount) => amount === null)) {
        unsupportedAssets++
        continue
      }
      const allInflow = allAmounts.reduce((sum, amount) => sum + amount, 0)
      const selectedInflow = routeAmounts.reduce((sum, amount) => sum + amount, 0)
      if (allInflow <= 0 || selectedInflow > allInflow + 1e-6) {
        incompleteInflows++
        continue
      }
      // One owner+destination holding can support several route labels, but is
      // capped once by all attributed carried inflows then split pro rata.
      capital += (Math.min(holding.usd, allInflow) * selectedInflow) / allInflow
      pricedGroups++
    }
    const destinations = new Set(selected.map((row) => lower(row.dest)))
    const borrowProtocols = new Set(selected.map((row) => row.proto))
    return {
      id: `${index}:${display.route}`,
      route: display.route,
      venueLabel: display.venue,
      observedPositions: display.pos,
      selectedEvents: selected.length,
      matchedGroups: byGroup.size,
      destinationContracts: destinations.size,
      borrowProtocols: [...borrowProtocols].sort(),
      cohortHeldCapitalUsdApprox: pricedGroups ? cents(capital) : null,
      pricedOpenGroups: pricedGroups,
      matchedOpenHoldings: matchedHoldings,
      missingPricedHoldingGroups: missingHoldings,
      unsupportedAssetGroups: unsupportedAssets,
      incompleteInflowGroups: incompleteInflows,
      status: !selected.length
        ? 'no-comparable-lending-route-snapshot'
        : pricedGroups
          ? 'partial-capped-proxy'
          : 'unpriced',
    }
  })
}

export function buildArtifact(sourceDir = DEFAULT_SOURCE_DIR) {
  const source = {}
  const files = {}
  for (const name of SOURCE_FILES) {
    const raw = readFileSync(join(sourceDir, name))
    files[name] = JSON.parse(raw)
    source[name] = createHash('sha256').update(raw).digest('hex')
  }
  return {
    schemaVersion: 1,
    asOf: '2026-08-06 (saved valuation snapshot; exact block/time unavailable)',
    scope:
      'Estimated capped cohort stock by displayed route category; not verified retained borrow proceeds, live TVL, or one-vault TVL.',
    method:
      'Per borrow-protocol+owner+destination, cap saved USD holding by all saved carried inflow (stable token units approximated at $1), then allocate to measured route labels pro rata by their qualifying inflows. Missing priced holdings are unknown, not zero. Routes can aggregate multiple vault contracts.',
    attributionLimit:
      'Withdrawn borrowed funds may have been replaced by unrelated deposits in the same owner+destination holding; this snapshot cannot distinguish them. The capped amount is an attribution proxy, not proven still-held carry principal.',
    pricing:
      '$1/token approximation only for the explicit contract/decimals allowlist; unsupported or mixed unknown assets are omitted. Saved holding USD used the source snapshot price.',
    decimalsProvenance:
      'membrane-app/lib/position-sim/historyScan.ts (USDC, USDT, USDS, GHO, PYUSD, USDe); membrane-app/docs/research/venue-capacity-drivers.md (RLUSD 18 decimals). Morpho market loan token addresses come from hashed morpho_markets.json.',
    sourceSha256: source,
    routes: deriveRouteCapital({
      routesAb: files['routes_ab.json'],
      carriesWide: files['carries_wide.json'],
      carryTvl: files['carry_tvl.json'],
      unifiedRoutes: files['unified_routes.json'],
      morphoMarkets: files['morpho_markets.json'],
    }),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceIndex = process.argv.indexOf('--source-dir')
  const outputIndex = process.argv.indexOf('--output')
  const sourceDir = sourceIndex < 0 ? DEFAULT_SOURCE_DIR : process.argv[sourceIndex + 1]
  const output = outputIndex < 0 ? DEFAULT_OUTPUT : resolve(process.argv[outputIndex + 1])
  if (!sourceDir || !output) throw new Error('Expected value after --source-dir or --output')
  const artifact = buildArtifact(sourceDir)
  writeFileSync(output, JSON.stringify(artifact, null, 2) + '\n')
  console.log(`${artifact.routes.length} route categories → ${output}`)
}
