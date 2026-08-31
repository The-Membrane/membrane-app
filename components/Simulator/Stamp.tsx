// The provenance chip. Every data block on this page carries one — there is no
// unstamped path (lib/position-sim/types.ts).
//
// The colour IS the claim:
//   onchain  → info      read from a node this session
//   dataset  → secondary read from a committed measured file
//   modelled → warning   computed by us; an assumption, not an observation
//   mock     → warning   fixture data, labelled as such

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { Provenance, ProvenanceKind } from '@/lib/position-sim'

const KIND_COLOR: Record<ProvenanceKind, string> = {
  onchain: SEMANTIC_COLORS.info,
  dataset: SEMANTIC_COLORS.textSecondary,
  modelled: SEMANTIC_COLORS.warning,
  mock: SEMANTIC_COLORS.warning,
}

const clock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface StampProps {
  provenance: Provenance
  /** Optional trailing note appended after the label. */
  note?: string
}

/**
 * `fetched HH:MM` is only appended for an on-chain read, because that is the only
 * kind whose `at` is a read time. A dataset's `at` is the window start and a
 * modelled/mock stamp has no fetch at all — printing a clock on those would claim
 * a freshness that does not exist.
 */
export const Stamp: React.FC<StampProps> = ({ provenance, note }) => {
  const color = KIND_COLOR[provenance.kind]
  const [mounted, setMounted] = React.useState(false)
  // The clock is client-only: the server and the browser are in different zones and
  // an SSR'd time would mismatch on hydrate.
  React.useEffect(() => setMounted(true), [])

  return (
    <Box
      as="span"
      title={provenance.detail}
      display="inline-flex"
      alignItems="center"
      gap={SPACING.xs}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      borderRadius={0}
      px={SPACING.sm}
      py="2px"
      maxW="100%"
    >
      <Box as="span" w="5px" h="5px" bg={color} flexShrink={0} />
      <Text
        as="span"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="9.5px"
        letterSpacing="0.14em"
        textTransform="uppercase"
        color={color}
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
      >
        {provenance.label}
        {provenance.kind === 'onchain' && mounted ? ` · fetched ${clock(provenance.at)}` : ''}
        {note ? ` · ${note}` : ''}
      </Text>
    </Box>
  )
}

export default Stamp
