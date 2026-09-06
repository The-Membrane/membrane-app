import React, { useState } from 'react'
import { Box, Heading, HStack, Input, Select, Slider, SliderFilledTrack, SliderThumb, SliderTrack, Text, VStack, Wrap } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { DemoAwareCta } from '@/components/demo'

import { DEFAULT_STAKE_AMOUNT, DEFAULT_STAKE_SEAT, SEAT_OPTIONS } from './fixtures'
import { buildStakeRequest, sacrificeMultiplier } from './utils'
import { useExecutionSheet } from './hooks/useExecutionSheet'

/** Hero + stake box — "Your stake, your seat, your fees." (proto :169-189). */
export const Hero: React.FC = () => {
  const { open } = useExecutionSheet()
  const [seat, setSeat] = useState(DEFAULT_STAKE_SEAT)
  const [amount, setAmount] = useState(DEFAULT_STAKE_AMOUNT)
  const [sacrificeRatio, setSacrificeRatio] = useState(0)

  return (
    <VStack align="stretch" spacing={SPACING.md}>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        letterSpacing="0.28em"
        textTransform="uppercase"
        color={SEMANTIC_COLORS.textSecondary}
      >
        Earn
      </Text>

      <Heading as="h1" fontFamily={TYPOGRAPHY.fontDisplay} fontWeight={TYPOGRAPHY.normal} fontSize={TYPOGRAPHY.h1} color={SEMANTIC_COLORS.textPrimary}>
        Your stake, your seat, your fees.
      </Heading>

      <Card variant="default">
        <Wrap spacing={SPACING.md} align="center">
          <Select
            aria-label="Choose a seat"
            value={seat}
            onChange={(e) => setSeat(e.target.value)}
            w="auto"
            size="sm"
            bg={SEMANTIC_COLORS.bgTertiary}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            borderRadius={0}
            color={SEMANTIC_COLORS.textPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            transition={TRANSITIONS.colors}
            _focus={FOCUS_STYLES.ring}
          >
            {SEAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} style={{ background: SEMANTIC_COLORS.bgTertiary }}>
                {opt.label}
              </option>
            ))}
          </Select>

          <Input
            aria-label="Stake amount, USD"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="numeric"
            w="120px"
            size="sm"
            textAlign="right"
            bg={SEMANTIC_COLORS.bgTertiary}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            borderRadius={0}
            color={SEMANTIC_COLORS.textPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            transition={TRANSITIONS.colors}
            _focus={FOCUS_STYLES.ring}
          />

          <VStack spacing={SPACING.xs} minW="220px" align="stretch">
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.12em">
              boost: give up{' '}
              <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
                {sacrificeRatio}%
              </Text>{' '}
              of fees &rarr;{' '}
              <Text as="span" color={SEMANTIC_COLORS.success}>
                {sacrificeMultiplier(sacrificeRatio)}
              </Text>{' '}
              points
            </Text>
            <Slider
              aria-label="Sacrifice ratio, percent of fees"
              min={0}
              max={100}
              step={5}
              value={sacrificeRatio}
              onChange={setSacrificeRatio}
              focusThumbOnChange={false}
            >
              <SliderTrack bg={SEMANTIC_COLORS.borderStrong} h="2px">
                <SliderFilledTrack bg={SEMANTIC_COLORS.success} />
              </SliderTrack>
              <SliderThumb boxSize="10px" borderRadius={0} bg={SEMANTIC_COLORS.success} _focus={FOCUS_STYLES.ring} />
            </Slider>
          </VStack>

          <DemoAwareCta
            onAction={() => open(buildStakeRequest(seat, amount, sacrificeRatio))}
            bg={SEMANTIC_COLORS.success}
            color={SEMANTIC_COLORS.bgPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            textTransform="uppercase"
            letterSpacing="0.14em"
            transition={TRANSITIONS.colors}
            _hover={{ bg: SEMANTIC_COLORS.success, opacity: 0.85 }}
          >
            Stake
          </DemoAwareCta>
        </Wrap>
      </Card>

      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} maxW="72ch" lineHeight={1.7}>
        Suppliers here do not pick markets — liquidity is global. What you choose is your seat. Everything below
        the box is what that choice means: what backs you, where losses hit before they reach you, what your
        seat has paid, and what you could list next.
      </Text>
    </VStack>
  )
}

export default Hero
