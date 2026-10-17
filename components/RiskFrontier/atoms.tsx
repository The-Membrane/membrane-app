import React from 'react'
import { Box, HStack, Text, Wrap, WrapItem } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { LEGEND, STRESS_CODE_VERSION, STRESS_LABEL, type Glyph, type Tone } from './viewModel'

export { Eyebrow, Panel } from '@/components/Practice/atoms'

/** Tone → theme token. Every tone also has its own glyph, so colour never carries meaning alone. */
export const TONE_COLOR: Record<Tone | 'idle', string> = {
  clear: SEMANTIC_COLORS.success,
  recall: SEMANTIC_COLORS.info,
  armed: SEMANTIC_COLORS.warning,
  call: SEMANTIC_COLORS.riskCaution,
  sold: SEMANTIC_COLORS.danger,
  muted: SEMANTIC_COLORS.textTertiary,
  idle: SEMANTIC_COLORS.borderStrong,
}

/** Diagonal hatch for "not modelled": never coloured, never green. */
export const HATCH = `repeating-linear-gradient(135deg, transparent 0 4px, ${SEMANTIC_COLORS.borderStrong} 4px 5px)`

/** The short code stamp: "stress-grid/4". The full string lives in the footer and the detail panel. */
export const CODE_SHORT = STRESS_CODE_VERSION.split(' · ')[0]

/** CSS that switches every animation in a subtree off under prefers-reduced-motion. */
export const REDUCED_MOTION_SX = {
  '@media (prefers-reduced-motion: reduce)': {
    '& *, &': { animation: 'none !important', transition: 'none !important' },
  },
} as const

export const GlyphMark: React.FC<{ glyph: Glyph; tone: Tone; size?: string; title?: string }> = ({
  glyph,
  tone,
  size = '14px',
  title,
}) =>
  glyph === '░' ? (
    <Box
      as="span"
      display="inline-block"
      w={size}
      h={size}
      flexShrink={0}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      bgImage={HATCH}
      role="img"
      aria-label={title ?? 'not modelled'}
      title={title}
    />
  ) : (
    <Text
      as="span"
      display="inline-block"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={size}
      lineHeight={1}
      color={TONE_COLOR[tone]}
      flexShrink={0}
      aria-hidden={title ? undefined : true}
      title={title}
    >
      {glyph}
    </Text>
  )

/** Every result block carries this: the label and the code base. */
export const StressStamp: React.FC<{ full?: boolean }> = ({ full }) => (
  <HStack spacing={SPACING.sm} flexWrap="wrap" rowGap={SPACING.xs}>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.label}
      letterSpacing="0.06em"
      color={SEMANTIC_COLORS.textSecondary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      px={SPACING.sm}
      py={SPACING.none}
      whiteSpace="nowrap"
    >
      {STRESS_LABEL}
    </Text>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.label}
      color={SEMANTIC_COLORS.textTertiary}
      title={STRESS_CODE_VERSION}
      wordBreak="break-word"
    >
      {full ? STRESS_CODE_VERSION : CODE_SHORT}
    </Text>
  </HStack>
)

/** Section header: eyebrow title on the left, the stress stamp on the right. */
export const SectionHead: React.FC<{ title: string; kicker?: string; right?: React.ReactNode }> = ({
  title,
  kicker,
  right,
}) => (
  <HStack
    justify="space-between"
    align="flex-start"
    flexWrap="wrap"
    gap={SPACING.sm}
    mb={SPACING.md}
  >
    <Box>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        letterSpacing="0.24em"
        textTransform="uppercase"
        color={SEMANTIC_COLORS.success}
      >
        {title}
      </Text>
      {kicker && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={SEMANTIC_COLORS.textTertiary}
          mt={SPACING.xs}
        >
          {kicker}
        </Text>
      )}
    </Box>
    {right ?? <StressStamp />}
  </HStack>
)

/** The outcome legend (glyph + words). `delayed` false drops ▲: the no-delay class has no window. */
export const Legend: React.FC<{ delayed: boolean; extra?: React.ReactNode }> = ({
  delayed,
  extra,
}) => (
  <Wrap spacing={SPACING.md} mt={SPACING.md}>
    {LEGEND.filter((l) => delayed || l.glyph !== '▲').map((l) => (
      <WrapItem key={l.glyph}>
        <HStack spacing={SPACING.sm}>
          <GlyphMark glyph={l.glyph} tone={l.tone} size="12px" />
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            color={SEMANTIC_COLORS.textSecondary}
          >
            {l.text}
          </Text>
        </HStack>
      </WrapItem>
    ))}
    {extra && <WrapItem>{extra}</WrapItem>}
  </Wrap>
)
