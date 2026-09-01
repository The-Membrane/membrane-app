import React from 'react'
import { Box, Tooltip } from '@chakra-ui/react'
import { InfoOutlineIcon } from '@chakra-ui/icons'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

/* ── Info icon tooltip ── */
export const ChartInfo: React.FC<{ tip: string }> = ({ tip }) => (
  <Tooltip
    label={tip}
    placement="top"
    hasArrow
    bg={SEMANTIC_COLORS.bgSecondary}
    border={`1px solid ${SEMANTIC_COLORS.borderStrong}`}
    borderRadius={0}
    color={SEMANTIC_COLORS.textPrimary}
    fontFamily="mono"
    fontSize="xs"
    px={3}
    py={2}
    maxW="280px"
  >
    <Box as="span" display="inline-flex" cursor="help">
      <InfoOutlineIcon boxSize="12px" color={SEMANTIC_COLORS.textTertiary} _hover={{ color: SEMANTIC_COLORS.textSecondary }} />
    </Box>
  </Tooltip>
)
