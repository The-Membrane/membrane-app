// The conditional Membrane line (DESIGN_RULES §4): built from the contract constants, and
// conditional by construction — "within 4% of the line, liquidation waits 8 hours", never
// "8 hours before liquidation". Modelled: there is no Membrane mainnet deployment yet.

import React from 'react'
import { Text } from '@chakra-ui/react'

import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'

import { Section } from './primitives'
import { TYPE } from './typeScale'
import { MEMBRANE_LINE } from './viewModel'

export const MembraneLine: React.FC = () => (
  <Section id="membrane">
    <Text fontFamily={NEWS_FONT.display} fontStyle="italic" fontSize={TYPE.head} lineHeight={1.3} color={NEWS.ink}>
      {MEMBRANE_LINE}†
    </Text>
  </Section>
)
