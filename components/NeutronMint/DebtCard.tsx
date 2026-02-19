import { num } from '@/helpers/num'
import {
  Box,
  Button,
  Collapse,
  Grid,
  HStack,
  Icon,
  Image,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Stack,
  Text,
  Tooltip,
} from '@chakra-ui/react'
import { Card } from '@/components/ui/Card'
import { ChevronDownIcon, ChevronUpIcon } from '@chakra-ui/icons'
import { HandCoins, Plus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { DebtRowData } from './types'
import { BorrowModal } from './BorrowModal'

interface DebtAsset {
  symbol: string
  subtext?: string
  logo: string
  segments: DebtRowData[]
}

interface DebtCardProps {
  rateSegments: DebtRowData[]
  pegRateSegments?: DebtRowData[]
  onRepay?: (asset: string) => void
  currentLtv?: number
  maxBorrowLtv?: number
  positionIndex?: number
}

const BORROW_ASSETS: Record<string, { symbol: 'CDT' | 'USDC'; denom: string; logo: string; price: number }> = {
  CDT: { symbol: 'CDT', denom: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt', logo: '/images/cdt.svg', price: 1 },
  USDC: { symbol: 'USDC', denom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4', logo: '/images/usdc.svg', price: 1 },
}

const GRID_COLUMNS = '2fr 2fr 2fr 3fr'

// Format time remaining until fixed rate expiry
const formatTimeRemaining = (endTime: number): string => {
  const now = Math.floor(Date.now() / 1000)
  const remaining = endTime - now
  if (remaining <= 0) return 'Expired'

  const days = Math.floor(remaining / (60 * 60 * 24))
  if (days > 30) {
    const months = Math.floor(days / 30)
    const remainingDays = days % 30
    return remainingDays > 0 ? `${months}mo ${remainingDays}d` : `${months}mo`
  }
  return `${days}d`
}

export const DebtCard = ({
  rateSegments,
  pegRateSegments = [],
  onRepay,
  currentLtv = 0,
  maxBorrowLtv = 0,
  positionIndex = 0,
}: DebtCardProps) => {
  const [expandedAssets, setExpandedAssets] = useState<Set<string>>(new Set())
  const [borrowModalOpen, setBorrowModalOpen] = useState(false)
  const [borrowAsset, setBorrowAsset] = useState<typeof BORROW_ASSETS['CDT'] | null>(null)

  const isBorrowDisabled = maxBorrowLtv > 0 && currentLtv >= maxBorrowLtv

  const handleBorrowMore = useCallback((symbol: string) => {
    const asset = BORROW_ASSETS[symbol]
    if (!asset) return
    setBorrowAsset(asset)
    setBorrowModalOpen(true)
  }, [])

  const toggleAsset = (symbol: string) => {
    setExpandedAssets(prev => {
      const next = new Set(prev)
      if (next.has(symbol)) {
        next.delete(symbol)
      } else {
        next.add(symbol)
      }
      return next
    })
  }

  // Build asset-level rows from segments
  const debtAssets = useMemo<DebtAsset[]>(() => {
    const assets: DebtAsset[] = []

    const activeCdtSegments = rateSegments.filter(s => s.amount > 0)
    if (activeCdtSegments.length > 0) {
      assets.push({
        symbol: 'CDT',
        subtext: 'Membrane',
        logo: '/images/cdt.svg',
        segments: activeCdtSegments,
      })
    }

    const activePegSegments = pegRateSegments.filter(s => s.amount > 0)
    if (activePegSegments.length > 0) {
      assets.push({
        symbol: 'USDC',
        subtext: 'Noble',
        logo: '/images/usdc.svg',
        segments: activePegSegments,
      })
    }

    return assets
  }, [rateSegments, pegRateSegments])

  if (debtAssets.length === 0) {
    return (
      <Card p={4}>
        <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
          Debt
        </Text>
        <Text color="whiteAlpha.600" textAlign="center" py={8}>
          No outstanding debt
        </Text>
      </Card>
    )
  }

  return (
    <>
      <Card p={4}>
        <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
          Debt
        </Text>

        {/* Header row */}
        <Grid templateColumns={GRID_COLUMNS} gap={2} px={2} mb={1}>
          <Text color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase">
            Asset
          </Text>
          <Text color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" textAlign="right">
            Debt
          </Text>
          <Text color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" textAlign="right">
            Borrow APY
          </Text>
          <Box />
        </Grid>

        {/* Asset rows */}
        {debtAssets.map((asset) => {
          const isExpanded = expandedAssets.has(asset.symbol)
          const totalAmount = asset.segments.reduce((acc, s) => acc + s.amount, 0)
          const weightedRate = totalAmount > 0
            ? asset.segments.reduce((acc, s) => acc + s.rate * s.amount, 0) / totalAmount
            : 0

          return (
            <Box key={asset.symbol}>
              <Grid
                templateColumns={GRID_COLUMNS}
                gap={2}
                px={2}
                py={3}
                alignItems="center"
                _hover={{ bg: 'whiteAlpha.50' }}
                borderRadius="md"
              >
                {/* Asset */}
                <HStack spacing={2}>
                  <Image
                    src={asset.logo}
                    alt={asset.symbol}
                    w="24px"
                    h="24px"
                    borderRadius="full"
                    fallbackSrc="/images/default-token.svg"
                  />
                  <Stack spacing={0}>
                    <Text color="white" fontWeight="medium" fontSize="sm">
                      {asset.symbol}
                    </Text>
                    {asset.subtext && (
                      <Text color="whiteAlpha.500" fontSize="xs">
                        {asset.subtext}
                      </Text>
                    )}
                  </Stack>
                </HStack>

                {/* Debt amount */}
                <Stack spacing={0} alignItems="flex-end">
                  <Text color="white" fontSize="sm" fontWeight="medium">
                    ${num(totalAmount).toFixed(2)}
                  </Text>
                  <Text color="whiteAlpha.500" fontSize="xs">
                    {num(totalAmount).toFixed(2)}
                  </Text>
                </Stack>

                {/* Borrow APY */}
                <Text
                  color={weightedRate > 0 ? 'red.400' : 'whiteAlpha.700'}
                  fontSize="sm"
                  textAlign="right"
                >
                  {weightedRate > 0 ? `${weightedRate.toFixed(2)}%` : '-'}
                </Text>

                {/* Actions */}
                <HStack spacing={1} justify="flex-end">
                  <Menu placement="bottom">
                    <MenuButton
                      as={Button}
                      size="xs"
                      variant="outline"
                      colorScheme="purple"
                      rightIcon={<ChevronDownIcon />}
                      w="auto"
                    >
                      <Text pl={2}>Manage</Text>
                    </MenuButton>
                    <MenuList
                      bg="rgba(10, 10, 10, 0.95)"
                      borderColor="whiteAlpha.200"
                      minW="auto"
                      w="fit-content"
                      py={0}
                      overflow="hidden"
                      borderRadius="md"
                    >
                      <MenuItem
                        bg="transparent"
                        _hover={{ bg: 'whiteAlpha.50' }}
                        color="white"
                        fontSize="sm"
                        px={4}
                        py={3}
                        borderBottom="1px solid"
                        borderColor="whiteAlpha.100"
                        icon={<Icon as={HandCoins} w={4} h={4} color="whiteAlpha.600" />}
                        onClick={() => onRepay?.(asset.symbol)}
                      >
                        Repay
                      </MenuItem>
                      <Tooltip
                        label="LTV at max borrow limit"
                        isDisabled={!isBorrowDisabled}
                        placement="left"
                      >
                        <MenuItem
                          bg="transparent"
                          _hover={isBorrowDisabled ? {} : { bg: 'whiteAlpha.50' }}
                          color={isBorrowDisabled ? 'whiteAlpha.300' : 'white'}
                          fontSize="sm"
                          px={4}
                          py={3}
                          icon={<Icon as={Plus} w={4} h={4} color={isBorrowDisabled ? 'whiteAlpha.200' : 'whiteAlpha.600'} />}
                          onClick={() => !isBorrowDisabled && handleBorrowMore(asset.symbol)}
                          cursor={isBorrowDisabled ? 'not-allowed' : 'pointer'}
                        >
                          Borrow More
                        </MenuItem>
                      </Tooltip>
                    </MenuList>
                  </Menu>

                  <Icon
                    as={isExpanded ? ChevronUpIcon : ChevronDownIcon}
                    color="whiteAlpha.600"
                    w={5}
                    h={5}
                    cursor="pointer"
                    onClick={() => toggleAsset(asset.symbol)}
                    _hover={{ color: 'whiteAlpha.800' }}
                  />
                </HStack>
              </Grid>

              {/* Expanded: rate segments */}
              <Collapse in={isExpanded} animateOpacity>
                <Box
                  p={3}
                  bg="rgba(0, 0, 0, 0.3)"
                  borderLeft="2px solid"
                  borderColor="cyan.500"
                  mx={2}
                  mb={1}
                >
                  {/* Segment header */}
                  <Grid templateColumns="1fr 1fr 1fr 1fr" gap={2} mb={1}>
                    <Text color="whiteAlpha.500" fontSize="xs" textTransform="uppercase">
                      Type
                    </Text>
                    <Text color="whiteAlpha.500" fontSize="xs" textTransform="uppercase" textAlign="right">
                      Rate
                    </Text>
                    <Text color="whiteAlpha.500" fontSize="xs" textTransform="uppercase" textAlign="right">
                      Amount
                    </Text>
                    <Text color="whiteAlpha.500" fontSize="xs" textTransform="uppercase" textAlign="right">
                      Expires
                    </Text>
                  </Grid>

                  {/* Segment rows */}
                  {asset.segments.map((segment) => (
                    <Grid templateColumns="1fr 1fr 1fr 1fr" gap={2} key={segment.type} py={1}>
                      <Text color="whiteAlpha.800" fontSize="xs" fontWeight="medium">
                        {segment.type}
                      </Text>
                      <Text
                        color={segment.rate > 0 ? 'red.300' : 'whiteAlpha.800'}
                        fontSize="xs"
                        textAlign="right"
                      >
                        {segment.rate > 0 ? `${segment.rate.toFixed(2)}%` : '-'}
                      </Text>
                      <Stack spacing={0} alignItems="flex-end">
                        <Text color="whiteAlpha.800" fontSize="xs">
                          ${num(segment.amount).toFixed(2)}
                        </Text>
                        {totalAmount > 0 && (
                          <Text color="whiteAlpha.500" fontSize="2xs">
                            {num(segment.amount).dividedBy(totalAmount).times(100).toFixed(1)}%
                          </Text>
                        )}
                      </Stack>
                      <Box textAlign="right">
                        {segment.endTime ? (
                          <Stack spacing={0} alignItems="flex-end">
                            <Text color="whiteAlpha.700" fontSize="xs">
                              {formatTimeRemaining(segment.endTime)}
                            </Text>
                            <Text color="whiteAlpha.500" fontSize="2xs">
                              {segment.rollover ? 'rollover' : 'to variable'}
                            </Text>
                          </Stack>
                        ) : (
                          <Text color="whiteAlpha.500" fontSize="xs">-</Text>
                        )}
                      </Box>
                    </Grid>
                  ))}
                </Box>
              </Collapse>
            </Box>
          )
        })}
      </Card>

      {borrowAsset && (
        <BorrowModal
          isOpen={borrowModalOpen}
          onClose={() => {
            setBorrowModalOpen(false)
            setBorrowAsset(null)
          }}
          asset={borrowAsset}
          positionIndex={positionIndex}
        />
      )}
    </>
  )
}

export default DebtCard
