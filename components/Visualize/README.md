# Membrane Visualization System - Cyberpunk Mycelium Network

## Overview

A comprehensive, real-time data visualization system for the Membrane stablecoin ecosystem. Features a cyberpunk aesthetic with mycelium-inspired network flows, hex-based market representations, and dynamic event animations.

## Architecture

### Core Components

1. **GalaxyGraph** - 3D network visualization using React Three Fiber
   - Hex domes represent markets
   - Mycelium tendrils show flows between components
   - Event pulses for real-time activity
   - Interactive camera controls

2. **MarketDetailPanel** - Detailed market analytics
   - Time-series charts (Recharts)
   - Risk radar visualization
   - Event stream with real-time updates
   - Market-specific metrics

3. **GlobalTimeline** - System-wide metrics
   - CDT supply tracking
   - MBRN-at-risk monitoring
   - Liquidation cluster visualization
   - Risk metrics over time

4. **VisualizationControls** - User interface controls
   - Time range selection (1h, 24h, 7d, 30d)
   - View mode switching (Galaxy, Markets, Timeline)

### Data Flow

```
CosmWasm Client → Visualization Service → React Query Hook → Components
```

1. **Data Fetching** (`services/visualization.ts`)
   - Queries CDP contract for collateral markets
   - Queries LTV Disco for tranche data
   - Queries Transmuter for swap history
   - Aggregates events and timeline data

2. **Data Processing**
   - Converts contract data to visualization nodes
   - Calculates 3D positions for markets
   - Generates flow edges from swap/deposit data
   - Time-buckets events for time-series

3. **Real-time Updates**
   - 10-second refresh interval
   - Animated transitions for new data
   - Event pulse animations
   - Flow particle animations

## Visual Design

### Color Palette

- **Background**: Deep dark (`#0a0a0f`)
- **Primary**: BlueViolet (`#8a2be2`)
- **Secondary**: DeepSkyBlue (`#00bfff`)
- **Accent**: Magenta (`#ff00ff`)
- **Risk Colors**:
  - Low: Green (`#00ff00`)
  - Medium: Yellow (`#ffff00`)
  - High: Orange (`#ff8800`)
  - Critical: Red (`#ff0000`)

### Visual Elements

#### Hex Domes (Markets)
- Hexagonal extruded geometry
- Size based on TVL/maxLTV
- Glow intensity based on risk
- Pulse animation for recent activity
- Risk indicator rings for high-risk markets

#### Mycelium Tendrils (Flows)
- Curved tube geometry connecting markets
- Organic path variation
- Particle system for animated flows
- Intensity based on volume
- Color-coded by flow type

#### Event Pulses
- Spherical pulses at event locations
- Color-coded by event type
- Magnitude-based sizing
- Ripple effects for liquidations
- Auto-fade after 3 seconds

### Animation Rules

1. **Pulse Animation**
   - Duration: 2 seconds
   - Scale: 0.9x - 1.1x
   - Based on recent activity score

2. **Flow Animation**
   - Speed: 0.5 units/second
   - Particle count: 5-25 based on intensity
   - Continuous loop

3. **Glow Pulse**
   - Duration: 3 seconds
   - Opacity: 0.4 - 1.0
   - Based on risk level

4. **Ripple Effect** (Liquidations)
   - 3 concentric rings
   - Expand over 2 seconds
   - Fade out gradually

## Data Mapping

### Market Nodes

```typescript
{
  id: string                    // Unique identifier
  name: string                  // Display name
  type: 'collateral' | 'disco_tranche' | 'transmuter' | 'manic_loop' | 'system'
  position: [x, y, z]          // 3D coordinates
  size: number                 // Visual size (1-5)
  tvl: number                  // Total value locked
  risk: number                 // Risk score (0-1)
  ltv?: number                 // Loan-to-value ratio
  color: string                // Hex color
  glowIntensity: number        // Glow strength (0-1)
  recentActivity: number       // Activity score (0-1)
  metadata: {...}              // Additional data
}
```

### Flow Edges

```typescript
{
  id: string
  source: string               // Source market ID
  target: string               // Target market ID
  type: 'swap' | 'deposit' | 'withdraw' | 'liquidation' | 'loop' | 'revenue'
  volume: number
  intensity: number            // Visual intensity (0-1)
  color: string
  animated: boolean
  timestamp: number
  metadata: {...}
}
```

### System Events

```typescript
{
  id: string
  type: 'cdp_open' | 'cdp_repay' | 'liquidation' | 'disco_deposit' | ...
  marketId: string
  timestamp: number
  magnitude: number            // Visual intensity (0-1)
  position?: [x, y, z]
  data: {...}
}
```

## Performance Optimizations

### Level of Detail (LOD)

- **Near** (< 50 units): Full detail, all animations
- **Medium** (50-200 units): Reduced particle count, simplified geometry
- **Far** (> 200 units): Minimal rendering, static representation

### Time Bucketing

Events are grouped into time buckets based on selected range:
- 1h: 60 buckets (1 minute each)
- 24h: 24 buckets (1 hour each)
- 7d: 7 buckets (1 day each)
- 30d: 30 buckets (1 day each)

### Data Limits

- Markets: Unlimited (but typically < 50)
- Flows: Capped at 1000 per time range
- Events: Capped at 500 per time range
- Timeline points: Capped at 500

## Extensibility

### Adding New Market Types

1. Add type to `MarketNode['type']`
2. Update `getMarkets()` in `services/visualization.ts`
3. Add color mapping in `DEFAULT_VIS_CONFIG`
4. Create custom visualization component if needed

### Adding New Event Types

1. Add type to `SystemEvent['type']`
2. Update `getEvents()` in `services/visualization.ts`
3. Add color to `DEFAULT_VIS_CONFIG.colors.event`
4. Update `EventPulse` component if special visualization needed

### Adding New Flow Types

1. Add type to `FlowEdge['type']`
2. Update `getFlows()` in `services/visualization.ts`
3. Add color mapping
4. Customize `MyceliumTendril` if needed

## Usage

```tsx
import { useVisualizationData } from '@/hooks/useVisualizationData'

const { markets, flows, events, timelineData, isLoading } = 
  useVisualizationData(cosmWasmClient, '24h')
```

## Future Enhancements

1. **WebSocket Integration** - Real-time event streaming
2. **Historical Playback** - Time-travel through system history
3. **Custom Filters** - Filter by market type, risk level, etc.
4. **Export Functionality** - Export charts and data
5. **Mobile Optimization** - Touch controls for 3D view
6. **VR Support** - Immersive visualization experience

## Dependencies

- `@react-three/fiber` - 3D rendering
- `@react-three/drei` - 3D utilities
- `three` - 3D graphics library
- `recharts` - 2D charts
- `@tanstack/react-query` - Data fetching
- `@cosmjs/cosmwasm-stargate` - Blockchain queries

