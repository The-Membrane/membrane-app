import { useEffect, useRef } from 'react'

export interface PerformanceMetrics {
  domContentLoaded: number
  loadComplete: number
  firstPaint: number | null
  firstContentfulPaint: number | null
  timeToInteractive: number | null
  timestamp: number
}

let baselineMetrics: PerformanceMetrics | null = null

export const usePerformanceMetrics = (logToConsole = true) => {
  const hasMeasured = useRef(false)

  useEffect(() => {
    if (hasMeasured.current || typeof window === 'undefined') return
    hasMeasured.current = true

    const measurePerformance = () => {
      const perfData = (window as any).performance.timing
      const navigation = (window as any).performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming

      const metrics: PerformanceMetrics = {
        domContentLoaded: perfData.domContentLoadedEventEnd - perfData.navigationStart,
        loadComplete: perfData.loadEventEnd - perfData.navigationStart,
        firstPaint: null,
        firstContentfulPaint: null,
        timeToInteractive: null,
        timestamp: Date.now(),
      }

      // Try to get paint entries - they may not be available immediately
      try {
        const paintEntries = performance.getEntriesByType('paint') as PerformancePaintTiming[]
        paintEntries.forEach((entry) => {
          if (entry.name === 'first-paint') {
            metrics.firstPaint = Math.round(entry.startTime)
          }
          if (entry.name === 'first-contentful-paint') {
            metrics.firstContentfulPaint = Math.round(entry.startTime)
          }
        })
      } catch (e) {
        // Paint entries not available
      }

      // Try to get TTI from navigation timing
      if (navigation) {
        // Use domInteractive as a proxy for TTI if interactive is not available
        metrics.timeToInteractive = navigation.interactive > 0 
          ? Math.round(navigation.interactive) 
          : (perfData.domInteractive - perfData.navigationStart)
      } else {
        // Fallback to legacy timing API
        metrics.timeToInteractive = perfData.domInteractive - perfData.navigationStart
      }

      if (logToConsole) {
        const isBaseline = !baselineMetrics
        const prefix = isBaseline ? '=== BASELINE' : '=== CURRENT'
        
        console.log(`${prefix} LOAD TIME METRICS ===`)
        console.log('DOM Content Loaded:', metrics.domContentLoaded, 'ms')
        console.log('First Paint:', metrics.firstPaint ? metrics.firstPaint + ' ms' : 'N/A')
        console.log('First Contentful Paint:', metrics.firstContentfulPaint ? metrics.firstContentfulPaint + ' ms' : 'N/A')
        console.log('Time to Interactive:', metrics.timeToInteractive ? metrics.timeToInteractive + ' ms' : 'N/A')
        console.log('Full Load Time:', metrics.loadComplete, 'ms')
        
        if (baselineMetrics) {
          const delta = {
            domContentLoaded: metrics.domContentLoaded - baselineMetrics.domContentLoaded,
            firstPaint: metrics.firstPaint && baselineMetrics.firstPaint 
              ? metrics.firstPaint - baselineMetrics.firstPaint 
              : null,
            firstContentfulPaint: metrics.firstContentfulPaint && baselineMetrics.firstContentfulPaint
              ? metrics.firstContentfulPaint - baselineMetrics.firstContentfulPaint
              : null,
            timeToInteractive: metrics.timeToInteractive && baselineMetrics.timeToInteractive
              ? metrics.timeToInteractive - baselineMetrics.timeToInteractive
              : null,
            loadComplete: metrics.loadComplete - baselineMetrics.loadComplete,
          }
          
          console.log('=== DELTA (Current - Baseline) ===')
          console.log('DOM Content Loaded:', delta.domContentLoaded > 0 ? '+' : '', delta.domContentLoaded, 'ms')
          console.log('First Paint:', delta.firstPaint !== null ? (delta.firstPaint > 0 ? '+' : '') + delta.firstPaint + ' ms' : 'N/A')
          console.log('First Contentful Paint:', delta.firstContentfulPaint !== null ? (delta.firstContentfulPaint > 0 ? '+' : '') + delta.firstContentfulPaint + ' ms' : 'N/A')
          console.log('Time to Interactive:', delta.timeToInteractive !== null ? (delta.timeToInteractive > 0 ? '+' : '') + delta.timeToInteractive + ' ms' : 'N/A')
          console.log('Full Load Time:', delta.loadComplete > 0 ? '+' : '', delta.loadComplete, 'ms')
          console.log('==================================')
        } else {
          baselineMetrics = { ...metrics }
        }
      }

      return metrics
    }

    // Measure after page load
    if (document.readyState === 'complete') {
      setTimeout(measurePerformance, 0)
    } else {
      window.addEventListener('load', () => {
        setTimeout(measurePerformance, 0)
      })
    }
  }, [logToConsole])
}

export const getBaselineMetrics = () => baselineMetrics
export const resetBaseline = () => {
  baselineMetrics = null
}

