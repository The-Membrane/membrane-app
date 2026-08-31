import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

/** Mono 11px uppercase 0.28em eyebrow (proto `.eyebrow`). */
export const Eyebrow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.28em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textSecondary}
  >
    {children}
  </Text>
)

/** Small mono provenance stamp (proto `.stamp`). */
export const Stamp: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.12em"
    color={SEMANTIC_COLORS.textTertiary}
    lineHeight={1.7}
    mt={SPACING.sm}
  >
    {children}
  </Text>
)

/** Section header: numeric eyebrow + serif h2 + optional note (proto `.sect`). */
export const SectionHeading: React.FC<{ index: string; title: string; note?: React.ReactNode }> = ({
  index,
  title,
  note,
}) => (
  <HStack align="baseline" spacing={SPACING.md} flexWrap="wrap" mt={SPACING.xl} mb={SPACING.sm}>
    <Eyebrow>{index}</Eyebrow>
    <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2} color={SEMANTIC_COLORS.textPrimary} letterSpacing="-0.01em">
      {title}
    </Text>
    {note && (
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} color={SEMANTIC_COLORS.textTertiary}>
        {note}
      </Text>
    )}
  </HStack>
)

/**
 * The inline "oracle" chip (proto `.oic`) — opens the oracle-info card. A help
 * cursor, hairline border, phosphor on hover. `stopPropagation` so it never
 * triggers an underlying asset button.
 */
export const OracleChip: React.FC<{ sym: string; onOpen: (sym: string) => void }> = ({ sym, onOpen }) => (
  <Box
    as="button"
    type="button"
    display="inline-block"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="8.5px"
    letterSpacing="0.14em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textTertiary}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    borderRadius={0}
    px="6px"
    py="1px"
    ml="7px"
    cursor="help"
    verticalAlign="2px"
    bg="transparent"
    transition={TRANSITIONS.colors}
    _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
    _focus={FOCUS_STYLES.ring}
    onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation()
      onOpen(sym)
    }}
  >
    oracle
  </Box>
)
