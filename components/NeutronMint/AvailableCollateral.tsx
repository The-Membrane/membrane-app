import { num } from '@/helpers/num'
import { shiftDigits } from '@/helpers/math'
import { Box, Button, HStack, Image, Stack, Text, Table, Thead, Tbody, Tr, Th, Td, Tooltip, Collapse, Icon, VStack } from '@chakra-ui/react'
import { useBasket, useBasketAssets, useRates } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import useAppState from '@/persisted-state/useAppState'
import { Fragment, useMemo, useState } from 'react'
import { CollateralRowData, getSymbolFromDenom, getLogoFromSymbol } from './types'
import { getMockCollateralData, USE_MOCK_COLLATERAL_DATA, mockHistoricalLTVData } from './mockCollateralData'
import { ChevronDownIcon, ChevronUpIcon, InfoIcon } from '@chakra-ui/icons'
import { Card } from '@/components/ui/Card'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { DepositModal } from './DepositModal'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from 'recharts'

const formatTimeUntil = (shiftTimestamp: number): string => {
  const nowSec = Math.floor(Date.now() / 1000)
  const diffSec = shiftTimestamp - nowSec
  if (diffSec <= 0) return 'Imminent'
  const hours = diffSec / 3600
  if (hours < 1) return `${Math.ceil(diffSec / 60)}m`
  if (hours < 24) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

const LTVChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <Box bg="rgba(10,10,10,0.95)" border="1px solid" borderColor="whiteAlpha.200" borderRadius="md" px={2} py={1}>
      <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
        {new Date(label * 1000).toLocaleDateString()}
      </Text>
      <Text fontSize={TYPOGRAPHY.small} color="white" fontWeight={TYPOGRAPHY.medium}>
        {payload[0].value.toFixed(2)}%
      </Text>
    </Box>
  )
}

interface AvailableCollateralProps {
  positionIndex?: number
}

