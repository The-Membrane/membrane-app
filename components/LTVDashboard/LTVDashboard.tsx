import React, { useMemo, useState } from 'react'
import {
  Box,
  VStack,
  HStack,
  Text,
  Image,
  Collapse,
  Icon,
  Badge,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
} from '@chakra-ui/react'
import { ChevronDownIcon, ChevronUpIcon, TriangleDownIcon, TriangleUpIcon } from '@chakra-ui/icons'
import { lazyChart } from '@/components/ui/lazyChart'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { mockHistoricalLTVData, MockLTVData } from '@/components/NeutronMint/mockCollateralData'
import useAssets from '@/hooks/useAssets'
import { useChainRoute } from '@/hooks/useChainRoute'

const DENOM_SYMBOL_MAP: Record<string, string> = {
  'untrn': 'NTRN',
  'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2': 'ATOM',
  'ibc/D79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877': 'TIA',
  'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4': 'USDC',
  'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc': 'WBTC',
  'ibc/831F0B1BBB1D08A2B75311892876D71565478C532967545476DF4C2D7492E48C': 'DYDX',
}

type Direction = 'increasing' | 'decreasing' | 'stable'
type SortKey = 'symbol' | 'currentLTV' | 'pendingLTV' | 'change' | 'maxLTV' | 'shiftTime'
type SortDir = 'asc' | 'desc'

const formatTimeUntil = (shiftTimestamp: number): string => {
  const nowSec = Math.floor(Date.now() / 1000)
  const diffSec = shiftTimestamp - nowSec
  if (diffSec <= 0) return 'Imminent'
  const hours = diffSec / 3600
  if (hours < 1) return `${Math.ceil(diffSec / 60)}m`
  if (hours < 24) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

const getDirection = (current: number, pending: number): Direction => {
  const diff = pending - current
  if (diff > 0.1) return 'increasing'
  if (diff < -0.1) return 'decreasing'
  return 'stable'
}

const getDirectionColor = (dir: Direction): string => {
  switch (dir) {
    case 'increasing': return SEMANTIC_COLORS.success  // up = green = good for borrowers
    case 'decreasing': return SEMANTIC_COLORS.danger   // down = red = tighter for borrowers
    case 'stable': return SEMANTIC_COLORS.textTertiary
  }
}

const getDirectionBg = (dir: Direction): string => {
  switch (dir) {
    case 'increasing': return 'rgba(70, 211, 154, 0.12)'  // info teal wash
    case 'decreasing': return 'rgba(207, 64, 52, 0.12)'   // danger wash
    case 'stable': return 'rgba(236, 230, 216, 0.05)'     // bone hairline wash
  }
}

const getDirectionLabel = (current: number, pending: number, dir: Direction): string => {
  const diff = pending - current
  if (dir === 'stable') return 'Stable'
  return `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`
}

const LTVChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  const ltvEntry = payload.find((p: any) => p.dataKey === 'ltv')
  const currentEntry = payload.find((p: any) => p.dataKey === 'currentLtv')
  return (
    <Box bg={SEMANTIC_COLORS.bgSecondary} border="1px solid" borderColor={SEMANTIC_COLORS.borderMedium} borderRadius={0} px={2} py={1}>
      <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
        {new Date(label * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </Text>
      {currentEntry && (
        <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.medium}>
          Set LTV: {currentEntry.value.toFixed(2)}%
        </Text>
      )}
      {ltvEntry && (
        <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.info} fontWeight={TYPOGRAPHY.medium}>
          Pending LTV: {ltvEntry.value.toFixed(2)}%
        </Text>
      )}
    </Box>
  )
}

interface AssetRow {
  denom: string
  symbol: string
  logo: string
  data: MockLTVData
  direction: Direction
}

