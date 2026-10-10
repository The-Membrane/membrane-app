import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  disjointH24InventoryChanges,
  historicalScenarioMatchesCapacity,
  historicalResidualAfterAmount,
  summarizeHistoricalInventoryChanges,
} from '@/components/Venue/historicalInventoryScenarioLogic'
import {
  extractHistoricalInventoryPoints,
  readHistoricalInventoryEvidence,
  readHistoricalInventoryScenario,
} from '@/pages/api/venues/historical-inventory-scenario'
import { artifactPath } from '@/scripts/research/local-artifacts.mjs'

describe('historical aggregate inventory scenario', () => {
  it('requires physical 24h endpoints, grid continuity, and enough disjoint windows', () => {
    const rows = Array.from({ length: 8 * 121 + 1 }, (_, index) => ({
      at: 1_700_000_000 + index * 3 * 3600,
      inventoryUsd: 1_000_000 + index * 100,
    }))
    const changes = disjointH24InventoryChanges(rows)
    expect(changes.length).toBeGreaterThanOrEqual(100)
    expect(changes[0]).toBe(800)
    expect(summarizeHistoricalInventoryChanges(changes)?.sampleCount).toBe(changes.length)
    expect(summarizeHistoricalInventoryChanges(changes.slice(0, 99))).toBeNull()
    expect(disjointH24InventoryChanges(rows.filter((_, index) => index !== 4))).toEqual([])
    expect(
      disjointH24InventoryChanges([
        { at: 0, inventoryUsd: 1_000 },
        { at: 24 * 3600 + 90 * 60 + 1, inventoryUsd: 500 },
      ]),
    ).toEqual([])
  })

  it('binds the selected amount and exact 24h horizon with interval arithmetic', () => {
    const scenario = readHistoricalInventoryScenario('aave-v3-usde')!
    const current = 100_000_000
    const amount = 1_000_000
    const band = historicalResidualAfterAmount(scenario, current, amount, 24)!
    expect(band.lowUsd).toBeCloseTo(current + scenario.netInventoryChangeUsd.p10 - amount)
    expect(band.highUsd).toBeCloseTo(current + scenario.netInventoryChangeUsd.p90 - amount)
    expect(historicalResidualAfterAmount(scenario, current, amount, 4)).toBeNull()
    expect(historicalResidualAfterAmount(scenario, current, null, 24)).toBeNull()
    expect(historicalScenarioMatchesCapacity(scenario, 'aave-v3-usde', 'instantUsd')).toBe(true)
    expect(historicalScenarioMatchesCapacity(scenario, 'aave-v3-usde', 'depthUsd')).toBe(false)
  })

  it('accepts exact historical route inventories and rejects substituted Curve pools', () => {
    const aave = readHistoricalInventoryScenario('aave-v3-usde')!
    const curve = readHistoricalInventoryScenario('scrvUSD')!
    expect(aave.metric).toBe('instantUsd')
    expect(curve.metric).toBe('depthUsd')
    expect(aave.windowEndpointToleranceMinutes).toBe(90)
    expect(curve.windowEndpointToleranceMinutes).toBe(90)
    expect(aave.sampleCount).toBeGreaterThanOrEqual(100)
    expect(curve.sampleCount).toBeGreaterThanOrEqual(100)
    expect(aave.worstObservedNetContractionUsd).toBeGreaterThan(0)
    expect(curve.worstObservedNetContractionUsd).toBeGreaterThan(0)
    const path = artifactPath({ name: 'scrvusd-leading-400d' })
    const artifact = JSON.parse(readFileSync(path, 'utf8'))
    artifact.rows[0].pools[0].address = '0x0000000000000000000000000000000000000000'
    expect(extractHistoricalInventoryPoints('scrvUSD', artifact)).toBeNull()
  })

  it('uses verified replay for the other three exact route metrics and gates sample coverage', () => {
    for (const [venue, metric] of [
      ['sUSDe', 'depthUsd'],
      ['sUSDS', 'depthUsd'],
      ['sGHO', 'instantUsd'],
    ] as const) {
      const evidence = readHistoricalInventoryEvidence(venue)
      expect(evidence?.venue).toBe(venue)
      expect(evidence?.metric).toBe(metric)
      expect(evidence?.sourceKind).toBe('local_replay_chain')
      expect(evidence?.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
      if (venue === 'sUSDS') expect(evidence?.sourceLabel).toBe('shared Sky Pocket USDC')
      if (evidence?.status === 'insufficient_history') {
        expect(evidence.sampleCount).toBeLessThan(evidence.requiredSampleCount)
        expect(evidence.requiredSampleCount).toBe(100)
      } else {
        expect(evidence?.status).toBe('historical_scenario')
        expect(evidence?.sampleCount).toBeGreaterThanOrEqual(100)
      }
    }
  })
})
