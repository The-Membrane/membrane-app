# Manic Looping Visualizer

## Overview

The Manic Looping product page provides a visual interface for automated USDC position fulfillment through the CDP contract. Users can see their looping position capacity and execute loop transactions with an animated funnel visualization.

## Components

### Main Component
- **ManicLooping.tsx** - Main page component that orchestrates all features

### Visual Components
- **FunnelVisualizer.tsx** - SVG funnel that displays USDC tokens and fill level
- **USDCFallingAnimation.tsx** - Framer Motion animation for USDC token dropping

### Data Layer
- **hooks/useManic.ts** - React Query hooks for data fetching
- **hooks/useFulfillIntent.ts** - Transaction execution hook
- **services/manic.ts** - Service functions for contract queries

## Features

1. **Funnel Visualization**
   - Shows USDC tokens filling a funnel based on transmuter balance / user position ratio
   - Dynamic fill level animation
   - Interactive clamp with "Loop" button at the funnel tip

2. **Metrics Cards**
   - Base APR from Mars USDC vault
   - User APR with boost percentage calculation
   - Max APR (base × 10)

3. **Transaction Execution**
   - Calls `loopCDP` function on Earn contract
   - Animated USDC token falling during transaction
   - Nuclear reactor glow effect on success

4. **Position Detection**
   - Automatically finds user's USDC-only looping position
   - Displays position ID and collateral amount
   - Shows capacity percentage

## Configuration Requirements

### Contract Addresses (config/contracts.json)

The following contract addresses need to be configured:

- `transmuter` - Currently empty, needed for USDC balance queries
- `marsUSDCvault_neutron` - Currently empty, needed for Neutron APR queries
- `earn` - Already configured (osmo1vf6e300hv2qe7r5rln8deft45ewgyytjnwfrdfcv5rgzrfy0s6cswjqf9r)
- `cdp` - Already configured (osmo1gy5gpqqlth0jpm9ydxlmff6g5mpnfvrfxd3mfc8dhyt03waumtzqt8exxr)

### APR Calculation

- **Base APR**: Queried from Mars USDC vault contract
- **User Boost**: `(debt / (collateral - debt)) × 100%`
- **User APR**: `baseAPR × (collateral / (collateral - debt))`
- **Max APR**: `baseAPR × 10`

## Usage

The page is accessible at `/[chain]/manic` and will:

1. Load transmuter USDC balance
2. Find user's USDC-only looping position
3. Calculate funnel fill ratio
4. Display APR metrics
5. Enable loop button when position and transmuter balance are available

## Notes

- Currently uses USDC denom: `ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4`
- Handles missing contract addresses gracefully with null returns
- All queries use 30-second stale time for real-time updates
- Transaction simulation validates before execution

