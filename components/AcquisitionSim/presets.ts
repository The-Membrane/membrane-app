import type { SimConfig, SimEvent, UtilizationPoint } from './engine/types'
import { DEFAULT_CONFIG } from './engine/types'

export interface SimPreset {
  id: string
  label: string
  description: string
  config: Partial<SimConfig>
  events: SimEvent[]
  utilizationCurve: UtilizationPoint[]
}

export const PRESETS: SimPreset[] = [
  // ── Scenario 1: Healthy Window ──────────────────────────────────────────
  {
    id: 'healthy-window',
    label: '1. Healthy Window',
    description:
      'Pool fills fully at 65% utilization. Deposits arrive steadily. No bump needed.',
    config: {},
    events: [
      { dayOffset: 0.5, type: 'deposit', amount: 500_000_000 },
      { dayOffset: 2, type: 'deposit', amount: 300_000_000 },
      { dayOffset: 5, type: 'deposit', amount: 200_000_000 },
      { dayOffset: 8, type: 'deposit', amount: 200_000_000 },
    ],
    utilizationCurve: [
      { dayOffset: 0, utilization: 0.65 },
      { dayOffset: 30, utilization: 0.65 },
    ],
  },

  // ── Scenario 2: Efficiency Clamp Fires ──────────────────────────────────
  {
    id: 'efficiency-clamp',
    label: '2. Efficiency Clamp',
    description:
      'Low base rate + worsening efficiency causes rate mutations that overshoot. Post-withdrawal clamp fires.',
    config: {
      baseAcquisitionRate: 400,
    },
    events: [
      { dayOffset: 1, type: 'deposit', amount: 100_000_000 },
      { dayOffset: 3, type: 'deposit', amount: 50_000_000 },
    ],
    utilizationCurve: [
      { dayOffset: 0, utilization: 0.60 },
      { dayOffset: 30, utilization: 0.60 },
    ],
  },

  // ── Scenario 3: Pool Maxes / Bump Pressure ──────────────────────────────
  {
    id: 'pool-maxes-bump',
    label: '3. Pool Maxes + Bump',
    description:
      'High utilization fills pool to 1B cap. Bump rate kicks in and pressures CDP rates.',
    config: {},
    events: [
      { dayOffset: 0.5, type: 'deposit', amount: 800_000_000 },
      { dayOffset: 5, type: 'deposit', amount: 400_000_000 },
    ],
    utilizationCurve: [
      { dayOffset: 0, utilization: 0.65 },
      { dayOffset: 30, utilization: 0.65 },
    ],
  },

  // ── Scenario 4: Utilization Drops / Bump Decay ──────────────────────────
  {
    id: 'util-drops-bump-decay',
    label: '4. Bump Decay',
    description:
      'Util starts high, builds bump pressure, then drops below target. Bump decays at 2x speed.',
    config: { initialBumpRate: 0.025 },
    events: [
      { dayOffset: 1, type: 'deposit', amount: 500_000_000 },
    ],
    utilizationCurve: [
      { dayOffset: 0, utilization: 0.65 },
      { dayOffset: 14, utilization: 0.65 },
      { dayOffset: 19, utilization: 0.40 },
      { dayOffset: 30, utilization: 0.40 },
    ],
  },

  // ── Scenario 5: Cross-Window Bump Carry ─────────────────────────────────
  {
    id: 'cross-window-carry',
    label: '5. Cross-Window Carry',
    description:
      'Window starts with carry bump=0.015 and low util. Bump decays before fresh accrual begins.',
    config: { initialBumpRate: 0.015 },
    events: [
      { dayOffset: 5, type: 'deposit', amount: 300_000_000 },
      { dayOffset: 8, type: 'deposit', amount: 200_000_000 },
    ],
    utilizationCurve: [
      { dayOffset: 0, utilization: 0.35 },
      { dayOffset: 4, utilization: 0.40 },
      { dayOffset: 6, utilization: 0.55 },
      { dayOffset: 30, utilization: 0.55 },
    ],
  },

  // ── Scenario 6: Rate Mutation Walkthrough ───────────────────────────────
  {
    id: 'rate-mutations',
    label: '6. Rate Mutations',
    description:
      'Tick-by-tick rate mutation walkthrough. Big deposits improve efficiency, then stagnation worsens it.',
    config: {},
    events: [
      { dayOffset: 0.5, type: 'deposit', amount: 1_000_000_000 },
      { dayOffset: 5, type: 'deposit', amount: 2_000_000_000 },
      { dayOffset: 7, type: 'deposit', amount: 1_000_000_000 },
    ],
    utilizationCurve: [
      { dayOffset: 0, utilization: 0.60 },
      { dayOffset: 30, utilization: 0.60 },
    ],
  },

  // ── Scenario 7: Oscillating Utilization ─────────────────────────────────
  {
    id: 'oscillating-util',
    label: '7. Oscillating Util',
    description:
      'Utilization oscillates around target (0.55/0.45 every 6hrs). Tests asymmetric bump decay stability.',
    config: {},
    events: [
      { dayOffset: 1, type: 'deposit', amount: 500_000_000 },
    ],
    utilizationCurve: (() => {
      // Generate oscillation: 0.55 for 6hrs, 0.45 for 6hrs, repeat
      const points: UtilizationPoint[] = []
      for (let d = 0; d <= 30; d += 0.25) {
        // 0.25 day = 6 hours
        const cycle = Math.floor(d / 0.25) % 2
        points.push({
          dayOffset: d,
          utilization: cycle === 0 ? 0.55 : 0.45,
        })
      }
      return points
    })(),
  },

  // ── Scenario 8: Full System Trace ───────────────────────────────────────
  {
    id: 'full-trace',
    label: '8. Full System Trace',
    description:
      'Complete Window 1→2 trace. Deposits, pool fills, bump builds, withdrawal, efficiency clamp check.',
    config: {},
    events: [
      { dayOffset: 0.5, type: 'deposit', amount: 500_000_000 },
      { dayOffset: 3, type: 'deposit', amount: 800_000_000 },
      { dayOffset: 7, type: 'deposit', amount: 700_000_000 },
      { dayOffset: 16, type: 'withdrawal', amount: 200_000_000 },
    ],
    utilizationCurve: [
      { dayOffset: 0, utilization: 0.60 },
      { dayOffset: 20, utilization: 0.60 },
      { dayOffset: 22, utilization: 0.35 },
      { dayOffset: 28, utilization: 0.55 },
      { dayOffset: 40, utilization: 0.55 },
    ],
  },
]
