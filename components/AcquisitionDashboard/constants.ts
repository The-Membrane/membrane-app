import { SEMANTIC_COLORS } from '@/config/semanticColors'

export const PRIMARY_PURPLE = SEMANTIC_COLORS.primary
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Mock supply history data (used when contract has no history yet)
export const MOCK_SUPPLY_HISTORY = (() => {
  const now = Math.floor(Date.now() / 1000)
  const DAY = 86400
  const entries = []
  // Generate ~90 days of mock data showing gradual supply increase and burns
  for (let i = 90; i >= 0; i--) {
    const ts = now - i * DAY
    const dayIndex = 90 - i
    // Supply starts at 800M and grows to ~900M
    const currentSupply = 800_000_000 + dayIndex * 1_100_000 + Math.floor(Math.sin(dayIndex * 0.3) * 500_000)
    // Burns accumulate slowly
    const burnedSupply = 50_000_000 + dayIndex * 550_000
    entries.push({
      timestamp: ts,
      current_supply: String(currentSupply * 1_000_000), // uMBRN
      burned_supply: String(burnedSupply * 1_000_000),
    })
  }
  return { denom: 'mbrn', snapshots: entries }
})()

/* ── Lockdrop phase helpers ── */
export type LockdropPhase = 'upcoming' | 'deposit' | 'withdrawal' | 'claims-ready' | 'unknown'

export const PHASE_COLORS: Record<LockdropPhase, string> = {
  upcoming: SEMANTIC_COLORS.textTertiary,
  deposit: SEMANTIC_COLORS.info,
  withdrawal: SEMANTIC_COLORS.warning,
  'claims-ready': SEMANTIC_COLORS.primary,
  unknown: SEMANTIC_COLORS.textTertiary,
}

export const PHASE_LABELS: Record<LockdropPhase, string> = {
  upcoming: 'Upcoming',
  deposit: 'Deposit Period',
  withdrawal: 'Withdrawal Period',
  'claims-ready': 'Claims Ready',
  unknown: 'Unknown',
}

export const getLockdropPhase = (lockdrop: any): LockdropPhase => {
  if (!lockdrop) return 'unknown'
  const now = Math.floor(Date.now() / 1000)
  if (now < lockdrop.start_time) return 'upcoming'
  if (now < lockdrop.deposit_end) return 'deposit'
  if (now < lockdrop.withdrawal_end) return 'withdrawal'
  return 'claims-ready'
}
