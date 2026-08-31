import React from 'react'
import { Box, Grid, HStack, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { MockStamp } from '@/components/demo'

import { ExecButton } from './ExecContext'
import { withAlpha } from './utils'

const PK: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9.5px"
    letterSpacing="0.24em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textTertiary}
  >
    {children}
  </Text>
)

const PV: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="24px"
    lineHeight="1.05"
    color={color ?? SEMANTIC_COLORS.textPrimary}
  >
    {children}
  </Text>
)

const PN: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary} lineHeight={1.5}>
    {children}
  </Text>
)

/** Section 0 — the whole position: collateral, the LTV window, headroom, debt. */
export const PositionHeader: React.FC = () => {
  return (
    <>
      <Card
        as={Grid}
        id="poshead"
        gap={{ base: SPACING.lg, lg: '22px' }}
        gridTemplateColumns={{ base: '1fr 1fr', md: '1fr 1.6fr 1fr 1fr' }}
        mb={SPACING.base}
      >
        {/* Collateral */}
        <Box display="grid" gap="5px" alignContent="start" minW={0}>
          <PK>
            Collateral <MockStamp />
          </PK>
          <PV>1.000 BTC</PV>
          <PN>$95,000 · never deployed, never lent</PN>
        </Box>

        {/* Loan to value window */}
        <Box display="grid" gap="5px" alignContent="start" minW={0}>
          <PK>
            Loan to value{' '}
            <Box as="span" color={SEMANTIC_COLORS.textPrimary} fontWeight={400}>
              28%
            </Box>
          </PK>
          <Box position="relative" h="9px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mt="7px">
            <Box position="absolute" left={0} top={0} bottom={0} w="28%" bg={SEMANTIC_COLORS.success} />
            <Box position="absolute" top={0} bottom={0} left="60%" w="13%" bg={withAlpha(SEMANTIC_COLORS.danger, 0.2)} />
            <Box position="absolute" top="-3px" bottom="-3px" left="60%" w="1px" bg={SEMANTIC_COLORS.danger} />
            <Box position="absolute" top="-3px" bottom="-3px" left="73%" w="1px" bg={SEMANTIC_COLORS.danger} />
          </Box>
          <PN>borrow cap 60% · liquidated past 73% · a breach repays to 60%</PN>
        </Box>

        {/* Headroom */}
        <Box display="grid" gap="5px" alignContent="start" minW={0}>
          <PK>Headroom</PK>
          <PV>38 h</PV>
          <PN>at the worst 24h fall of the last 90 days (−14%, measured)</PN>
        </Box>

        {/* Debt */}
        <Box display="grid" gap="5px" alignContent="start" minW={0}>
          <PK>Debt</PK>
          <PV color={SEMANTIC_COLORS.danger}>$26,980</PV>
          <Box h="9px" bg={SEMANTIC_COLORS.bgPrimary} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mt="7px">
            <Box h="100%" w="71%" bg={SEMANTIC_COLORS.danger} />
          </Box>
          <PN>of $38,000 borrowed · 71% remains</PN>
        </Box>
      </Card>

      {/* Execution rail — every implied action gets its button. */}
      <HStack spacing={SPACING.sm} flexWrap="wrap" mt={SPACING.md}>
        <ExecButton
          variant="go"
          payload={{
            title: 'Repay from wallet',
            rows: [
              ['Debt now', '$26,980'],
              ['You repay', '$1,000 CDT'],
              ['Debt after', '$25,980'],
              ['Days to self-repaid', '2,400 → 2,311'],
            ],
            note: 'Repaying from wallet is on top of the yield already repaying.',
            cta: 'Sign & repay',
            done: 'Repaid',
          }}
        >
          Repay extra
        </ExecButton>
        <ExecButton
          payload={{
            title: 'Add collateral',
            rows: [
              ['You add', '0.10 BTC'],
              ['Collateral after', '1.100 BTC'],
              ['LTV after', '26%'],
              ['Break distance', '43% → 47%'],
            ],
            cta: 'Sign & deposit',
            done: 'Deposited',
          }}
        >
          Add collateral
        </ExecButton>
        <ExecButton
          payload={{
            title: 'Withdraw collateral',
            rows: [
              ['You withdraw', '0.10 BTC'],
              ['LTV after', '31%'],
              ['Break distance', '43% → 38%'],
            ],
            note: 'Withdrawing moves you toward the line. The numbers above are the whole story.',
            cta: 'Sign & withdraw',
            done: 'Withdrawn',
          }}
        >
          Withdraw
        </ExecButton>
      </HStack>
    </>
  )
}
