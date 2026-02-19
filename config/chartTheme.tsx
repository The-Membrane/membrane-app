/**
 * Chart Theme Constants
 *
 * Standardized styling for all Recharts components across the app.
 * Ensures consistent look and feel for data visualizations.
 *
 * Usage:
 * ```tsx
 * import { CHART_THEME } from '@/config/chartTheme'
 *
 * <LineChart data={data}>
 *   <CartesianGrid {...CHART_THEME.grid} />
 *   <XAxis {...CHART_THEME.axis} />
 *   <YAxis {...CHART_THEME.axis} />
 *   <Tooltip {...CHART_THEME.tooltip} />
 *   <Legend {...CHART_THEME.legend} />
 * </LineChart>
 * ```
 */

// Color constants
const GRID_COLOR = 'rgba(111, 255, 194, 0.1)'
const AXIS_COLOR = '#F5F5F5'
const TOOLTIP_BG = 'rgba(10, 10, 10, 0.95)'
const TOOLTIP_BORDER = 'rgba(255, 255, 255, 0.2)'

/**
 * Asset colors for multi-line charts
 * Used for hypothetical comparisons, multiple assets, etc.
 */
export const ASSET_COLORS = [
  '#22d3ee', // cyan
  '#a78bfa', // purple
  '#34d399', // green
  '#fb923c', // orange
  '#f472b6', // pink
  '#60a5fa', // blue
  '#fbbf24', // yellow
  '#f87171', // red
] as const

/**
 * Chart component theme configuration
 */
export const CHART_THEME = {
  /**
   * CartesianGrid styling
   */
  grid: {
    stroke: GRID_COLOR,
    strokeDasharray: '3 3' as const,
    strokeOpacity: 1,
  },

  /**
   * XAxis and YAxis common styling
   */
  axis: {
    stroke: AXIS_COLOR,
    strokeOpacity: 0.6,
    tick: {
      fill: AXIS_COLOR,
      fontSize: 10,
    },
    axisLine: {
      stroke: AXIS_COLOR,
      strokeOpacity: 0.6,
    },
  },

  /**
   * XAxis specific config
   */
  xAxis: {
    stroke: AXIS_COLOR,
    strokeOpacity: 0.6,
    tick: { fill: AXIS_COLOR, fontSize: 10 },
    interval: 'preserveStartEnd' as const,
  },

  /**
   * YAxis specific config
   */
  yAxis: {
    stroke: AXIS_COLOR,
    strokeOpacity: 0.6,
    tick: { fill: AXIS_COLOR, fontSize: 10 },
  },

  /**
   * Tooltip styling
   */
  tooltip: {
    contentStyle: {
      backgroundColor: TOOLTIP_BG,
      border: `1px solid ${TOOLTIP_BORDER}`,
      borderRadius: '8px',
      color: AXIS_COLOR,
    },
    cursor: {
      stroke: 'rgba(255, 255, 255, 0.1)',
      strokeWidth: 1,
    },
  },

  /**
   * Legend styling
   */
  legend: {
    wrapperStyle: {
      fontSize: 12,
      color: 'rgba(255, 255, 255, 0.8)',
    },
    iconType: 'line' as const,
  },

  /**
   * Line chart specific
   */
  line: {
    strokeWidth: 2,
    dot: false,
    activeDot: { r: 5 },
  },

  /**
   * Area chart specific
   */
  area: {
    strokeWidth: 2,
    fillOpacity: 0.3,
    dot: false,
    activeDot: { r: 5 },
  },

  /**
   * Bar chart specific
   */
  bar: {
    radius: [4, 4, 0, 0] as [number, number, number, number],
  },
} as const

/**
 * Helper function to create custom legend with white text and colored indicators
 *
 * @example
 * ```tsx
 * <Legend content={createCustomLegend()} />
 * ```
 */
export const createCustomLegend = (labelTransform?: (value: string) => string) => {
  return (props: any) => {
    const { payload } = props
    if (!payload || payload.length === 0) return null

    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: '20px',
          marginTop: '10px',
          flexWrap: 'wrap',
        }}
      >
        {payload.map((entry: any, index: number) => {
          const displayName = labelTransform ? labelTransform(entry.value) : entry.value

          return (
            <div
              key={`legend-${index}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              {/* Color indicator */}
              <svg width="20" height="2">
                <line
                  x1="0"
                  y1="1"
                  x2="20"
                  y2="1"
                  stroke={entry.color}
                  strokeWidth="2"
                  strokeDasharray={entry.strokeDasharray || '0'}
                />
              </svg>
              {/* White text label */}
              <span style={{ color: 'rgba(255, 255, 255, 0.8)', fontSize: '12px' }}>
                {displayName}
              </span>
            </div>
          )
        })}
      </div>
    )
  }
}

/**
 * Common chart dimensions
 */
export const CHART_DIMENSIONS = {
  heights: {
    sm: 200,
    md: 300,
    lg: 400,
    xl: 500,
  },
  margins: {
    default: { top: 5, right: 5, left: 5, bottom: 5 },
    withLegend: { top: 5, right: 5, left: 5, bottom: 30 },
  },
} as const

/**
 * Reference line styling (e.g., liquidation lines)
 */
export const REFERENCE_STYLES = {
  liquidation: {
    stroke: '#ef4444',
    strokeWidth: 2,
    strokeDasharray: '5 5',
    label: {
      fill: '#ef4444',
      fontSize: 10,
      position: 'right' as const,
    },
  },
  target: {
    stroke: '#22d3ee',
    strokeWidth: 1,
    strokeDasharray: '3 3',
    label: {
      fill: '#22d3ee',
      fontSize: 10,
      position: 'right' as const,
    },
  },
} as const

export default CHART_THEME
