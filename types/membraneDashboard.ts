export interface RevenueDataPoint {
  timestamp: number
  date: string
  grossRevenue: number
  discountedRevenue: number
  netRevenue: number
}

export interface InterestRateDataPoint {
  timestamp: number
  date: string
  avgRate: number
  spikeHeight: number
  baseRate: number
}

export interface LiquidationFunnelDataPoint {
  timestamp: number
  date: string
  activated: number
  savedByDelay: number
  windowExpired: number
  windowBroken: number
}
