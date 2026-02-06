import { num } from '@/helpers/num'
import { Box, Button, HStack, Image, Text, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react'
import { useBasket, useCreditRate } from '@/hooks/useCDP'
import useAppState from '@/persisted-state/useAppState'
import { useMemo, useState } from 'react'
import { BorrowRowData } from './types'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { BorrowModal } from './BorrowModal'
import { useOraclePrice } from '@/hooks/useOracle'

interface AvailableToBorrowProps {
  onBorrow?: (denom: string) => void
  positionIndex?: number
}

export const AvailableToBorrow = ({ onBorrow, positionIndex = 0 }: AvailableToBorrowProps) => {
  const { appState } = useAppState()
  const { chainName } = useChainRoute()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: creditRate } = useCreditRate()
  const { data: prices } = useOraclePrice()

  // Modal state
  const [borrowModalOpen, setBorrowModalOpen] = useState(false)
  const [selectedAsset, setSelectedAsset] = useState<{
    symbol: 'CDT' | 'USDC'
    denom: string
    logo: string
    price: number
  } | null>(null)

  // Get asset info for CDT and USDC
  const cdtAsset = useAssetBySymbol('CDT', chainName)
  const usdcAsset = useAssetBySymbol('USDC', chainName)

  // Helper to safely get denom from AssetInfo union type
  const getCdtDenom = () => {
    if (!basket?.credit_asset?.info) return cdtAsset?.base || ''
    const info = basket.credit_asset.info as any
    return info.native_token?.denom || info.token?.address || cdtAsset?.base || ''
  }

  // Available borrow assets (CDT and USDC only)
  const borrowRows = useMemo<BorrowRowData[]>(() => {
    const rows: BorrowRowData[] = []

    // Calculate CDT borrow APY from credit_interest
    const creditInterest = creditRate?.credit_interest
      ? num(creditRate.credit_interest).times(100).toNumber()
      : 0

    // CDT row - always show
    rows.push({
      symbol: 'CDT',
      logo: cdtAsset?.logo || '/images/cdt.svg',
      denom: getCdtDenom(),
      borrowApy: creditInterest,
      liquidityAvailable: -1, // -1 indicates unlimited/mintable
      liquidityUsdValue: -1,
    })

    // USDC row - this would need Mars integration or similar
    rows.push({
      symbol: 'USDC',
      logo: usdcAsset?.logo || '/images/usdc.svg',
      denom: usdcAsset?.base || '',
      borrowApy: 0, // Would need Mars integration
      liquidityAvailable: 0,
      liquidityUsdValue: 0,
    })

    return rows
  }, [basket, creditRate, cdtAsset, usdcAsset])

  // Handle borrow click
  const handleBorrowClick = (row: BorrowRowData) => {
    const assetPrice = prices?.find(p => {
      // Try to match denom
      if (p.denom === row.denom) return true
      // For CDT, might need special handling
      return false
    })?.price || 0

    setSelectedAsset({
      symbol: row.symbol as 'CDT' | 'USDC',
      denom: row.denom,
      logo: row.logo,
      price: num(assetPrice).toNumber() || (row.symbol === 'CDT' ? 1 : 1), // Default to 1 if no price
    })
    setBorrowModalOpen(true)

    // Also call the original onBorrow callback if provided
    onBorrow?.(row.denom)
  }

  return (
    <>
      <Box
        bg="rgba(10, 10, 10, 0.8)"
        borderRadius="lg"
        p={4}
        border="1px solid"
        borderColor="whiteAlpha.200"
      >
        <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
          Available to Borrow
        </Text>

        <Table variant="unstyled" size="sm">
          <Thead>
            <Tr>
              <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2}>
                Asset
              </Th>
              <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2} isNumeric>
                Borrow APY
              </Th>
              <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2} isNumeric>
                Available
              </Th>
              <Th px={2} width="100px"></Th>
            </Tr>
          </Thead>
          <Tbody>
            {borrowRows.map((row) => (
              <Tr key={row.denom || row.symbol} _hover={{ bg: 'whiteAlpha.50' }}>
                <Td px={2} py={3}>
                  <HStack spacing={2}>
                    <Image
                      src={row.logo}
                      alt={row.symbol}
                      w="24px"
                      h="24px"
                      borderRadius="full"
                      fallbackSrc="/images/default-token.svg"
                    />
                    <Text color="white" fontWeight="medium" fontSize="sm">
                      {row.symbol}
                    </Text>
                  </HStack>
                </Td>
                <Td px={2} py={3} isNumeric>
                  <Text
                    color={row.borrowApy > 0 ? 'red.400' : 'whiteAlpha.700'}
                    fontSize="sm"
                  >
                    {row.borrowApy > 0 ? `${row.borrowApy.toFixed(2)}%` : '-'}
                  </Text>
                </Td>
                <Td px={2} py={3} isNumeric>
                  <Text color="whiteAlpha.700" fontSize="sm">
                    {row.liquidityAvailable < 0 ? (
                      <Text as="span" color="cyan.400">Protocol-Issued</Text>
                    ) : row.liquidityAvailable > 0 ? (
                      `$${num(row.liquidityUsdValue).toFixed(0)}`
                    ) : (
                      'Coming Soon'
                    )}
                  </Text>
                </Td>
                <Td px={2} py={3}>
                  <Button
                    size="xs"
                    colorScheme={row.symbol === 'CDT' ? 'cyan' : 'gray'}
                    variant="solid"
                    onClick={() => handleBorrowClick(row)}
                    isDisabled={row.symbol !== 'CDT'} // Only CDT borrowing available for now
                  >
                    + Borrow
                  </Button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>

      {/* Borrow Modal */}
      {selectedAsset && (
        <BorrowModal
          isOpen={borrowModalOpen}
          onClose={() => {
            setBorrowModalOpen(false)
            setSelectedAsset(null)
          }}
          asset={selectedAsset}
          positionIndex={positionIndex}
        />
      )}
    </>
  )
}

export default AvailableToBorrow
