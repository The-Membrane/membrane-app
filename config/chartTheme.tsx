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

// Color constants — Living Typeface palette (bone on near-black, phosphor accent).
const GRID_COLOR = 'rgba(236, 230, 216, 0.08)' // faint bone grid (bespoke opacity, not in the shared hairline set — left as literal)
const AXIS_COLOR = 'var(--m-text-primary)'      // bone ink
const TOOLTIP_BG = 'var(--m-bg-secondary)'      // card surface
const TOOLTIP_BORDER = 'var(--m-border-strong)' // strong hairline

/**
 * Asset colors for multi-line charts
 * Used for hypothetical comparisons, multiple assets, etc.
 * Living Typeface series palette: phosphor, cyber teal, gold, blood, bone-dim,
 * moss-dark — an organic/machine spectrum, no purple/cyan.
 */
// 8-entry tuple: kept at length 8 because consumers index ASSET_COLORS[6]/[7]
// directly (the `as const` tuple length is load-bearing). All on the Living
// Typeface organic/machine spectrum — no purple/cyan.
export const ASSET_COLORS = [
  'var(--m-primary)', // phosphor green
  'var(--m-secondary)', // cyber teal
  'var(--m-warning)', // gold
  'var(--m-danger)', // blood red
  'var(--m-text-secondary)', // bone dim
  '#4a8636', // moss dark — bespoke series tint, not in the shared palette; left literal
  '#c8e89a', // pale phosphor — bespoke series tint, not in the shared palette; left literal
  '#e0c877', // pale gold — bespoke series tint, not in the shared palette; left literal
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
      borderRadius: '0px', // sharp corners
      color: AXIS_COLOR,
    },
    cursor: {
      stroke: 'var(--m-border-subtle)',
      strokeWidth: 1,
    },
  },

  /**
   * Legend styling
   */
  legend: {
    wrapperStyle: {
      fontSize: 12,
      color: 'var(--m-text-secondary)',
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
    radius: [0, 0, 0, 0] as [number, number, number, number], // sharp corners
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
        {payload.map((entry: any) => {
          const displayName = labelTransform ? labelTransform(entry.value) : entry.value

          return (
            <div
              key={entry.dataKey ?? entry.value}
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
              {/* Bone-dim text label */}
              <span style={{ color: 'var(--m-text-secondary)', fontSize: '12px' }}>
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
    stroke: 'var(--m-danger)', // blood red, dashed
    strokeWidth: 2,
    strokeDasharray: '5 5',
    label: {
      fill: 'var(--m-danger)',
      fontSize: 10,
      position: 'right' as const,
    },
  },
  target: {
    stroke: 'var(--m-success)', // phosphor green
    strokeWidth: 1,
    strokeDasharray: '3 3',
    label: {
      fill: 'var(--m-success)',
      fontSize: 10,
      position: 'right' as const,
    },
  },
} as const

export default CHART_THEME
