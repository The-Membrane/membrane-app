import React, { useEffect, useState } from 'react'
import { Box, Grid, HStack, Text, VStack } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, SectionHead } from './primitives'
import { renderEmphasis } from './utils'

const RECAP_LINES = [
  '**$186.40** harvested across 23 belt deliveries — your busiest week yet.',
  'That’s **nine months of Claude Pro**, delivered in seven days — at list price, already realized.',
  '**23.4 days** of debt burned. Self-repayment moved 41 days closer.',
  'Headroom bottomed at **9.4 hours** on Thursday, then recovered. You were drawn at 41%; at 55% the engine would have recalled.',
  'The you-that-sold in January is **0.19 BTC behind** — ghost line net of exit cost and tax.',
  'You called 3 floors, got **2 right**, and were {neg}14 points overconfident{/neg} on the third.',
]

const ShareBtn: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Box
    as="button"
    type="button"
    bg="transparent"
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderStrong}
    color={SEMANTIC_COLORS.textSecondary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.16em"
    textTransform="uppercase"
    p="9px 13px"
    cursor="pointer"
    transition={TRANSITIONS.colors}
    _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
    _focus={FOCUS_STYLES.ring}
  >
    {children}
  </Box>
)

/** Section 5 — the weekly Ditto recap card. The familiar blinks, nothing else. */
export const DittoRecap: React.FC = () => {
  const [blink, setBlink] = useState(false)

  useEffect(() => {
    const iv = setInterval(() => {
      setBlink(true)
      setTimeout(() => setBlink(false), 130)
    }, 5200)
    return () => clearInterval(iv)
  }, [])

  const eyeY = blink ? 7 : 6
  const eyeH = blink ? 0.5 : 2

  return (
    <>
      <SectionHead index="05 /" title="This week" note="Ditto writes one of these every Sunday. It is the card you can hand to someone else." />
      <Card as={Grid} gridTemplateColumns={{ base: '1fr', md: '96px 1fr' }} gap={SPACING.base} alignItems="start">
        <Box w="96px" h="96px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} display="grid" placeItems="center">
          <svg width="64" height="64" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-label="Ditto">
            <g fill={SEMANTIC_COLORS.success}>
              <rect x="5" y="2" width="6" height="1" />
              <rect x="4" y="3" width="8" height="1" />
              <rect x="3" y="4" width="10" height="1" />
              <rect x="3" y="5" width="10" height="1" />
              <rect x="2" y="6" width="12" height="1" />
              <rect x="2" y="7" width="12" height="1" />
              <rect x="2" y="8" width="12" height="1" />
              <rect x="3" y="9" width="10" height="1" />
              <rect x="3" y="10" width="10" height="1" />
              <rect x="4" y="11" width="8" height="1" />
              <rect x="5" y="12" width="6" height="1" />
            </g>
            <g fill={SEMANTIC_COLORS.bgPrimary}>
              <rect x="5" y={eyeY} width="2" height={eyeH} />
              <rect x="9" y={eyeY} width="2" height={eyeH} />
              <rect x="6" y="10" width="4" height="1" />
            </g>
          </svg>
        </Box>
        <Box>
          <Eyebrow>Week 31 · Aug 3–10</Eyebrow>
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="17px" color={SEMANTIC_COLORS.textPrimary} mt={SPACING.sm}>
            Twenty-three deliveries, and you held through Thursday at 41% LTV.
          </Text>
          <VStack align="stretch" spacing={SPACING.sm} mt={SPACING.md}>
            {RECAP_LINES.map((line, i) => (
              <Grid key={i} gridTemplateColumns="16px 1fr" gap="9px" fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary}>
                <Box as="span" color={SEMANTIC_COLORS.success}>
                  ▪
                </Box>
                <Text as="span">{renderEmphasis(line)}</Text>
              </Grid>
            ))}
          </VStack>
          <HStack spacing={SPACING.sm} mt={SPACING.md} flexWrap="wrap">
            <ShareBtn>Copy card</ShareBtn>
            <ShareBtn>Save image</ShareBtn>
            <ShareBtn>Recap settings</ShareBtn>
          </HStack>
        </Box>
      </Card>
    </>
  )
}
