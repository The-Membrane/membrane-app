import React from 'react'
import { Box, Grid, HStack, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { SectionHead } from './primitives'
import { FeedList } from './FeedList'
import { CURATE_COMP, CURATE_FEED } from './fixtures'
import { CompSlice } from './types'

// The proto's composition bar used bone/#e0c877(gold-ish)/teal with a fading
// opacity per slice; tones map to tokens, opacity preserved.
const TONE: Record<CompSlice['tone'], string> = {
  bone: SEMANTIC_COLORS.textPrimary,
  gold: SEMANTIC_COLORS.warning,
  teal: SEMANTIC_COLORS.info,
}

/** The Curate role: your vault, where it deploys, and your realized fee share. */
export const CurateRole: React.FC = () => (
  <Box>
    <Card as={Grid} gridTemplateColumns={{ base: '1fr 1fr', md: '1fr 1fr 1fr 1fr' }} gap={{ base: SPACING.lg, md: '22px' }}>
      <Box display="grid" gap="5px" alignContent="start" minW={0}>
        <HeadK>Your vault</HeadK>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="19px" lineHeight="1.05" color={SEMANTIC_COLORS.textPrimary}>
          Depth-first CDT
        </Text>
        <HeadN>launched Mar 2026</HeadN>
      </Box>
      <Box display="grid" gap="5px" alignContent="start" minW={0}>
        <HeadK>Deposits</HeadK>
        <HeadV>$1.84M</HeadV>
        <HeadN>61 depositors</HeadN>
      </Box>
      <Box display="grid" gap="5px" alignContent="start" minW={0}>
        <HeadK>Your fee share</HeadK>
        <HeadV>$1,912</HeadV>
        <HeadN>realized, lifetime — disclosed 8% of vault fees</HeadN>
      </Box>
      <Box display="grid" gap="5px" alignContent="start" minW={0}>
        <HeadK>Capacity used</HeadK>
        <HeadV>74%</HeadV>
        <Box h="9px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mt="7px">
          <Box h="100%" w="74%" bg={SEMANTIC_COLORS.info} />
        </Box>
        <HeadN>of the cap your stake sets</HeadN>
      </Box>
    </Card>

    <SectionHead index="01 /" title="Where your vault deploys" note="allocation, measured today" />
    <Card>
      <HStack h="22px" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} overflow="hidden" spacing={0}>
        {CURATE_COMP.map((c, i) => (
          <Box key={c.label} h="100%" w={`${c.pct}%`} bg={TONE[c.tone]} opacity={1 - i * 0.14} title={c.label} />
        ))}
      </HStack>
      <HStack spacing={SPACING.base} flexWrap="wrap" mt={SPACING.sm} fontSize="10px" color={SEMANTIC_COLORS.textSecondary}>
        {CURATE_COMP.map((c, i) => (
          <Text as="span" key={c.label} fontFamily={TYPOGRAPHY.fontMono}>
            <Box as="span" display="inline-block" w="9px" h="9px" mr="5px" verticalAlign="-1px" bg={TONE[c.tone]} opacity={1 - i * 0.14} />
            {c.label}{' '}
            <Box as="span" fontWeight={400} color={SEMANTIC_COLORS.textPrimary}>
              {c.pct}%
            </Box>
          </Text>
        ))}
      </HStack>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.12em" mt={SPACING.sm}>
        measured 2026-08-15 · block 21,911,004 · depositors see this same view
      </Text>
    </Card>

    <SectionHead index="02 /" title="Fees paid to you" note="realized only — your share follows the fees your strategy generates" />
    <Card>
      <FeedList rows={CURATE_FEED} />
    </Card>
  </Box>
)

const HeadK: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" letterSpacing="0.24em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
    {children}
  </Text>
)
const HeadV: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="24px" lineHeight="1.05" color={SEMANTIC_COLORS.textPrimary}>
    {children}
  </Text>
)
const HeadN: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary} lineHeight={1.5}>
    {children}
  </Text>
)
