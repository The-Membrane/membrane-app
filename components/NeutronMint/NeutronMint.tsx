import React, { useCallback, useMemo, useState } from 'react'
import { Box, Grid, GridItem, VStack } from '@chakra-ui/react'
import { CollateralizedBundle } from './CollateralizedBundle'
import { AvailableCollateral } from './AvailableCollateral'
import { AvailableToBorrow } from './AvailableToBorrow'
import { PositionPerformanceChart } from './PositionPerformanceChart'
import { LiquidationSimulator } from './LiquidationSimulator'
import { DebtCard } from './DebtCard'
import { RepayModal } from './RepayModal'
import useVaultSummary from '../Mint/hooks/useVaultSummary'
import useMintState from '../Mint/hooks/useMintState'
import { useUserPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import { num } from '@/helpers/num'
import useWallet from '@/hooks/useWallet'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { getMockBorrowData } from './mockBorrowData'

// Set to true to use mock data for testing (position with debt)
const USE_MOCK_DATA = process.env.NODE_ENV === 'development' && true

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

  // Mock data override for development testing
  const mockData = USE_MOCK_DATA ? getMockBorrowData() : null
  const finalVaultSummary = mockData?.vaultSummary || vaultSummary
  const finalBasketPositions = mockData?.basketPositions || basketPositions
  const finalPrices = mockData?.prices || prices

  // Get position for Capital Recall calculation
  const position = useMemo<PositionResponse | undefined>(() => {
    if (!finalBasketPositions || finalBasketPositions.length === 0) return undefined
    return finalBasketPositions[0]?.positions?.[positionIndex] as PositionResponse | undefined
  }, [finalBasketPositions, positionIndex])

  // Get liquidation value from vault summary
  const liquidationValue = finalVaultSummary?.liquidValue || 0

  // Calculate collateral value from positions
  const collateralValue = useMemo(() => {
    if (!finalBasketPositions || finalBasketPositions.length === 0 || !finalPrices) {
      return 0
    }
    const positions = getPositions(finalBasketPositions, finalPrices, positionIndex, chainName) || []
    return positions.reduce((sum, p) => sum + (p?.usdValue || 0), 0)
  }, [finalBasketPositions, finalPrices, positionIndex, chainName])

  // Get LTV values from vault summary
  const liquidationLTV = finalVaultSummary?.liqudationLTV || 0
  const borrowLTV = finalVaultSummary?.borrowLTV || 0

  // Check if user has a position with collateral
  const hasPosition = useMemo(() => {
    if (!finalBasketPositions || finalBasketPositions.length === 0 || !finalPrices) {
      return false
    }
    const positions = getPositions(finalBasketPositions, finalPrices, positionIndex, chainName) || []
    return positions.length > 0 && positions.some(p => p && num(p.amount).isGreaterThan(0))
  }, [finalBasketPositions, finalPrices, positionIndex, chainName])

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

  // Repay modal state
  const [isRepayModalOpen, setIsRepayModalOpen] = useState(false)
  const [repayInitialAsset, setRepayInitialAsset] = useState<string | undefined>()

  const handleRepay = useCallback((asset: string) => {
    setRepayInitialAsset(asset)
    setIsRepayModalOpen(true)
  }, [])

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

            {/* Right Column: Debt + Available to Borrow + Liquidation Simulator */}
            <GridItem>
              <VStack spacing={6} align="stretch">
                {hasPosition && (
                  <DebtCard
                    rateSegments={mockData?.rateSegments || []}
                    pegRateSegments={mockData?.pegRateSegments || []}
                    onRepay={handleRepay}
                    currentLtv={finalVaultSummary?.ltv || 0}
                    maxBorrowLtv={borrowLTV}
                    positionIndex={positionIndex}
                  />
                )}
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

      {/* Repay Modal */}
      <RepayModal
        isOpen={isRepayModalOpen}
        onClose={() => setIsRepayModalOpen(false)}
        positionIndex={positionIndex}
        initialAsset={repayInitialAsset}
      />
    </Box>
  )
}

export default NeutronMint
