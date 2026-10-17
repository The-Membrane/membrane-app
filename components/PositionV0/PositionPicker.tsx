// When an address holds several positions: a compact list, nearest its line first. The
// page shows one at a time; the first is selected by default.

import React from 'react'
import { Box, Button } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'

import { Kicker } from './primitives'
import { TYPE } from './typeScale'
import { fmtUsd } from '@/lib/position/format'

import { lineTag, noLines, positionSizeUsd, type PositionView } from './viewModel'

/** "$277" / "<$1" (something, under a dollar) / "$0". */
const sizeText = (x: number) => (x >= 1 || x === 0 ? fmtUsd(x) : '<$1')

export const PositionPicker: React.FC<{
  views: PositionView[]
  selectedKey: string
  onSelect: (key: string) => void
  /** Supply positions worth under one unit, folded into one line under the list. */
  dust?: number
}> = ({ views, selectedKey, onSelect, dust = 0 }) => (
  <Box display="grid" gap={SPACING.xs} pt={SPACING.base} minW={0}>
    <Kicker tone="muted">
      {views.length} position{views.length === 1 ? '' : 's'} · {noLines(views) ? 'largest first' : 'nearest its line first'}
    </Kicker>
    <Box role="radiogroup" aria-label="Positions at this address" display="grid" borderTop={`1px solid ${NEWS.rule}`}>
      {views.map((v) => {
        const on = v.key === selectedKey
        return (
          <Button
            key={v.key}
            role="radio"
            aria-checked={on}
            variant="unstyled"
            onClick={() => onSelect(v.key)}
            display="grid"
            gridTemplateColumns="minmax(0, 1fr) auto"
            alignItems="center"
            columnGap={SPACING.sm}
            h="auto"
            minH="44px"
            px={0}
            textAlign="left"
            borderRadius={0}
            borderBottom={`1px solid ${NEWS.rule}`}
            fontFamily={NEWS_FONT.mono}
            fontSize={TYPE.body}
            fontWeight={on ? 700 : 400}
            color={on ? NEWS.ink : NEWS.ink2}
            whiteSpace="normal"
            transition={TRANSITIONS.colors}
            _hover={{ color: NEWS.ink }}
          >
            <Box as="span" minW={0} overflowWrap="anywhere">
              {on ? '● ' : '○ '}
              {v.title}
            </Box>
            <Box as="span" whiteSpace="nowrap" color={v.hero.kind === 'past' ? NEWS.danger : 'inherit'}>
              {sizeText(positionSizeUsd(v))} · {lineTag(v)}
            </Box>
          </Button>
        )
      })}
      {dust > 0 && (
        <Box py={SPACING.sm} borderBottom={`1px solid ${NEWS.rule}`} fontFamily={NEWS_FONT.mono} fontSize={TYPE.body} color={NEWS.muted}>
          {dust} dust supply position{dust === 1 ? '' : 's'} (&lt; 1 unit)
        </Box>
      )}
    </Box>
  </Box>
)
