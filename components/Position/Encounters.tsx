import React from 'react'
import { Box, Grid, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { SectionHead } from './primitives'
import { ENCOUNTERS } from './fixtures'
import { renderEmphasis } from './utils'

/** Section 3 — what you have survived: named encounters, scored after the fact. */
export const Encounters: React.FC = () => (
  <>
    <SectionHead index="03 /" title="What you have survived" note="Named after the fact, from measured price history — not from how it felt." />
    <Card>
      <Box>
        {ENCOUNTERS.map((e, i) => (
          <Grid
            key={i}
            gridTemplateColumns={{ base: '1fr', md: '118px 1fr' }}
            gap={{ base: SPACING.xs, md: SPACING.base }}
            py={SPACING.md}
            borderBottom={i === ENCOUNTERS.length - 1 ? 'none' : '1px solid'}
            borderColor={SEMANTIC_COLORS.borderSubtle}
          >
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.16em" textTransform="uppercase" color={SEMANTIC_COLORS.textTertiary}>
              {e.when}
            </Text>
            <Box>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="13px" color={e.bad ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textPrimary}>
                {e.title}
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11.5px" color={SEMANTIC_COLORS.textSecondary} mt="4px" lineHeight={1.65}>
                {renderEmphasis(e.body)}
              </Text>
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary} mt="6px">
                {e.stamp}
              </Text>
            </Box>
          </Grid>
        ))}
      </Box>
    </Card>
  </>
)
