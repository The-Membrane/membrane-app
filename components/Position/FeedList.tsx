import React from 'react'
import { Box, Grid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { FeedRow } from './types'

/** Realized fee/earnings feed — same grammar as the delivery feed, no ledger. */
export const FeedList: React.FC<{ rows: FeedRow[] }> = ({ rows }) => (
  <Box>
    {rows.map((f, i) => (
      <Grid
        key={i}
        gridTemplateColumns="auto 1fr auto"
        gap="10px"
        alignItems="baseline"
        py="9px"
        borderBottom={i === rows.length - 1 ? 'none' : '1px solid'}
        borderColor={SEMANTIC_COLORS.borderSubtle}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11.5px"
      >
        <Text as="span" color={SEMANTIC_COLORS.success}>
          +${f.amt.toFixed(2)}
        </Text>
        <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
          {f.src}
        </Text>
        <Text as="span" color={SEMANTIC_COLORS.textTertiary} fontSize="10px">
          {f.ago}
        </Text>
      </Grid>
    ))}
  </Box>
)
