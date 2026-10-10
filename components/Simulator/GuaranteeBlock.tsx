// THE CORPUS PROOF.
//
// This section gives the multi-year result the full visual weight of a standalone
// proof. Global savings are gold; phosphor remains reserved for a wallet's own result.
// The mechanism and its limit stay adjacent below the proof, without code-path badges.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { GUARANTEE } from '@/lib/position-sim'
import { CORPUS_SCALE_LINE, OCT10_SCALE_LINE } from '@/lib/position-sim/oct10Totals'

const SCALE = CORPUS_SCALE_LINE.partial ? OCT10_SCALE_LINE : CORPUS_SCALE_LINE
const SCALE_LEAD = CORPUS_SCALE_LINE.partial
  ? '4% sounds small.'
  : '4% sounds small. It would have kept'
const SCALE_TAIL = CORPUS_SCALE_LINE.partial
  ? `of debt protected from forced closure ${SCALE.window}.`
  : `of collateral ${SCALE.window}.`
const WINDOW_FIGURE = CORPUS_SCALE_LINE.partial ? '1' : String(CORPUS_SCALE_LINE.years)
const WINDOW_UNIT = CORPUS_SCALE_LINE.partial ? 'day measured' : 'years measured'

export const GuaranteeBlock: React.FC = () => (
  <Box
    data-testid="sim-guarantee"
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    bg={SEMANTIC_COLORS.bgPrimary}
    borderRadius={0}
    overflow="hidden"
    minW={0}
  >
    <Box
      px={{ base: SPACING.base, md: SPACING.xl }}
      py={{ base: SPACING.xl, md: SPACING['2xl'] }}
      display="grid"
      gridTemplateColumns={{ base: '1fr', md: 'minmax(0, 1.35fr) minmax(180px, 0.65fr)' }}
      gap={{ base: SPACING.xl, md: SPACING['2xl'] }}
      alignItems="end"
    >
      <Text
        data-testid="sim-scale-line"
        fontFamily={TYPOGRAPHY.fontDisplay}
        color={SEMANTIC_COLORS.textPrimary}
        lineHeight={0.95}
        letterSpacing="-0.025em"
        minW={0}
      >
        <Text as="span" display="block" fontSize="clamp(26px, 4vw, 48px)" lineHeight={1.05}>
          {SCALE_LEAD}{' '}
        </Text>
        <Text
          as="span"
          display="block"
          py={SPACING.sm}
          fontSize="clamp(76px, 14vw, 168px)"
          lineHeight={0.82}
          color={SEMANTIC_COLORS.warning}
          sx={{ fontVariantNumeric: 'tabular-nums lining-nums' }}
        >
          {SCALE.figure}
        </Text>{' '}
        <Text as="span" display="block" fontSize="clamp(25px, 4vw, 48px)" lineHeight={1.05}>
          {SCALE_TAIL}
        </Text>
      </Text>

      <Box
        aria-hidden="true"
        borderLeft={{ base: 'none', md: '1px solid' }}
        borderTop={{ base: '1px solid', md: 'none' }}
        borderColor={SEMANTIC_COLORS.borderStrong}
        pl={{ base: 0, md: SPACING.xl }}
        pt={{ base: SPACING.lg, md: 0 }}
        display="grid"
        gap={SPACING.base}
      >
        <Box h="10px" w="100%" bg={SEMANTIC_COLORS.warning} />
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize="clamp(76px, 10vw, 132px)"
          lineHeight={0.82}
          color={SEMANTIC_COLORS.warning}
          sx={{ fontVariantNumeric: 'tabular-nums lining-nums' }}
        >
          {WINDOW_FIGURE}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          lineHeight={1.5}
          letterSpacing="0.12em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.warning}
        >
          {WINDOW_UNIT} · Aave V3
        </Text>
      </Box>
    </Box>

    {!CORPUS_SCALE_LINE.partial && (
      <Text
        data-testid="sim-scale-subline"
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        px={{ base: SPACING.base, md: SPACING.xl }}
        py={SPACING.base}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="12.5px"
        lineHeight={1.6}
        color={SEMANTIC_COLORS.textSecondary}
      >
        {OCT10_SCALE_LINE.result} {OCT10_SCALE_LINE.window}.
      </Text>
    )}

    <Box
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      px={{ base: SPACING.base, md: SPACING.xl }}
      py={{ base: SPACING.lg, md: SPACING.xl }}
      display="grid"
      gridTemplateColumns={{ base: '1fr', md: 'minmax(0, 1fr) minmax(0, 0.72fr)' }}
      gap={{ base: SPACING.base, md: SPACING.xl }}
    >
      <Box display="grid" gap={SPACING.sm} alignContent="start">
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize="clamp(42px, 6vw, 72px)"
          lineHeight={0.92}
          color={SEMANTIC_COLORS.success}
        >
          {GUARANTEE.name}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="15px"
          lineHeight={1.6}
          color={SEMANTIC_COLORS.textPrimary}
          maxW="70ch"
        >
          {GUARANTEE.claim}
        </Text>
      </Box>

      <Text
        borderLeft={{ base: '2px solid', md: '1px solid' }}
        borderColor={SEMANTIC_COLORS.warning}
        pl={SPACING.base}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="13px"
        lineHeight={1.6}
        color={SEMANTIC_COLORS.textSecondary}
        alignSelf="center"
      >
        {GUARANTEE.limit}
      </Text>
    </Box>
  </Box>
)

export default GuaranteeBlock
