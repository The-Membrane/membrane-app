import React, { createContext, useContext } from 'react'
import { Box, Text, TextProps, HStack, StackProps } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { MockStamp } from '@/components/demo'

/**
 * Veteran view (VETERAN_UX_RULESET V9, ported from `body.vet` in the proto):
 * warm teaching text leaves the hot path once competence exists; decayed text
 * collapses to a badge (V4), not to nothing. The context carries the boolean so
 * Warm/VetBadge don't need prop-drilling.
 */
const VeteranContext = createContext(false)
export const VeteranProvider = VeteranContext.Provider
export const useVeteran = () => useContext(VeteranContext)

/** Warm teaching copy — hidden in veteran view. */
export const Warm: React.FC<TextProps & { children: React.ReactNode; as?: 'p' | 'span' }> = ({
  children,
  as: asEl,
  ...props
}) => {
  const vet = useVeteran()
  if (vet) return null
  if (asEl === 'span')
    return (
      <Text as="span" {...props}>
        {children}
      </Text>
    )
  return <Text {...props}>{children}</Text>
}

/** A raw warm wrapper that only gates visibility (for inline spans/blocks). */
export const WarmGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const vet = useVeteran()
  if (vet) return null
  return <>{children}</>
}

/** The badge that replaces warm copy in veteran view, e.g. "venue rates". */
export const VetBadge: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const vet = useVeteran()
  if (!vet) return null
  return (
    <Box
      as="span"
      display="inline-block"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="8.5px"
      letterSpacing="0.2em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      px={SPACING.sm}
      py="2px"
      ml={SPACING.sm}
      verticalAlign="4px"
    >
      {children}
    </Box>
  )
}

/** Mono uppercase eyebrow (11px, 0.28em tracking, textSecondary). */
export const Eyebrow: React.FC<TextProps & { children: React.ReactNode }> = ({ children, ...props }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    letterSpacing="0.28em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textSecondary}
    {...props}
  >
    {children}
  </Text>
)

/** A numbered section header: "02 / <title>" with an optional warm note. */
export const SectionHead: React.FC<
  StackProps & { index: string; title: string; note?: React.ReactNode; children?: React.ReactNode }
> = ({ index, title, note, children, ...props }) => (
  <HStack
    align="baseline"
    spacing={SPACING.md}
    mt={SPACING.xl}
    mb={SPACING.md}
    flexWrap="wrap"
    {...props}
  >
    <Eyebrow>{index}</Eyebrow>
    <Text
      fontFamily={TYPOGRAPHY.fontDisplay}
      fontSize="20px"
      color={SEMANTIC_COLORS.textPrimary}
      letterSpacing="-0.01em"
    >
      {title}
    </Text>
    <MockStamp />
    {note && (
      <Warm
        as="span"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        color={SEMANTIC_COLORS.textTertiary}
      >
        {note}
      </Warm>
    )}
    {children}
  </HStack>
)
