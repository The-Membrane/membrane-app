import React, { useCallback, useMemo } from 'react'
import { Box, Grid, GridItem, VStack } from '@chakra-ui/react'
import { CollateralizedBundle } from './CollateralizedBundle'
import { AvailableCollateral } from './AvailableCollateral'
import { AvailableToBorrow } from './AvailableToBorrow'
import { PositionPerformanceChart } from './PositionPerformanceChart'
import { LiquidationSimulator } from './LiquidationSimulator'
import useVaultSummary from '../Mint/hooks/useVaultSummary'
import useMintState from '../Mint/hooks/useMintState'
import { useUserPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import { num } from '@/helpers/num'
import useWallet from '@/hooks/useWallet'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'

// Hexagon background component
const HexagonBackground = () => (
  <Box
    position="fixed"
    inset={0}
    opacity={0.4}
    zIndex={0}
    pointerEvents="none"
  >
    <Box
      as="svg"
      w="100%"
      h="100%"
    >
      <defs>
        <pattern id="hexagonPatternMint" x="0" y="0" width="103.92" height="60" patternUnits="userSpaceOnUse">
          {/* Left hexagon */}
          <polygon
            points="34.64,10 51.96,20 51.96,40 34.64,50 17.32,40 17.32,20"
            fill="none"
            stroke="#6943FF"
            strokeWidth="1"
          />
          {/* Right hexagon (offset down) */}
          <polygon
            points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
            fill="none"
            stroke="#6943FF"
            strokeWidth="1"
          />
          {/* Top-right continuation for seamless tiling */}
          <polygon
            points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
            fill="none"
            stroke="#6943FF"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#hexagonPatternMint)" />
    </Box>
  </Box>
)

interface NeutronMintProps {
  positionIndex?: number
  onDeposit?: (denom: string) => void
  onManage?: (denom: string) => void
  onBorrow?: (denom: string) => void
}

export const NeutronMint: React.FC<NeutronMintProps> = ({
  positionIndex = 0,
  onDeposit,
  onManage,
  onBorrow,
}) => {
  const { mintState, setMintState } = useMintState()
  const { data: vaultSummary } = useVaultSummary({ positionNumber: positionIndex + 1 })
  const { chainName } = useChainRoute()
  const { data: prices } = useOraclePrice()
  const { data: basketPositions } = useUserPositions()
  const { address: userAddress } = useWallet()

  // Get position for Capital Recall calculation
  const position = useMemo<PositionResponse | undefined>(() => {
    if (!basketPositions || basketPositions.length === 0) return undefined
    return basketPositions[0]?.positions?.[positionIndex] as PositionResponse | undefined
  }, [basketPositions, positionIndex])

  // Get liquidation value from vault summary
  const liquidationValue = vaultSummary?.liquidValue || 0

  // Calculate collateral value from positions
  const collateralValue = useMemo(() => {
    if (!basketPositions || basketPositions.length === 0 || !prices) {
      return 0
    }
    const positions = getPositions(basketPositions, prices, positionIndex, chainName) || []
    return positions.reduce((sum, p) => sum + (p?.usdValue || 0), 0)
  }, [basketPositions, prices, positionIndex, chainName])

  // Get LTV values from vault summary
  const liquidationLTV = vaultSummary?.liqudationLTV || 0
  const borrowLTV = vaultSummary?.borrowLTV || 0

  // Check if user has a position with collateral
  const hasPosition = useMemo(() => {
    if (!basketPositions || basketPositions.length === 0 || !prices) {
      return false
    }
    const positions = getPositions(basketPositions, prices, positionIndex, chainName) || []
    return positions.length > 0 && positions.some(p => p && num(p.amount).isGreaterThan(0))
  }, [basketPositions, prices, positionIndex, chainName])

  // Default handlers if not provided
  const handleDeposit = useCallback((denom: string) => {
    if (onDeposit) {
      onDeposit(denom)
    } else {
      // Default: switch to deposit transaction type
      setMintState({ transactionType: 'deposit' })
      console.log('Deposit requested for:', denom)
    }
  }, [onDeposit, setMintState])

  const handleManage = useCallback((denom: string) => {
    if (onManage) {
      onManage(denom)
    } else {
      console.log('Manage requested for:', denom)
    }
  }, [onManage])

  const handleBorrow = useCallback((denom: string) => {
    if (onBorrow) {
      onBorrow(denom)
    } else {
      // Default: switch to mint action
      setMintState({ isTakeAction: true })
      console.log('Borrow requested for:', denom)
    }
  }, [onBorrow, setMintState])

  return (
    <Box position="relative" minH="100vh">
      {/* Hexagonal Background Grid */}
      <HexagonBackground />

      {/* Main Content */}
      <Box w="100%" maxW="1400px" mx="auto" p={4} position="relative" zIndex={1}>
        <VStack spacing={6} align="stretch">
          {/* Top Row: Performance Chart - centered */}
          <Box display="flex" justifyContent="center">
            <Box w="100%" maxW="900px">
              <PositionPerformanceChart
                positionIndex={positionIndex}
                liquidationValue={liquidationValue}
              />
            </Box>
          </Box>

          {/* Bottom Row: Two columns */}
          <Grid
            templateColumns={{ base: '1fr', lg: 'repeat(2, 1fr)' }}
            gap={6}
          >
            {/* Left Column: Collateralized Bundle (if position exists) + Available Collateral */}
            <GridItem>
              <VStack spacing={6} align="stretch">
                {hasPosition && (
                  <CollateralizedBundle
                    positionIndex={positionIndex}
                    onManage={handleManage}
                  />
                )}
                <AvailableCollateral
                  onDeposit={handleDeposit}
                />
              </VStack>
            </GridItem>

            {/* Right Column: Available to Borrow + Liquidation Simulator */}
            <GridItem>
              <VStack spacing={6} align="stretch">
                <AvailableToBorrow
                  onBorrow={handleBorrow}
                  positionIndex={positionIndex}
                />
                <LiquidationSimulator
                  collateralValue={collateralValue}
                  liquidationLTV={liquidationLTV}
                  borrowLTV={borrowLTV}
                  positionIndex={positionIndex}
                  position={position}
                  userAddress={userAddress}
                />
              </VStack>
            </GridItem>
          </Grid>
        </VStack>
      </Box>
    </Box>
  )
}

export default NeutronMint
