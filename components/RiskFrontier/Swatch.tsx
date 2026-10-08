// The swatch: the power-user grid (design §2). Every price shape × every single-axis venue
// condition, the same keyed nodes as the tree. Never a combined route.

import React from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { GlyphMark, HATCH, Legend, TONE_COLOR } from './atoms'
import type { Selection, Swatch as SwatchModel } from './viewModel'

/** A named capacity cut ('exit ×0.9032 · Aave USDC $50M bad') gets a wider column than a bare
 *  'freeze 4h', so its source reads in a few lines; the grid scrolls inside its own box. */
const colWidth = (c: string): number => (c.length > 24 ? 168 : 88)

export const Swatch: React.FC<{
  swatch: SwatchModel
  delayed: boolean
  selected: Selection | null
  onSelect: (s: Selection) => void
}> = ({ swatch, delayed, selected, onSelect }) => (
  <Box>
    <Box overflowX="auto" mx={-SPACING.xs} px={SPACING.xs}>
      <Box
        as="table"
        w="100%"
        minW={`${120 + swatch.cols.reduce((w, c) => w + colWidth(c), 0)}px`}
        sx={{ borderCollapse: 'separate', borderSpacing: '4px' }}
        aria-label="Stress swatch: price shapes by venue conditions"
      >
        <thead>
          <tr>
            <Box as="th" />
            {swatch.cols.map((c) => (
              <Box
                as="th"
                key={c}
                scope="col"
                minW={`${colWidth(c)}px`}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                fontWeight={400}
                letterSpacing="0.12em"
                textTransform="uppercase"
                color={SEMANTIC_COLORS.textTertiary}
                textAlign="left"
                pb={SPACING.xs}
              >
                {c}
              </Box>
            ))}
          </tr>
        </thead>
        <tbody>
          {swatch.rows.map((row, ri) => (
            <tr key={row.key}>
              <Box
                as="th"
                scope="row"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                fontWeight={400}
                color={SEMANTIC_COLORS.textPrimary}
                textAlign="left"
                whiteSpace="nowrap"
                pr={SPACING.sm}
              >
                {row.label}
              </Box>
              {row.cells.map((cell, ci) => {
                const active =
                  selected?.kind === 'swatch' && selected.row === ri && selected.col === ci
                const color = TONE_COLOR[cell.leaf.tone]
                const nm = cell.leaf.glyph === '░'
                return (
                  <Box as="td" key={cell.key} p={0}>
                    <Box
                      as="button"
                      type="button"
                      onClick={() => onSelect({ kind: 'swatch', row: ri, col: ci })}
                      aria-pressed={active}
                      aria-label={`${row.label}, ${swatch.cols[ci]}: ${cell.leaf.title}, ${cell.leaf.short}`}
                      title={`${cell.leaf.title} · ${cell.leaf.short}`}
                      w="100%"
                      minH="40px"
                      textAlign="left"
                      px={SPACING.sm}
                      py={SPACING.sm}
                      border="1px solid"
                      borderColor={active ? color : SEMANTIC_COLORS.borderSubtle}
                      bg={nm ? undefined : SEMANTIC_COLORS.bgTertiary}
                      bgImage={nm ? HATCH : undefined}
                      boxShadow={nm ? undefined : `inset 3px 0 0 ${color}`}
                      cursor="pointer"
                      _hover={{ borderColor: color }}
                      _focusVisible={FOCUS_STYLES.ring}
                    >
                      <HStack as="span" spacing={SPACING.sm} minW={0} align="flex-start">
                        <GlyphMark glyph={cell.leaf.glyph} tone={cell.leaf.tone} size="12px" />
                        <Text
                          as="span"
                          fontFamily={TYPOGRAPHY.fontMono}
                          fontSize={TYPOGRAPHY.label}
                          color={nm ? SEMANTIC_COLORS.textTertiary : color}
                          lineHeight={1.35}
                          sx={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                          {cell.text}
                        </Text>
                      </HStack>
                    </Box>
                  </Box>
                )
              })}
            </tr>
          ))}
        </tbody>
      </Box>
    </Box>
    <Legend delayed={delayed} />
  </Box>
)
