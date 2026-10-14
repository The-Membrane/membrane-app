// When an address holds several positions: a compact list, nearest its line first. The
// page shows one at a time; the first is selected by default.

import React from 'react'
import { Box, Button } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'

import { Kicker } from './primitives'
import { TYPE } from './typeScale'
import { lineTag, type PositionView } from './viewModel'

export const PositionPicker: React.FC<{
  views: PositionView[]
  selectedKey: string
  onSelect: (key: string) => void
}> = ({ views, selectedKey, onSelect }) => (
  <Box display="grid" gap={SPACING.xs} pt={SPACING.base} minW={0}>
    <Kicker tone="muted">{views.length} positions · nearest its line first</Kicker>
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
              {lineTag(v)}
            </Box>
          </Button>
        )
      })}
    </Box>
  </Box>
)