const ChartLegend: React.FC<{ maxLTV: number }> = ({ maxLTV }) => {
  const [showMax, setShowMax] = useState(false)
  return (
    <HStack spacing={SPACING.base} justify="flex-end">
      <HStack spacing={SPACING.xs}>
        <Box w="12px" h="2px" bg={SEMANTIC_COLORS.textPrimary} />
        <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>Set</Text>
      </HStack>
      <HStack spacing={SPACING.xs}>
        <Box w="12px" h="2px" bg={SEMANTIC_COLORS.info} />
        <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>Pending</Text>
      </HStack>
      <HStack
        spacing={SPACING.xs}
        cursor="pointer"
        tabIndex={0}
        role="button"
        aria-pressed={showMax}
        onMouseEnter={() => setShowMax(true)}
        onMouseLeave={() => setShowMax(false)}
        onClick={() => setShowMax(!showMax)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setShowMax((v) => !v)
          }
        }}
        _focus={FOCUS_STYLES.ring}
      >
        <Box w="12px" h="2px" bg={SEMANTIC_COLORS.danger} borderStyle="dashed" />
        <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary}>
          Max{showMax ? `: ${maxLTV}%` : ''}
        </Text>
      </HStack>
    </HStack>
  )
}

const LTVLineChart = lazyChart<{ chartData: MockLTVData['historicalSnapshots']; maxLTV: number }>(
  ({ LineChart, Line, XAxis, YAxis, Tooltip: RechartsTooltip, ResponsiveContainer, ReferenceLine, CartesianGrid }) =>
    function LTVLineChart({ chartData, maxLTV }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(236,230,216,0.08)" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              tick={{ fill: 'rgba(236,230,216,0.4)', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              minTickGap={50}
            />
            <YAxis
              domain={[(dataMin: number) => Math.floor(dataMin - 3), (dataMax: number) => Math.ceil(dataMax + 5)]}
              tick={{ fill: 'rgba(236,230,216,0.4)', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              width={50}
            />
            <RechartsTooltip content={<LTVChartTooltip />} />
            <ReferenceLine
              y={maxLTV}
              stroke={SEMANTIC_COLORS.danger}
              strokeDasharray="4 4"
              strokeWidth={1}
              ifOverflow="visible"
              label={{ value: `Max ${maxLTV}%`, fill: SEMANTIC_COLORS.danger, fontSize: 10, position: 'insideTopRight' }}
            />
            <Line
              type="monotone"
              dataKey="ltv"
              stroke={SEMANTIC_COLORS.info}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, fill: SEMANTIC_COLORS.info }}
              name="Max LTV Signal"
            />
            <Line
              type="stepAfter"
              dataKey="currentLtv"
              stroke={SEMANTIC_COLORS.textPrimary}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: SEMANTIC_COLORS.textPrimary }}
              name="Active LTV"
            />
          </LineChart>
        </ResponsiveContainer>
      )
    },
  '100%',
)

const ExpandedChart: React.FC<{ data: MockLTVData }> = ({ data }) => {
  const chartData = data.historicalSnapshots
  const { maxLTV, pendingLTV, currentLTV } = data

  return (
    <VStack spacing={SPACING.sm} align="stretch">
      <ChartLegend maxLTV={maxLTV} />
      <Box h="180px" bg={SEMANTIC_COLORS.bgPrimary} borderRadius={0} border="1px solid" borderColor={SEMANTIC_COLORS.borderMedium} pt={2}>
        <LTVLineChart chartData={chartData} maxLTV={maxLTV} />
      </Box>
    </VStack>
  )
}

const getSortValue = (row: AssetRow, key: SortKey): number | string => {
  switch (key) {
    case 'symbol': return row.symbol
    case 'currentLTV': return row.data.currentLTV
    case 'pendingLTV': return row.data.pendingLTV
    case 'change': return row.data.pendingLTV - row.data.currentLTV
    case 'maxLTV': return row.data.maxLTV
    case 'shiftTime': return row.data.shiftTime
  }
}

