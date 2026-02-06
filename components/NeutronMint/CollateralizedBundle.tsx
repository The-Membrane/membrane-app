import { num } from '@/helpers/num'
import { Box, Button, HStack, Image, Stack, Text, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react'
import { useBasket, useUserPositions, useBasketAssets, useRates } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import useAppState from '@/persisted-state/useAppState'
import { useMemo } from 'react'
import { CollateralRowData, getSymbolFromDenom, getLogoFromSymbol } from './types'

interface CollateralizedBundleProps {
  positionIndex?: number
  onManage?: (denom: string) => void
}

export const CollateralizedBundle = ({
  positionIndex = 0,
  onManage
}: CollateralizedBundleProps) => {
  const { chainName } = useChainRoute()
  const { appState } = useAppState()
  const { data: prices } = useOraclePrice()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: rates } = useRates(appState.rpcUrl)
  const { data: basketAssets } = useBasketAssets()

  // Get user's deposited collateral
  const collateralRows = useMemo<CollateralRowData[]>(() => {
    if (!basketPositions || basketPositions.length === 0 || !prices || !basket) {
      return []
    }

    const positions = getPositions(basketPositions, prices, positionIndex, chainName)
    if (!positions || positions.length === 0) return []

    return positions
      .filter(position => position && num(position.amount).isGreaterThan(0))
      .map(position => {
        const symbol = position.symbol || getSymbolFromDenom(position.denom, basket)
        const logo = position.logo || getLogoFromSymbol(symbol)
        const priceRaw = prices?.find(p => p.denom === position.denom)?.price || 0
        const price = num(priceRaw).toNumber()

        // Find APY from rates store's lastest_collateral_rates
        const collateralIndex = basket.collateral_types?.findIndex(
          (c: any) => c.asset?.info?.native_token?.denom === position.denom
        )
        const rate = collateralIndex >= 0
          ? rates?.lastest_collateral_rates?.[collateralIndex]?.rate
          : null
        const apy = rate ? num(rate).times(100).toNumber() : 0

        // Find max LTV from basket assets
        const basketAsset = basketAssets?.find(ba => ba.asset?.base === position.denom)
        const maxLTV = basketAsset?.maxLTV || 0
        const maxBorrowLTV = basketAsset?.maxBorrowLTV || 0

        return {
          symbol,
          logo,
          denom: position.denom,
          apy,
          depositAmount: position.amount || 0,
          depositUsdValue: position.usdValue || 0,
          price,
          maxLTV,
          maxBorrowLTV,
          isDeposited: true,
        }
      })
  }, [basketPositions, prices, basket, basketAssets, positionIndex, chainName])

  // Calculate totals
  const totalDepositsUsd = useMemo(() => {
    return collateralRows.reduce((acc, row) => acc + row.depositUsdValue, 0)
  }, [collateralRows])

  if (collateralRows.length === 0) {
    return (
      <Box
        bg="rgba(10, 10, 10, 0.8)"
        borderRadius="lg"
        p={4}
        border="1px solid"
        borderColor="whiteAlpha.200"
      >
        <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
          Collateralized Bundle
        </Text>
        <Text color="whiteAlpha.600" textAlign="center" py={8}>
          No collateral deposited. Deposit assets to get started.
        </Text>
      </Box>
    )
  }

  return (
    <Box
      bg="rgba(10, 10, 10, 0.8)"
      borderRadius="lg"
      p={4}
      border="1px solid"
      borderColor="whiteAlpha.200"
    >
      <HStack justifyContent="space-between" mb={4}>
        <Text fontSize="lg" fontWeight="bold" color="white">
          Collateralized Bundle
        </Text>
        <Text fontSize="sm" color="whiteAlpha.700">
          ${num(totalDepositsUsd).toFixed(2)}
        </Text>
      </HStack>

      <Table variant="unstyled" size="sm">
        <Thead>
          <Tr>
            <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2}>
              Asset
            </Th>
            <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2} isNumeric>
              APY
            </Th>
            <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2} isNumeric>
              Your Deposits
            </Th>
            <Th px={2} width="80px"></Th>
          </Tr>
        </Thead>
        <Tbody>
          {collateralRows.map((row) => (
            <Tr key={row.denom} _hover={{ bg: 'whiteAlpha.50' }}>
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
                  <Stack spacing={0}>
                    <Text color="white" fontWeight="medium" fontSize="sm">
                      {row.symbol}
                    </Text>
                    <Text color="whiteAlpha.500" fontSize="xs">
                      ${num(row.price).toFixed(2)}
                    </Text>
                  </Stack>
                </HStack>
              </Td>
              <Td px={2} py={3} isNumeric>
                <Text
                  color={row.apy > 0 ? 'green.400' : 'whiteAlpha.700'}
                  fontSize="sm"
                >
                  {row.apy > 0 ? `${row.apy.toFixed(2)}%` : '-'}
                </Text>
              </Td>
              <Td px={2} py={3} isNumeric>
                <Stack spacing={0} alignItems="flex-end">
                  <Text color="white" fontSize="sm">
                    {num(row.depositAmount).toFixed(4)}
                  </Text>
                  <Text color="whiteAlpha.500" fontSize="xs">
                    ${num(row.depositUsdValue).toFixed(2)}
                  </Text>
                </Stack>
              </Td>
              <Td px={2} py={3}>
                <Button
                  size="xs"
                  variant="outline"
                  colorScheme="cyan"
                  onClick={() => onManage?.(row.denom)}
                >
                  Manage
                </Button>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </Box>
  )
}

export default CollateralizedBundle
