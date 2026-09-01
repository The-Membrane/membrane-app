import { HStack, Table, Tbody, Text, Th, Thead, Tooltip, Tr } from '@chakra-ui/react'
import { useMemo, useState } from 'react'
import { InfoIcon } from '@chakra-ui/icons'
import { Card } from '@/components/ui/Card'
import { DepositModal } from './DepositModal'
import { SPACING } from '@/config/spacing'
import { CollateralRow } from './CollateralRow'
import { useCollateralRows } from './hooks/useCollateralRows'

interface AvailableCollateralProps {
  positionIndex?: number
}

export const AvailableCollateral = ({ positionIndex = 0 }: AvailableCollateralProps) => {
  const collateralRows = useCollateralRows()

  // Track expanded rows
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  // Deposit modal state
  const [depositModalOpen, setDepositModalOpen] = useState(false)
  const [selectedDenom, setSelectedDenom] = useState<string>('')

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

  const handleDeposit = (denom: string) => {
    setSelectedDenom(denom)
    setDepositModalOpen(true)
  }

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
          {collateralRows.map((row) => (
            <CollateralRow
              key={row.denom}
              row={row}
              isExpanded={expandedRows.has(row.denom)}
              onToggleExpand={toggleRow}
              onDeposit={handleDeposit}
            />
          ))}
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