const SortableHeader: React.FC<{
  label: string
  sortKey: SortKey
  activeSortKey: SortKey | null
  sortDir: SortDir
  onSort: (key: SortKey) => void
}> = ({ label, sortKey, activeSortKey, sortDir, onSort }) => {
  const isActive = sortKey === activeSortKey
  return (
    <Th
      color={SEMANTIC_COLORS.textSecondary}
      fontSize={TYPOGRAPHY.label}
      fontWeight={TYPOGRAPHY.normal}
      textTransform="uppercase"
      px={2}
      cursor="pointer"
      tabIndex={0}
      role="button"
      aria-label={`Sort by ${label}`}
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSort(sortKey)
        }
      }}
      _hover={{ color: SEMANTIC_COLORS.textPrimary }}
      _focus={FOCUS_STYLES.ring}
      userSelect="none"
    >
      <HStack spacing={1}>
        <Text>{label}</Text>
        <VStack spacing={0}>
          <Icon
            as={TriangleUpIcon}
            boxSize={2}
            color={isActive && sortDir === 'asc' ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textTertiary}
          />
          <Icon
            as={TriangleDownIcon}
            boxSize={2}
            color={isActive && sortDir === 'desc' ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textTertiary}
          />
        </VStack>
      </HStack>
    </Th>
  )
}

