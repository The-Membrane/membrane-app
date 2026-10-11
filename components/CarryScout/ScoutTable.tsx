import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { rankAtSize } from '@/lib/carryScan/rank'
import type { LaunchEnv } from '@/lib/carryScan/readiness'
import type { ScoutRow, SizeKey } from '@/lib/carryScan/types'
import type { MembraneShareInput } from '@/lib/netApy/breakdown'

import { ScoutRowView } from './ScoutRow'

export interface ScoutTableProps {
  rows: readonly ScoutRow[]
  ranked: boolean
  sizeKey: SizeKey
  share: MembraneShareInput
  launch: LaunchEnv
  empty: string
}

export const ScoutTable: React.FC<ScoutTableProps> = ({
  rows,
  ranked,
  sizeKey,
  share,
  launch,
  empty,
}) => {
  const list = ranked ? rankAtSize(rows, sizeKey) : rows.map((row) => ({ row, rank: null }))
  if (!list.length) {
    return (
      <Text
        mt="12px"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={SEMANTIC_COLORS.textTertiary}
      >
        {empty}
      </Text>
    )
  }
  return (
    <Box as="ul" mt="8px" p={0}>
      {list.map(({ row, rank }) => (
        <ScoutRowView
          key={row.key ?? row.aliases[0]}
          row={row}
          sizeKey={sizeKey}
          share={share}
          launch={launch}
          rank={rank}
        />
      ))}
    </Box>
  )
}

export default ScoutTable
