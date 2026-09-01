import { useMemo } from 'react'
import { useAcquisition, usePendingDeposits, useCurrentAcquisition, useAcquisitionHistory, useAcquisitionModelState, useCurrentAcquisitionWindow } from '@/hooks/useAcquisition'
import { useMBRNSupplyHistory } from '@/hooks/useNeutronProxy'
import { shiftDigits } from '@/helpers/math'
import { MOCK_SUPPLY_HISTORY, MONTHS, getLockdropPhase } from '../constants'

export const useAcquisitionDashboardData = () => {
  // Data hooks
  const { data: supplyHistory } = useMBRNSupplyHistory()
  const { deposits, isLoading: acquisitionLoading } = useAcquisition()
  const { data: pendingLocks } = usePendingDeposits()
  const { data: currentLockdrop } = useCurrentAcquisition()
  const { data: acquisitionHistory } = useAcquisitionHistory()
  const { data: modelState } = useAcquisitionModelState()
  const { data: currentWindow } = useCurrentAcquisitionWindow()

  // Supply history — use real data or mock fallback
  const supplyData = supplyHistory || MOCK_SUPPLY_HISTORY
  const useMockSupply = !supplyHistory || !supplyHistory.snapshots || supplyHistory.snapshots.length === 0

  // Chart data for supply over time
  const supplyChartData = useMemo(() => {
    const snapshots = useMockSupply ? MOCK_SUPPLY_HISTORY.snapshots : supplyData.snapshots
    return snapshots.map(s => {
      const date = new Date(s.timestamp * 1000)
      const currentSupply = parseFloat(shiftDigits(s.current_supply, -6).toString())
      const burnedSupply = parseFloat(shiftDigits(s.burned_supply, -6).toString())
      return {
        timestamp: s.timestamp,
        date: `${MONTHS[date.getMonth()]} ${date.getDate()}`,
        currentSupply: Math.round(currentSupply),
        burnedSupply: Math.round(burnedSupply),
        netSupply: Math.round(currentSupply - burnedSupply),
      }
    })
  }, [supplyData, useMockSupply])

  // Lockdrop phase
  const lockdrop = currentLockdrop?.lockdrop
  const phase = getLockdropPhase(lockdrop)

  // Acquisition metrics
  const totalDeposits = useMemo(() => {
    return deposits.reduce((sum, d) => {
      const amt = parseFloat(shiftDigits(d.amount, -6).toString())
      return sum + amt
    }, 0)
  }, [deposits])

  const depositorCount = pendingLocks?.users?.length ?? 0

  // Lockdrop timeline percentages
  const timelineSegments = useMemo(() => {
    if (!lockdrop) return null
    const total = lockdrop.withdrawal_end - lockdrop.start_time
    if (total <= 0) return null
    const depositPct = ((lockdrop.deposit_end - lockdrop.start_time) / total) * 100
    const withdrawalPct = ((lockdrop.withdrawal_end - lockdrop.deposit_end) / total) * 100
    const now = Math.floor(Date.now() / 1000)
    const progressPct = Math.min(100, Math.max(0, ((now - lockdrop.start_time) / total) * 100))
    return { depositPct, withdrawalPct, progressPct }
  }, [lockdrop])

  // Acquisition history chart data
  const historyChartData = useMemo(() => {
    if (!acquisitionHistory?.history) return []
    return acquisitionHistory.history.map(entry => {
      const date = new Date(entry.timestamp * 1000)
      return {
        timestamp: entry.timestamp,
        date: `${MONTHS[date.getMonth()]} ${date.getDate()}`,
        rate: parseFloat(entry.current_acquisition_rate),
        bumpRate: parseFloat(entry.bump_rate),
        accruedPool: parseFloat(shiftDigits(entry.accrued_pool, -6).toString()),
        utilization: parseFloat(entry.utilization) * 100, // percentage
        efficiency: entry.efficiency ? parseFloat(entry.efficiency) * 100 : null,
        newDeposits: parseFloat(shiftDigits(entry.total_new_deposits, -6).toString()),
        poolMaxed: entry.pool_maxed,
      }
    })
  }, [acquisitionHistory])

  // Current window stats
  const windowStats = useMemo(() => {
    const window = currentWindow?.window
    const state = modelState?.state
    if (!window && !state) return null

    const formatDate = (ts: number) => {
      if (!ts || ts === 0 || ts > 4_000_000_000) return 'Not set'
      const d = new Date(ts * 1000)
      return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
    }

    return {
      startTime: window ? formatDate(window.start_time) : '—',
      depositEnd: window ? formatDate(window.deposit_end) : '—',
      withdrawalEnd: window ? formatDate(window.withdrawal_end) : '—',
      totalDepositAmount: window
        ? parseFloat(shiftDigits(window.total_deposit_amount, -6).toString()).toLocaleString('en-US', { maximumFractionDigits: 0 })
        : '—',
      acquisitionBudget: window
        ? parseFloat(shiftDigits(window.acquisition_budget, -6).toString()).toLocaleString('en-US', { maximumFractionDigits: 0 })
        : '—',
      // Live model state
      currentRate: state ? parseFloat(state.current_acquisition_rate).toFixed(4) : '—',
      accruedPool: state
        ? parseFloat(shiftDigits(state.accrued_pool, -6).toString()).toLocaleString('en-US', { maximumFractionDigits: 0 })
        : '—',
      poolMaxed: state?.pool_maxed ?? false,
      bumpRate: state ? parseFloat(state.bump_rate).toFixed(4) : '—',
      depositEventCount: state?.deposit_event_count ?? '—',
      totalNewDeposits: state
        ? parseFloat(shiftDigits(state.total_new_deposits, -6).toString()).toLocaleString('en-US', { maximumFractionDigits: 0 })
        : '—',
      efficiency: state?.last_mutation_efficiency
        ? `${(parseFloat(state.last_mutation_efficiency) * 100).toFixed(1)}%`
        : '—',
      efficiencyClamped: state?.efficiency_clamped ?? false,
    }
  }, [currentWindow, modelState])

  return {
    supplyChartData,
    phase,
    totalDeposits,
    depositorCount,
    timelineSegments,
    historyChartData,
    windowStats,
    acquisitionLoading,
  }
}

export type AcquisitionDashboardData = ReturnType<typeof useAcquisitionDashboardData>