/* ── Main dashboard ── */
export const LTVDashboard: React.FC = () => {
  const { walletChainName } = useChainRoute()
  const assets = useAssets(walletChainName)
  const [sortKey, setSortKey] = useState<SortKey | null>('change')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      if (sortDir === 'desc') {
        setSortDir('asc')
      } else {
        setSortKey(null)
      }
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const toggleRow = (denom: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(denom)) next.delete(denom)
      else next.add(denom)
      return next
    })
  }

  const allRows = useMemo<AssetRow[]>(() => {
    return Object.entries(mockHistoricalLTVData).map(([denom, data]) => {
      // Try matching by base denom first, then by symbol from known denom map
      let asset = assets?.find((a) => a.base === denom)
      if (!asset) {
        const knownSymbol = DENOM_SYMBOL_MAP[denom]
        if (knownSymbol) asset = assets?.find((a) => a.symbol === knownSymbol)
      }
      return {
        denom,
        symbol: asset?.symbol || DENOM_SYMBOL_MAP[denom] || denom.slice(0, 8) + '...',
        logo: asset?.logo || '/images/default-token.svg',
        data,
        direction: getDirection(data.currentLTV, data.pendingLTV),
      }
    })
  }, [assets])

  const sortedRows = useMemo(() => {
    if (!sortKey) return allRows
    return [...allRows].sort((a, b) => {
      const aVal = getSortValue(a, sortKey)
      const bVal = getSortValue(b, sortKey)
      const cmp = typeof aVal === 'string'
        ? aVal.localeCompare(bVal as string)
        : (aVal as number) - (bVal as number)
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [allRows, sortKey, sortDir])

  return (
    <Box position="relative" minH="100vh">
      <Box w="100%" maxW="1200px" mx="auto" p={SPACING.base} position="relative" zIndex={1}>
        <VStack spacing={SPACING_PATTERNS.sectionGap} align="stretch">
          {/* Title */}
          <VStack spacing={SPACING.xs} align="flex-start">
            <Text as="h1" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1} fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>
              Liquidation LTV Updates
            </Text>
            <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
              Pending liquidation LTV changes across all collateral assets
            </Text>
          </VStack>

          {/* Table */}
          <Card>
            <Table variant="unstyled" size="sm">
              <Thead>
                <Tr>
                  <SortableHeader label="Asset" sortKey="symbol" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  <SortableHeader label="Current" sortKey="currentLTV" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  <SortableHeader label="Pending" sortKey="pendingLTV" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  <SortableHeader label="Change" sortKey="change" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  <SortableHeader label="Max LTV" sortKey="maxLTV" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  <SortableHeader label="Update In" sortKey="shiftTime" activeSortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  <Th px={2} width="40px"></Th>
                </Tr>
              </Thead>
              <Tbody>
                {sortedRows.map((row) => {
                  const isExpanded = expandedRows.has(row.denom)
                  const dirColor = getDirectionColor(row.direction)
                  const changeLabel = getDirectionLabel(row.data.currentLTV, row.data.pendingLTV, row.direction)

                  return (
                    <React.Fragment key={row.denom}>
                      <Tr
                        cursor="pointer"
                        tabIndex={0}
                        role="button"
                        aria-expanded={isExpanded}
                        aria-label={`Toggle ${row.symbol} detail`}
                        onClick={() => toggleRow(row.denom)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            toggleRow(row.denom)
                          }
                        }}
                        _hover={{ bg: SEMANTIC_COLORS.bgTertiary }}
                        _focus={FOCUS_STYLES.ring}
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
                            />
                            <Text color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.medium} fontSize={TYPOGRAPHY.small}>
                              {row.symbol}
                            </Text>
                          </HStack>
                        </Td>
                        <Td px={2} py={3}>
                          <Text color={SEMANTIC_COLORS.textPrimary} fontSize={TYPOGRAPHY.small} fontWeight={TYPOGRAPHY.medium}>
                            {row.data.currentLTV.toFixed(1)}%
                          </Text>
                        </Td>
                        <Td px={2} py={3}>
                          <Text color={dirColor} fontSize={TYPOGRAPHY.small} fontWeight={TYPOGRAPHY.bold}>
                            {row.data.pendingLTV.toFixed(1)}%
                          </Text>
                        </Td>
                        <Td px={2} py={3}>
                          <Badge
                            bg={getDirectionBg(row.direction)}
                            color={dirColor}
                            px={SPACING.sm}
                            py={1}
                            borderRadius="full"
                            fontSize={TYPOGRAPHY.xs}
                            fontWeight={TYPOGRAPHY.medium}
                            textTransform="none"
                          >
                            {changeLabel}
                          </Badge>
                        </Td>
                        <Td px={2} py={3}>
                          <Text color={SEMANTIC_COLORS.textPrimary} fontSize={TYPOGRAPHY.small}>
                            {row.data.maxLTV.toFixed(1)}%
                          </Text>
                        </Td>
                        <Td px={2} py={3}>
                          <Text color={SEMANTIC_COLORS.textSecondary} fontSize={TYPOGRAPHY.small}>
                            {formatTimeUntil(row.data.shiftTime)}
                          </Text>
                        </Td>
                        <Td px={2} py={3}>
                          <Icon
                            as={isExpanded ? ChevronUpIcon : ChevronDownIcon}
                            color={SEMANTIC_COLORS.textSecondary}
                            boxSize={5}
                            _hover={{ color: SEMANTIC_COLORS.textPrimary }}
                          />
                        </Td>
                      </Tr>
                      <Tr>
                        <Td colSpan={7} p={0}>
                          <Collapse in={isExpanded} animateOpacity>
                            <Box p={3} bg="rgba(0, 0, 0, 0.3)" borderLeft="2px solid" borderColor={dirColor}>
                              <ExpandedChart data={row.data} />
                            </Box>
                          </Collapse>
                        </Td>
                      </Tr>
                    </React.Fragment>
                  )
                })}
                {sortedRows.length === 0 && (
                  <Tr>
                    <Td colSpan={7} py={8}>
                      <Text color={SEMANTIC_COLORS.textTertiary} textAlign="center" fontSize={TYPOGRAPHY.small}>
                        No assets match this filter
                      </Text>
                    </Td>
                  </Tr>
                )}
              </Tbody>
            </Table>
          </Card>
        </VStack>
      </Box>
    </Box>
  )
}

export default LTVDashboard
