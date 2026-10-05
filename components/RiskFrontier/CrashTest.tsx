// Crash test: two "levels" (held −50% and −60% steps). The verdict is the user's OWN position
// run through that node; the limit beside it is the reverse solve (the highest start LTV
// with no sale, whole % toward risk). A level is cleared or not in this stress scenario;
// it is never a probability and never "safe".

import React from 'react'
import { Box, HStack, SimpleGrid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { GlyphMark, Panel, REDUCED_MOTION_SX, SectionHead, TONE_COLOR } from './atoms'
import {
  leafView,
  pct,
  usd,
  type CrashLevel,
  type FrontierModel,
  type Selection,
} from './viewModel'

/** The stamp's word. Its glyph and colour are the node's OWN outcome (CrashLevel.glyph/tone),
 *  so ● appears only for "no breach" — the legend's one glyph, one meaning. */
const VERDICT_WORD = {
  cleared: 'CLEARED',
  sold: 'SOLD',
  not_modelled: 'NOT MODELLED',
} as const

const Level: React.FC<{
  c: CrashLevel
  index: number
  active: boolean
  onSelect: () => void
}> = ({ c, index, active, onSelect }) => {
  const word = VERDICT_WORD[c.verdict]
  const color = TONE_COLOR[c.tone]
  const max = Math.max(c.line, c.userLtv, 0.01)
  const x = (ltv: number) => `${Math.max(0, Math.min(1, ltv / max)) * 100}%`
  const limitAt =
    c.limit.state === 'found' ? (c.limit.at as number) : c.limit.state === 'beyond' ? c.line : null
  const sold = c.node.outcome === 'sold' ? c.node.exposedUsd : 0
  const leaf = leafView(c.node)
  return (
    <Box
      as="button"
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      aria-label={`Crash test ${c.title}: ${word}${sold > 0 ? `, ${usd(sold)} sold` : ''}. ${c.summary}. Show this node.`}
      textAlign="left"
      position="relative"
      border="1px solid"
      borderColor={active ? color : SEMANTIC_COLORS.borderSubtle}
      bg={SEMANTIC_COLORS.bgTertiary}
      p={SPACING.base}
      overflow="hidden"
      cursor="pointer"
      _hover={{ borderColor: color }}
      _focusVisible={FOCUS_STYLES.ring}
      transition={TRANSITIONS.colors}
    >
      <HStack justify="space-between" align="flex-start">
        <Box>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            letterSpacing="0.24em"
            color={SEMANTIC_COLORS.textTertiary}
          >
            LEVEL {index + 1} · HELD STEP
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.h2}
            lineHeight={1.2}
            color={SEMANTIC_COLORS.textPrimary}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {c.title}
          </Text>
        </Box>
        {/* the stamp */}
        <Box
          border="2px solid"
          borderColor={color}
          color={color}
          px={SPACING.sm}
          py={SPACING.sm}
          transform="rotate(-4deg)"
          textAlign="center"
          minW="96px"
          transition={TRANSITIONS.colors}
        >
          <HStack spacing={SPACING.sm} justify="center">
            <GlyphMark glyph={c.glyph} tone={c.tone} size={TYPOGRAPHY.small} />
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              letterSpacing="0.16em"
              fontWeight={700}
            >
              {word}
            </Text>
          </HStack>
          {sold > 0 && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              mt={SPACING.xs}
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {usd(sold)}
            </Text>
          )}
        </Box>
      </HStack>

      {/* start-LTV bar: no-sale zone up to the limit, you on it */}
      <Box position="relative" mt={SPACING.xl} mb={SPACING.base}>
        <Box
          position="relative"
          h="8px"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          {limitAt !== null && (
            <Box
              position="absolute"
              left={0}
              top={0}
              bottom={0}
              w={x(limitAt)}
              bg={TONE_COLOR.clear}
              opacity={0.22}
            />
          )}
          {limitAt !== null && limitAt < max && (
            <Box
              position="absolute"
              left={x(limitAt)}
              right={0}
              top={0}
              bottom={0}
              bg={TONE_COLOR.sold}
              opacity={0.18}
            />
          )}
          {limitAt !== null && (
            <Box
              position="absolute"
              left={x(limitAt)}
              top="-6px"
              bottom="-6px"
              w="1px"
              bg={TONE_COLOR.clear}
            >
              <Text
                position="absolute"
                bottom="16px"
                left="0"
                transform={limitAt / max > 0.7 ? 'translateX(-100%)' : 'translateX(-10%)'}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                color={TONE_COLOR.clear}
                whiteSpace="nowrap"
              >
                {c.limit.state === 'beyond' ? 'no sale up to the line' : `limit ${c.limit.text}`}
              </Text>
            </Box>
          )}
          <Box
            position="absolute"
            left={x(c.userLtv)}
            top="-7px"
            bottom="-7px"
            w="3px"
            ml="-1px"
            bg={color}
          >
            <Text
              position="absolute"
              top="22px"
              left="0"
              transform={c.userLtv / max > 0.7 ? 'translateX(-100%)' : 'translateX(-10%)'}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              color={color}
              whiteSpace="nowrap"
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              you {pct(c.userLtv)}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* what your own node did at this drop: "cleared" only means nothing was sold */}
      <HStack spacing={SPACING.sm} mb={SPACING.xs}>
        <GlyphMark glyph={leaf.glyph} tone={leaf.tone} size="12px" />
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          color={TONE_COLOR[leaf.tone]}
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {leaf.title} · {leaf.short}
        </Text>
      </HStack>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        color={SEMANTIC_COLORS.textSecondary}
        lineHeight={1.5}
      >
        {c.summary}
      </Text>
    </Box>
  )
}

export const CrashTest: React.FC<{
  model: FrontierModel
  selected: Selection | null
  onSelect: (s: Selection) => void
}> = ({ model, selected, onSelect }) => {
  return (
    <Panel sx={REDUCED_MOTION_SX}>
      <SectionHead
        title="Crash test"
        kicker="highest start LTV with no sale, vs yours · whole %, toward risk"
      />
      <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={SPACING.md}>
        {model.crash.map((c, i) => (
          <Level
            key={c.drop}
            c={c}
            index={i}
            active={selected?.kind === 'crash' && selected.index === i}
            onSelect={() => onSelect({ kind: 'crash', index: i })}
          />
        ))}
      </SimpleGrid>
    </Panel>
  )
}
