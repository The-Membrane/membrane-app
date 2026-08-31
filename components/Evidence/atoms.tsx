import { Box, HStack, Text, Tooltip, VStack } from '@chakra-ui/react'
import React from 'react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

/** Mono, uppercase, letterspaced section label. */
export const Eyebrow: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = SEMANTIC_COLORS.textSecondary,
}) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    textTransform="uppercase"
    letterSpacing="0.28em"
    color={color}
  >
    {children}
  </Text>
)

/** A single number with a label under it. Numbers are always mono. */
export const Stat: React.FC<{
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'good' | 'bad' | 'muted'
}> = ({ label, value, sub, tone = 'default' }) => {
  const color =
    tone === 'good'
      ? SEMANTIC_COLORS.success
      : tone === 'bad'
        ? SEMANTIC_COLORS.danger
        : tone === 'muted'
          ? SEMANTIC_COLORS.textSecondary
          : SEMANTIC_COLORS.textPrimary
  return (
    <VStack align="flex-start" spacing={SPACING.xs}>
      <Eyebrow>{label}</Eyebrow>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.h2} color={color}>
        {value}
      </Text>
      {sub ? (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {sub}
        </Text>
      ) : null}
    </VStack>
  )
}

/**
 * Two bars on a shared scale. Used everywhere the point is "this engine does
 * less than that one" — the comparison must be visual, not two numbers in prose.
 */
export const CompareBar: React.FC<{
  aLabel: string
  aValue: number
  bLabel: string
  bValue: number
  format: (n: number) => string
}> = ({ aLabel, aValue, bLabel, bValue, format }) => {
  const max = Math.max(aValue, bValue, 1e-9)
  const row = (label: string, v: number, color: string) => (
    <VStack align="stretch" spacing={SPACING.xs} w="100%">
      <HStack justify="space-between">
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          {label}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={SEMANTIC_COLORS.textPrimary}
        >
          {format(v)}
        </Text>
      </HStack>
      <Box h="6px" w="100%" bg={SEMANTIC_COLORS.bgTertiary}>
        <Box h="100%" w={`${Math.max(0, (v / max) * 100)}%`} bg={color} />
      </Box>
    </VStack>
  )
  return (
    <VStack align="stretch" spacing={SPACING.sm} w="100%">
      {row(aLabel, aValue, SEMANTIC_COLORS.danger)}
      {row(bLabel, bValue, SEMANTIC_COLORS.success)}
    </VStack>
  )
}

/**
 * The honesty layer. Rendered inline at the foot of every lens, never collapsed
 * behind a toggle — a caveat you have to click to see is a caveat you hid.
 *
 * Living Typeface treatment: a gold section rule (gold = gates/caution), a numbered
 * eyebrow, then hairline-separated rows with a hanging mono index. The indices make
 * the list countable at a glance, so "five caveats" is legible without reading — the
 * point is that there ARE this many, stated up front.
 */
export const Caveats: React.FC<{ items: string[]; title?: string }> = ({
  items,
  title = 'What this does not show',
}) => (
  <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.warning} pt={SPACING_PATTERNS.cardPadding}>
    <VStack align="stretch" spacing={SPACING.none}>
      <HStack justify="space-between" align="baseline" pb={SPACING.md}>
        <Eyebrow color={SEMANTIC_COLORS.warning}>{title}</Eyebrow>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textTertiary}
          letterSpacing="0.28em"
        >
          {String(items.length).padStart(2, '0')}
        </Text>
      </HStack>

      {items.map((c, i) => (
        <HStack
          key={c}
          align="flex-start"
          spacing={SPACING.base}
          py={SPACING.md}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.textTertiary}
            letterSpacing="0.28em"
            flexShrink={0}
            pt="2px"
            minW="2.4em"
          >
            {String(i + 1).padStart(2, '0')}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
            lineHeight="1.8"
          >
            {c}
          </Text>
        </HStack>
      ))}
    </VStack>
  </Box>
)

/**
 * Hairline "i" affordance with an explanatory tooltip.
 *
 * A square, not a circle — nothing in Living Typeface is rounded. Deliberately NOT
 * a react-icons import: that barrel is ~4MB and already a measured contributor to
 * the oversized _app chunk, which is far too much weight for one glyph.
 *
 * Chakra only mounts tooltip content on hover, so the explanation would otherwise
 * be invisible to screen readers and crawlers. The trigger's aria-label therefore
 * carries the FULL legend, not a pointer to it ("what this means" tells a
 * non-sighted user nothing). `term` prefixes it so the announcement reads
 * "Cured: Did the price recover...".
 */
export const InfoTip: React.FC<{ term: string; label: string }> = ({ term, label }) => (
  <Tooltip
    label={label}
    aria-label={`${term}: ${label}`}
    hasArrow={false}
    placement="top"
    openDelay={120}
    maxW="320px"
    bg={SEMANTIC_COLORS.bgSecondary}
    color={SEMANTIC_COLORS.textPrimary}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderStrong}
    borderRadius={0}
    px={SPACING.md}
    py={SPACING.sm}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.xs}
    fontWeight={TYPOGRAPHY.normal}
    letterSpacing="normal"
    textTransform="none"
    lineHeight="1.7"
  >
    <Box
      as="span"
      role="button"
      tabIndex={0}
      aria-label={`${term}: ${label}`}
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      w="14px"
      h="14px"
      ml={SPACING.xs}
      flexShrink={0}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      color={SEMANTIC_COLORS.textTertiary}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="9px"
      lineHeight="1"
      letterSpacing="normal"
      textTransform="none"
      cursor="help"
      transition={TRANSITIONS.colors}
      _hover={{ color: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.success }}
      _focusVisible={FOCUS_STYLES.ring}
    >
      i
    </Box>
  </Tooltip>
)

/** The four states the "Cured" column can take. Defined once, used everywhere. */
export const CURE_LEGEND =
  'Did the price recover enough to bring the account back under its own liquidation ' +
  'line inside Membrane’s 8-hour cure window? Aave grants no such window — its ' +
  'liquidation is atomic, in the same block. ' +
  'yes = recovered and still healthy at hour 8. ' +
  '8h = recovered, then breached again before hour 8. ' +
  'no = never recovered. ' +
  '— = the Oct 10 oracle series cannot price this collateral.'

export const usd = (n: number): string => {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}k`
  return `$${n.toFixed(0)}`
}

export const pct = (frac: number, dp = 1): string => `${(frac * 100).toFixed(dp)}%`
