import {
  Box,
  Grid,
  Text,
} from '@chakra-ui/react'
import { Card } from '@/components/ui/Card'
import { useCallback, useMemo, useState } from 'react'
import { DebtRowData } from './types'
import { BorrowModal } from './BorrowModal'
import { GRID_COLUMNS } from './DebtCardConstants'
import { DebtCardAssetRow, DebtAsset } from './DebtCardAssetRow'

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

// Hoisted to module scope so this default value is referentially stable across renders
const EMPTY_RATE_SEGMENTS: DebtRowData[] = []

export const DebtCard = ({
  rateSegments,
  pegRateSegments = EMPTY_RATE_SEGMENTS,
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
        {debtAssets.map((asset) => (
          <DebtCardAssetRow
            key={asset.symbol}
            asset={asset}
            isExpanded={expandedAssets.has(asset.symbol)}
            onToggle={toggleAsset}
            onRepay={onRepay}
            onBorrowMore={handleBorrowMore}
            isBorrowDisabled={isBorrowDisabled}
          />
        ))}
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
