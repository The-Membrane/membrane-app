// The detail of one keyed node: what happened, the dollars, the times, and the key that
// reproduces it. Follows the current inputs (the selection is re-resolved every compute).

import React from 'react'
import { Box, HStack, SimpleGrid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { GlyphMark, Panel, SectionHead, StressStamp, TONE_COLOR } from './atoms'
import { detailRows, leafView, outcomeTitle, type ResolvedSelection } from './viewModel'

const KEY_ROWS = new Set(['scenario', 'cell key', 'code'])

export const LeafDetail: React.FC<{ sel: ResolvedSelection }> = ({ sel }) => {
  const r = sel.result
  const leaf = leafView(r, sel.missing ?? undefined)
  const rows = r ? detailRows(r) : []
  const facts = rows.filter((x) => !KEY_ROWS.has(x.label))
  const keys = rows.filter((x) => KEY_ROWS.has(x.label))
  return (
    // Not a live region: the whole panel was one, so every recompute re-read every fact.
    <Panel accent={TONE_COLOR[leaf.tone]}>
      <SectionHead
        title="Node detail"
        kicker={`${sel.title}${sel.sub ? ` · ${sel.sub}` : ''}`}
        right={<span />}
      />
      <HStack spacing={SPACING.sm} align="center" mb={SPACING.md}>
        <GlyphMark glyph={leaf.glyph} tone={leaf.tone} size={TYPOGRAPHY.h3} title={leaf.title} />
        {/* Mono: the title carries a dollar figure ("Collateral sold: $1,400"). */}
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.h4}
          lineHeight={1.3}
          color={SEMANTIC_COLORS.textPrimary}
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {r ? outcomeTitle(r) : `Not modelled: ${sel.missing ?? 'no result'}`}
        </Text>
      </HStack>
      {facts.length > 0 && (
        <SimpleGrid columns={{ base: 2, sm: 3, xl: 4 }} spacingX={SPACING.md} spacingY={SPACING.sm}>
          {facts.map((f) => (
            <Box key={f.label} minW={0}>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                letterSpacing="0.2em"
                textTransform="uppercase"
                color={SEMANTIC_COLORS.textTertiary}
              >
                {f.label}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={f.tone ? TONE_COLOR[f.tone] : SEMANTIC_COLORS.textPrimary}
                sx={{ fontVariantNumeric: 'tabular-nums' }}
                wordBreak="break-word"
              >
                {f.value}
              </Text>
            </Box>
          ))}
        </SimpleGrid>
      )}
      {keys.length > 0 && (
        <Box
          mt={SPACING.md}
          pt={SPACING.sm}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          display="grid"
          gap={SPACING.xs}
        >
          {keys.map((k) => (
            <HStack key={k.label} spacing={SPACING.sm} align="baseline">
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                letterSpacing="0.2em"
                textTransform="uppercase"
                color={SEMANTIC_COLORS.textTertiary}
                minW="72px"
              >
                {k.label}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textSecondary}
                wordBreak="break-all"
                userSelect="all"
              >
                {k.value}
              </Text>
            </HStack>
          ))}
        </Box>
      )}
      <Box mt={SPACING.md}>
        <StressStamp full />
      </Box>
    </Panel>
  )
}
