import React from 'react'
import { Box, Grid, HStack, Text, VStack } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, SectionHead } from './primitives'
import { BANDS } from './fixtures'

/** Section 4 — calibration: is it luck? Scored only on resolved calls. */
export const Calibration: React.FC = () => (
  <>
    <SectionHead index="04 /" title="Is it luck?" note="Scored only on calls that have actually resolved." />
    <Grid id="cal2" gridTemplateColumns={{ base: '1fr', lg: 'minmax(0,1fr) minmax(0,1.1fr)' }} gap={SPACING.base}>
      <Card>
        <Eyebrow>Better than a coin flip</Eyebrow>
        <HStack align="flex-end" spacing={SPACING.md} mt={SPACING.md}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="44px" lineHeight={1} color={SEMANTIC_COLORS.success}>
            +31%
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textSecondary} pb={SPACING.xs}>
            across 46 resolved calls
            <br />
            Brier 0.172
          </Text>
        </HStack>
        <VStack align="stretch" spacing="5px" mt={SPACING.base}>
          {[
            { k: 'Best subject', v: 'venue liquidity', gold: false },
            { k: 'Weakest subject', v: 'how long a depeg lasts', gold: true },
            { k: 'Overconfidence bias', v: '+6 pts', gold: false },
          ].map((r) => (
            <HStack key={r.k} justify="space-between" fontSize="10.5px" color={SEMANTIC_COLORS.textSecondary}>
              <Text as="span">{r.k}</Text>
              <Box as="span" fontWeight={400} color={r.gold ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textPrimary}>
                {r.v}
              </Box>
            </HStack>
          ))}
        </VStack>
        <Box
          as="button"
          type="button"
          display="block"
          w="100%"
          mt={SPACING.base}
          textAlign="left"
          bg="transparent"
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
          color={SEMANTIC_COLORS.textPrimary}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          letterSpacing="0.16em"
          textTransform="uppercase"
          p="13px 14px"
          cursor="pointer"
          transition={TRANSITIONS.colors}
          _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
          _focus={FOCUS_STYLES.ring}
        >
          Enter the training grounds
          <Box as="small" display="block" letterSpacing="0.02em" textTransform="none" fontSize="10.5px" color={SEMANTIC_COLORS.textTertiary} mt="5px">
            Post P(I breach 80% headroom) before the week runs, and get scored when it resolves. Nothing you do
            there touches this position.
          </Box>
        </Box>
      </Card>

      <Card>
        <Eyebrow>Calls by confidence band</Eyebrow>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary} m="8px 0 0" lineHeight={1.6}>
          Gold tick is where a perfectly calibrated person lands. Bar is how often you were actually right.
        </Text>
        <VStack align="stretch" spacing="7px" mt={SPACING.base}>
          {BANDS.map((b) => (
            <Grid key={b.k} gridTemplateColumns="74px 1fr 54px" gap="10px" alignItems="center" fontSize="10.5px">
              <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
                {b.k}
              </Text>
              <Box position="relative" h="7px" bg={SEMANTIC_COLORS.bgPrimary}>
                <Box position="absolute" top={0} bottom={0} left={0} w={`${b.hit}%`} bg={SEMANTIC_COLORS.info} />
                <Box position="absolute" top="-3px" bottom="-3px" left={`${b.ideal}%`} w="1px" bg={SEMANTIC_COLORS.warning} />
              </Box>
              <Text as="span" color={SEMANTIC_COLORS.textSecondary} textAlign="right">
                {b.hit}% · n={b.n}
              </Text>
            </Grid>
          ))}
        </VStack>
      </Card>
    </Grid>
  </>
)