export const AvailableCollateral = ({ positionIndex = 0 }: AvailableCollateralProps) => {
  const { appState } = useAppState()
  const { data: prices } = useOraclePrice()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: rates } = useRates(appState.rpcUrl)
  const { data: basketAssets } = useBasketAssets()

  // Track expanded rows
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  // Deposit modal state
  const [depositModalOpen, setDepositModalOpen] = useState(false)
  const [selectedDenom, setSelectedDenom] = useState<string>('')

  // Format large numbers with K/M suffix
  const formatLargeNumber = (value: number): string => {
    if (value >= 1000000) {
      const millions = value / 1000000
      return `$${millions.toFixed(millions >= 10 ? 1 : 2)}M`
    } else if (value >= 1000) {
      const thousands = value / 1000
      return `$${thousands.toFixed(thousands >= 10 ? 0 : 1)}K`
    } else {
      return `$${value.toFixed(0)}`
    }
  }

  // Mock data for testing supply caps
  const mockData = USE_MOCK_COLLATERAL_DATA ? getMockCollateralData() : null
  const basketData = mockData?.basket || basket
  const pricesData = mockData?.prices || prices
  const basketAssetsData = mockData?.basketAssets || basketAssets

  const toggleRow = (denom: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(denom)) {
        next.delete(denom)
      } else {
        next.add(denom)
      }
      return next
    })
  }

  // Get available collateral from basket
  const collateralRows = useMemo<CollateralRowData[]>(() => {
    if (!basketData || !basketAssetsData || !pricesData) return []

    return basketAssetsData
      .filter(ba => {
        // Filter out assets with zero supply cap
        const supplyCapRatio = num(ba.supplyCapRatio || 0)
        return supplyCapRatio.isGreaterThan(0)
      })
      .map((basketAsset, index) => {
        const denom = basketAsset.asset?.base || ''
        const symbol = basketAsset.asset?.symbol || getSymbolFromDenom(denom, basketData)
        const logo = basketAsset.asset?.logo || getLogoFromSymbol(symbol)
        const priceRaw = pricesData?.find(p => p.denom === denom)?.price || 0
        const price = num(priceRaw).toNumber()

        // Get APY from rates store's lastest_collateral_rates
        const rate = rates?.lastest_collateral_rates?.[index]?.rate
        const apy = rate ? num(rate).times(100).toNumber() : 0

        // Get supply cap info
        const supplyCap = basketData.collateral_supply_caps?.[index]
        const currentSupply = supplyCap
          ? shiftDigits(supplyCap.current_supply, -(basketAsset.asset?.decimal || 6)).toNumber()
          : 0
        const supplyCapRatio = num(supplyCap?.supply_cap_ratio || 0).toNumber()

        // Calculate if supply cap is reached
        // Supply cap check: current_supply / (current_supply + debt_total) >= supply_cap_ratio
        const currentSupplyAmount = supplyCap?.current_supply
          ? shiftDigits(supplyCap.current_supply, -(basketAsset.asset?.decimal || 6)).toNumber()
          : 0
        const debtTotalAmount = supplyCap?.debt_total
          ? shiftDigits(supplyCap.debt_total, -6).toNumber()
          : 0

        const totalValue = currentSupplyAmount + debtTotalAmount
        const currentRatio = totalValue > 0 ? currentSupplyAmount / totalValue : 0
        const isSupplyCapReached = supplyCapRatio > 0 && currentRatio >= supplyCapRatio

        return {
          symbol,
          logo,
          subtext: basketAsset.asset?.description,
          denom,
          apy,
          depositAmount: currentSupply,
          depositUsdValue: num(currentSupply).times(price).toNumber(),
          price,
          maxLTV: basketAsset.maxLTV,
          maxBorrowLTV: basketAsset.maxBorrowLTV,
          supplyCap: supplyCap,
          isDeposited: false,
          isSupplyCapReached,
          currentRatio,
        }
      })
  }, [basketData, basketAssetsData, pricesData, rates])

  // Selected asset for deposit modal
  const selectedAsset = useMemo(() => {
    const row = collateralRows.find(r => r.denom === selectedDenom)
    if (!row) return null
    return {
      symbol: row.symbol,
      denom: row.denom,
      logo: row.logo,
      price: row.price,
    }
  }, [collateralRows, selectedDenom])

  if (collateralRows.length === 0) {
    return (
      <Card p={4}>
        <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
          Available Collateral
        </Text>
        <Text color="whiteAlpha.600" textAlign="center" py={8}>
          Loading available collateral...
        </Text>
      </Card>
    )
  }

  return (
  <>
    <Card p={4}>
      <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
        Available Collateral
      </Text>

      <Table variant="unstyled" size="sm">
        <Thead>
          <Tr>
            <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2}>
              Asset
            </Th>
            <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2}>
              <HStack spacing={1}>
                <Text>Deposits / Cap</Text>
                <Tooltip
                  label="Current deposits vs maximum allowed."
                  placement="top"
                  hasArrow
                >
                  <InfoIcon w={3} h={3} color="whiteAlpha.500" cursor="help" />
                </Tooltip>
              </HStack>
            </Th>
            <Th px={2} width="120px"></Th>
          </Tr>
        </Thead>
        <Tbody>
          {collateralRows.map((row) => {
            const supplyCapRatio = num(row.supplyCap?.supply_cap_ratio || 0).toNumber()
            const isExpanded = expandedRows.has(row.denom)

            // Calculate actual supply usage percentage based on current ratio vs cap
            const supplyUsagePercent = supplyCapRatio > 0 && row.currentRatio !== undefined
              ? Math.min((row.currentRatio / supplyCapRatio) * 100, 100)
              : 0

            const isSupplyCapReached = row.isSupplyCapReached || false

            // Calculate actual dollar values
            // Current deposits are already in row.depositAmount (properly shifted)
            const currentUsdValue = row.depositUsdValue

            // Calculate max allowed supply using the formula:
            // At cap: current_supply / (current_supply + debt_total) = supply_cap_ratio
            // So max_supply = (supply_cap_ratio * debt_total) / (1 - supply_cap_ratio)
            const debtTotalAmount = row.supplyCap?.debt_total
              ? shiftDigits(row.supplyCap.debt_total, -6).toNumber()
              : 0

            const maxSupplyAllowed = supplyCapRatio > 0 && supplyCapRatio < 1
              ? (supplyCapRatio * debtTotalAmount) / (1 - supplyCapRatio)
              : row.depositAmount

            const maxCapUsdValue = num(maxSupplyAllowed).times(row.price).toNumber()

            return (
              <Fragment key={row.denom}>
                <Tr
                  _hover={{ bg: 'whiteAlpha.50' }}
                  opacity={isSupplyCapReached ? 0.7 : 1}
                >
                  <Td px={2} py={3}>
                    <HStack spacing={2}>
                      <Image
                        src={row.logo}
                        alt={row.symbol}
                        w="24px"
                        h="24px"
                        borderRadius="full"
                        fallbackSrc="/images/default-token.svg"
                        opacity={isSupplyCapReached ? 0.5 : 1}
                      />
                      <Stack spacing={0}>
                        <HStack spacing={2}>
                          <Text
                            color="white"
                            fontWeight="medium"
                            fontSize="sm"
                          >
                            {row.symbol}
                          </Text>
                          {isSupplyCapReached && (
                            <Text color="red.400" fontSize="xs" fontWeight="bold">
                              (CAP REACHED)
                            </Text>
                          )}
                        </HStack>
                        <Text color="whiteAlpha.500" fontSize="xs">
                          Max LTV: {num(row.maxBorrowLTV).times(100).toFixed(0)}%
                        </Text>
                      </Stack>
                    </HStack>
                  </Td>
                  <Td px={2} py={3}>
                    {supplyCapRatio > 0 ? (
                      <ProgressBar
                        value={currentUsdValue}
                        maxValue={maxCapUsdValue}
                        formatValue={formatLargeNumber}
                        size="sm"
                      />
                    ) : (
                      <Text
                        color="white"
                        fontSize="sm"
                        fontWeight="medium"
                      >
                        {formatLargeNumber(row.depositUsdValue)}
                      </Text>
                    )}
                  </Td>
                  <Td px={2} py={3}>
                    <HStack spacing={2} justify="flex-end">
                      <Tooltip
                        label="Supply cap reached - deposits to positions with debt are disabled"
                        isDisabled={!isSupplyCapReached}
                        placement="top"
                        hasArrow
                      >
                        <Button
                          size="xs"
                          colorScheme="purple"
                          variant="outline"
                          onClick={() => { setSelectedDenom(row.denom); setDepositModalOpen(true) }}
                          isDisabled={isSupplyCapReached}
                          cursor={isSupplyCapReached ? 'not-allowed' : 'pointer'}
                          borderColor={isSupplyCapReached ? 'rgba(215, 80, 80, 0.3)' : 'purple.400'}
                          color={isSupplyCapReached ? 'whiteAlpha.400' : 'purple.300'}
                          _hover={!isSupplyCapReached ? {
                            bg: 'purple.500',
                            color: 'white',
                            borderColor: 'purple.500'
                          } : undefined}
                        >
                          {isSupplyCapReached ? 'Full' : 'Deposit'}
                        </Button>
                      </Tooltip>
                      <Icon
                        as={isExpanded ? ChevronUpIcon : ChevronDownIcon}
                        color="whiteAlpha.600"
                        w={5}
                        h={5}
                        cursor="pointer"
                        onClick={() => toggleRow(row.denom)}
                        _hover={{ color: 'whiteAlpha.800' }}
                      />
                    </HStack>
                  </Td>
                </Tr>
                {/* Expanded row content */}
                <Tr key={`${row.denom}-expanded`}>
                  <Td colSpan={3} p={0}>
                    <Collapse in={isExpanded} animateOpacity>
                      <Box
                        p={3}
                        bg="rgba(0, 0, 0, 0.3)"
                        borderLeft="2px solid"
                        borderColor="cyan.500"
                      >
                        <VStack spacing={3} align="stretch">
                          {/* Stats Row */}
                          {(() => {
                            const ltvData = mockHistoricalLTVData[row.denom]
                            return (
                              <HStack spacing={6} justify="space-around" align="flex-start">
                                <Stack spacing={0} align="center">
                                  <Text color={SEMANTIC_COLORS.textTertiary} fontSize={TYPOGRAPHY.xs}>
                                    Liquidation LTV
                                  </Text>
                                  <Text color="white" fontSize={TYPOGRAPHY.small} fontWeight={TYPOGRAPHY.bold}>
                                    {num(row.maxLTV || 0).times(100).toFixed(1)}%
                                  </Text>
                                </Stack>
                                <Stack spacing={0} align="center">
                                  <Text color={SEMANTIC_COLORS.textTertiary} fontSize={TYPOGRAPHY.xs}>
                                    Target LTV
                                  </Text>
                                  <Text color={SEMANTIC_COLORS.success} fontSize={TYPOGRAPHY.small} fontWeight={TYPOGRAPHY.bold}>
                                    {ltvData ? `${ltvData.pendingLTV.toFixed(1)}%` : `${num(row.maxBorrowLTV || 0).times(100).toFixed(1)}%`}
                                  </Text>
                                  {ltvData && (
                                    <Text color={SEMANTIC_COLORS.textTertiary} fontSize={TYPOGRAPHY.xs}>
                                      in {formatTimeUntil(ltvData.shiftTime)}
                                    </Text>
                                  )}
                                </Stack>
                                <Stack spacing={0} align="center">
                                  <Text color={SEMANTIC_COLORS.textTertiary} fontSize={TYPOGRAPHY.xs}>
                                    Oracle Price
                                  </Text>
                                  <Text color="white" fontSize={TYPOGRAPHY.small} fontWeight={TYPOGRAPHY.bold}>
                                    ${row.price.toFixed(2)}
                                  </Text>
                                </Stack>
                              </HStack>
                            )
                          })()}

                          {/* Historical LTV Chart */}
                          {(() => {
                            const ltvData = mockHistoricalLTVData[row.denom]
                            if (!ltvData) return null
                            const chartData = ltvData.historicalSnapshots
                            const maxLTV = num(row.maxLTV || 0).times(100).toNumber()

                            return (
                              <Box h="140px" bg="rgba(0, 0, 0, 0.2)" borderRadius="md" border="1px solid" borderColor="whiteAlpha.200" pt={2}>
                                <ResponsiveContainer width="100%" height="100%">
                                  <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                    <XAxis
                                      dataKey="timestamp"
                                      tickFormatter={(ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                      tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                                      axisLine={false}
                                      tickLine={false}
                                      minTickGap={40}
                                    />
                                    <YAxis
                                      domain={[(dataMin: number) => Math.floor(dataMin - 5), (dataMax: number) => Math.ceil(dataMax + 5)]}
                                      tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10 }}
                                      axisLine={false}
                                      tickLine={false}
                                      tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                                      width={50}
                                    />
                                    <RechartsTooltip content={<LTVChartTooltip />} />
                                    {/* Liquidation LTV reference */}
                                    <ReferenceLine
                                      y={maxLTV}
                                      stroke={SEMANTIC_COLORS.danger}
                                      strokeDasharray="4 4"
                                      strokeWidth={1}
                                      label={{ value: 'Liq', fill: SEMANTIC_COLORS.danger, fontSize: 9, position: 'right' }}
                                    />
                                    {/* Pending target LTV reference */}
                                    <ReferenceLine
                                      y={ltvData.pendingLTV}
                                      stroke={SEMANTIC_COLORS.warning}
                                      strokeDasharray="4 4"
                                      strokeWidth={1}
                                      label={{ value: 'Target', fill: SEMANTIC_COLORS.warning, fontSize: 9, position: 'right' }}
                                    />
                                    <Line
                                      type="monotone"
                                      dataKey="ltv"
                                      stroke="#22d3ee"
                                      strokeWidth={1.5}
                                      dot={false}
                                      activeDot={{ r: 3, fill: '#22d3ee' }}
                                    />
                                    <Line
                                      type="stepAfter"
                                      dataKey="currentLtv"
                                      stroke="white"
                                      strokeWidth={1}
                                      dot={false}
                                      activeDot={{ r: 2, fill: 'white' }}
                                    />
                                  </LineChart>
                                </ResponsiveContainer>
                              </Box>
                            )
                          })()}
                        </VStack>
                      </Box>
                    </Collapse>
                  </Td>
                </Tr>
              </Fragment>
            )
          })}
        </Tbody>
      </Table>
    </Card>

    {selectedAsset && (
      <DepositModal
        isOpen={depositModalOpen}
        onClose={() => setDepositModalOpen(false)}
        asset={selectedAsset}
        positionIndex={positionIndex}
      />
    )}
  </>
  )
}

export default AvailableCollateral
