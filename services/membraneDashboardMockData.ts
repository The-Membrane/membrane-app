import {
  RevenueDataPoint,
  InterestRateDataPoint,
  LiquidationFunnelDataPoint,
} from '@/types/membraneDashboard'

const DAY = 86400
const WEEK = DAY * 7
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const formatDate = (ts: number): string => {
  const d = new Date(ts * 1000)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/**
 * ~90 days of revenue data.
 * Gross revenue accumulates 500-2000 CDT/day with sine variance.
 * Global discount is ~5%, so net = gross * 0.95.
 */
export const MOCK_REVENUE_DATA: RevenueDataPoint[] = (() => {
  const now = Math.floor(Date.now() / 1000)
  const entries: RevenueDataPoint[] = []
  let cumulativeGross = 0
  let cumulativeDiscount = 0

  for (let i = 90; i >= 0; i--) {
    const ts = now - i * DAY
    const dayIndex = 90 - i
    const dailyGross = 800 + 600 * Math.sin(dayIndex * 0.15) + Math.random() * 400
    cumulativeGross += dailyGross
    const dailyDiscount = dailyGross * 0.05
    cumulativeDiscount += dailyDiscount

    entries.push({
      timestamp: ts,
      date: formatDate(ts),
      grossRevenue: Math.round(cumulativeGross),
      discountedRevenue: Math.round(cumulativeDiscount),
      netRevenue: Math.round(cumulativeGross - cumulativeDiscount),
    })
  }
  return entries
})()

/**
 * ~90 days of interest rate data.
 * Average rate oscillates 3-8%. Spike heights are mostly 0-2%
 * with occasional spikes of 5-12% every ~15 days.
 * Base rate stays around 3%.
 */
export const MOCK_RATE_DATA: InterestRateDataPoint[] = (() => {
  const now = Math.floor(Date.now() / 1000)
  const entries: InterestRateDataPoint[] = []

  for (let i = 90; i >= 0; i--) {
    const ts = now - i * DAY
    const dayIndex = 90 - i
    const baseRate = 3.0
    const avgRate = 4.5 + 2.0 * Math.sin(dayIndex * 0.08) + Math.random() * 0.5

    // Spikes happen roughly every 15 days
    const isSpike = dayIndex % 15 < 2 && dayIndex > 0
    const spikeHeight = isSpike
      ? 5 + Math.random() * 7 // 5-12% spike
      : Math.random() * 2     // 0-2% normal variation

    entries.push({
      timestamp: ts,
      date: formatDate(ts),
      avgRate: parseFloat(avgRate.toFixed(2)),
      spikeHeight: parseFloat(spikeHeight.toFixed(2)),
      baseRate,
    })
  }
  return entries
})()

/**
 * 12 weekly liquidation funnel buckets.
 * Parts always sum to activated total.
 * savedByDelay is 40-70% (the protocol USP), windowExpired 10-25%, windowBroken 5-20%.
 */
export const MOCK_LIQUIDATION_DATA: LiquidationFunnelDataPoint[] = (() => {
  const now = Math.floor(Date.now() / 1000)
  const entries: LiquidationFunnelDataPoint[] = []

  for (let w = 11; w >= 0; w--) {
    const ts = now - w * WEEK
    const weekLabel = `W${12 - w}`
    const activated = Math.floor(18 + Math.random() * 22) // 18-40

    const savedPct = 0.4 + Math.random() * 0.3       // 40-70%
    const expiredPct = 0.1 + Math.random() * 0.15     // 10-25%
    // windowBroken gets the remainder
    const brokenPct = 1 - savedPct - expiredPct

    const savedByDelay = Math.round(activated * savedPct)
    const windowExpired = Math.round(activated * expiredPct)
    const windowBroken = activated - savedByDelay - windowExpired // remainder ensures sum = activated

    entries.push({
      timestamp: ts,
      date: weekLabel,
      activated,
      savedByDelay,
      windowExpired,
      windowBroken,
    })
  }
  return entries
})()
