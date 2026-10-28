// The instrument panel's demo position, and the price ladder drawn from it.
//
// PURE: no React. Every number comes from lib/positionAlerts (the same engine the
// Position page runs), so the landing can never drift from the alert rules: the
// at-risk line is the R27 marker, the line is the liquidation price, and the lowest
// rung is immediateLiquidationPrice (line ÷ (1 + window), launch default window).

import {
  actNowExplainer,
  healthBarModel,
  type HealthBarModel,
  type PositionSnapshot,
} from '@/lib/positionAlerts'

import { TOOLKIT } from './facts'

/** Fixed timestamp: the demo is a fixture, and the server and client must render the same. */
const DEMO_TS = Date.parse('2026-10-27T00:00:00Z') / 1000

export function toolkitSnapshot(demo = TOOLKIT.demo): PositionSnapshot {
  const { oraclePriceUsd, liquidationThreshold, distanceToLine } = demo
  return {
    id: 'landing-demo',
    ts: DEMO_TS,
    venue: 'Membrane',
    collateral: [{ symbol: 'BTC', amount: 1, oraclePriceUsd, liquidationThreshold }],
    debt: [
      {
        symbol: 'CDT',
        amount: oraclePriceUsd * liquidationThreshold * (1 - distanceToLine),
        priceUsd: 1,
        stable: true,
      },
    ],
  }
}

export type RungId = 'at-risk' | 'now' | 'line' | 'immediate'

export interface Rung {
  id: RungId
  priceUsd: number
  /** Short mono label. Never a probability, never a time in hand. */
  label: string
}

export interface ToolkitDemo {
  snapshot: PositionSnapshot
  model: HealthBarModel
  /** Highest price first: the order a falling price meets them. */
  rungs: Rung[]
  /** The R29 Membrane explainer with this position's prices filled in. */
  explainer: string
}

export function toolkitDemo(demo = TOOLKIT.demo): ToolkitDemo {
  const snapshot = toolkitSnapshot(demo)
  const model = healthBarModel(snapshot)
  const line = model.liquidationPriceUsd
  const oracle = model.oraclePriceUsd
  const immediate = model.immediatePriceUsd
  const atRisk = model.markers.find((m) => m.id === 'at-risk')

  const rungs: Rung[] = []
  if (line !== null && atRisk && atRisk.distance < 1)
    rungs.push({
      id: 'at-risk',
      priceUsd: line / (1 - atRisk.distance),
      label: 'At-risk alert fires',
    })
  if (oracle !== null) rungs.push({ id: 'now', priceUsd: oracle, label: 'Oracle price now' })
  if (line !== null)
    rungs.push({ id: 'line', priceUsd: line, label: 'Line: act now; a timer can start' })
  if (immediate !== null)
    rungs.push({ id: 'immediate', priceUsd: immediate, label: 'Liquidation at once, no timer' })
  rungs.sort((a, b) => b.priceUsd - a.priceUsd)

  return { snapshot, model, rungs, explainer: actNowExplainer(line, immediate) }
}
