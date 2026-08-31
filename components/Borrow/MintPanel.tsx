import React from 'react'
import {
  Box,
  Grid,
  HStack,
  Text,
  Input,
  Button,
  Slider,
  SliderTrack,
  SliderFilledTrack,
  SliderThumb,
} from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { DemoAwareCta } from '@/components/demo'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { fmt, fmtAmount } from './utils'
import type { CollateralAsset } from './types'
import type { BorrowMath } from './utils'

export interface MintPanelProps {
  asset: CollateralAsset
  rate: number
  postAmount: string
  onPostAmountChange: (v: string) => void
  onMax: () => void
  ltv: number
  onLtvChange: (v: number) => void
  math: BorrowMath
  onBorrow: () => void
}

const riskColor = (odds: number) =>
  odds < 5 ? SEMANTIC_COLORS.success : odds < 20 ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.danger

/**
 * The mint box: post + LTV slider + mint amount, plus the three-fact strip
 * (collateral / risk / cost) and the Borrow CTA. Ported from
 * public/proto/borrow.html's `.mint`/`.facts` markup and `paint()` (lines
 * ~145-183, 248-281).
 */
export const MintPanel: React.FC<MintPanelProps> = ({
  asset,
  rate,
  postAmount,
  onPostAmountChange,
  onMax,
  ltv,
  onLtvChange,
  math,
  onBorrow,
}) => {
  const { pv, mint, ltvCapPercent, effectiveLtv, odds, net, postValue } = math

  return (
    <Card variant="default" mt={SPACING.md} p={SPACING.lg}>
      <HStack align="flex-end" spacing={SPACING.xl} flexWrap="wrap">
        <Box>
          <HStack spacing={SPACING.sm}>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              letterSpacing="0.28em"
              textTransform="uppercase"
              color={SEMANTIC_COLORS.textSecondary}
            >
              You post
            </Text>
            <Button
              variant="link"
              onClick={onMax}
              color={SEMANTIC_COLORS.success}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="9px"
              letterSpacing="0.12em"
              textTransform="uppercase"
              textDecoration="underline"
              _focus={FOCUS_STYLES.ring}
              minW="auto"
              h="auto"
            >
              max
            </Button>
          </HStack>
          <Input
            mt={SPACING.xs}
            w="150px"
            textAlign="right"
            bg={SEMANTIC_COLORS.bgTertiary}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            borderRadius={0}
            color={SEMANTIC_COLORS.textPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.h4}
            inputMode="decimal"
            aria-label="Collateral amount"
            value={postAmount}
            onChange={(e) => onPostAmountChange(e.target.value)}
            _focus={FOCUS_STYLES.ring}
          />
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.xs}>
            {fmt(pv)} · you hold {fmtAmount(asset.bal, asset.dp)} {asset.sym}
          </Text>
        </Box>

        <Box flex={1} minW="240px">
          <HStack spacing={SPACING.sm}>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              letterSpacing="0.28em"
              textTransform="uppercase"
              color={SEMANTIC_COLORS.textSecondary}
            >
              How far you draw
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>
              {effectiveLtv.toFixed(0)}% LTV
            </Text>
          </HStack>
          <Slider
            mt={SPACING.sm}
            min={10}
            max={ltvCapPercent}
            step={1}
            value={effectiveLtv}
            onChange={onLtvChange}
            aria-label="Loan to value, percent"
            focusThumbOnChange={false}
          >
            <SliderTrack bg={SEMANTIC_COLORS.borderStrong} h="2px">
              <SliderFilledTrack bg={SEMANTIC_COLORS.success} />
            </SliderTrack>
            <SliderThumb
              boxSize="11px"
              bg={SEMANTIC_COLORS.success}
              borderRadius={0}
              _focus={FOCUS_STYLES.ring}
            />
          </Slider>
          <HStack justify="space-between">
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
              light
            </Text>
            <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
              cap {ltvCapPercent}% · line {(asset.M * 100).toFixed(0)}%
            </Text>
          </HStack>
        </Box>

        <Box ml={{ base: 0, md: 'auto' }} textAlign={{ base: 'left', md: 'right' }}>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.label}
            letterSpacing="0.28em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.textSecondary}
          >
            You mint
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="26px" color={SEMANTIC_COLORS.textPrimary}>
            {fmt(mint)}
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9.5px" color={SEMANTIC_COLORS.textTertiary}>
            CDT · straight to your wallet
          </Text>
        </Box>
      </HStack>

      <Grid templateColumns={{ base: '1fr', md: 'repeat(3, minmax(0, 1fr))' }} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} mt={SPACING.lg}>
        <Box p={SPACING.md} borderRight={{ base: 'none', md: '1px solid' }} borderBottom={{ base: '1px solid', md: 'none' }} borderColor={SEMANTIC_COLORS.borderSubtle}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} letterSpacing="0.28em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
            Collateral
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.h4} color={SEMANTIC_COLORS.textPrimary} mt={SPACING.xs}>
            {fmtAmount(postValue, asset.dp)} {asset.sym}
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.55}>
            {fmt(pv)} posted · stays yours · back in full when you repay
          </Text>
        </Box>

        <Box p={SPACING.md} borderRight={{ base: 'none', md: '1px solid' }} borderBottom={{ base: '1px solid', md: 'none' }} borderColor={SEMANTIC_COLORS.borderSubtle}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} letterSpacing="0.28em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
            Risk
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.h4} color={riskColor(odds)} mt={SPACING.xs}>
            {odds < 1 ? 'breach odds under 1%' : `breach odds ${odds.toFixed(odds < 10 ? 1 : 0)}%`}
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.55}>
            in 12 months, at {effectiveLtv.toFixed(0)}% LTV vs the {(asset.M * 100).toFixed(0)}% line · a breach opens
            an 8h cure window
          </Text>
        </Box>

        <Box p={SPACING.md}>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.label} letterSpacing="0.28em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
            What it earns &amp; costs
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.h4}
            color={net >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}
            mt={SPACING.xs}
          >
            {net >= 0 ? `+${net.toFixed(1)}` : net.toFixed(1)}% / yr net
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.55}>
            collateral earns {asset.yld.toFixed(1)}% · the debt costs {rate.toFixed(1)}% · today’s rates, they move
          </Text>
        </Box>
      </Grid>

      <DemoAwareCta
        onAction={onBorrow}
        mt={SPACING.lg}
        alignSelf="start"
        bg={SEMANTIC_COLORS.success}
        borderColor={SEMANTIC_COLORS.success}
        color={SEMANTIC_COLORS.bgPrimary}
        border="1px solid"
        px={SPACING.xl}
        py={SPACING.md}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        letterSpacing="0.14em"
        textTransform="uppercase"
        _hover={{ bg: SEMANTIC_COLORS.success }}
      >
        Borrow
      </DemoAwareCta>

      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.02em" mt={SPACING.md}>
        breach odds = probability price touches your liquidation line within 12 months · zero-drift model on
        realized 12m vol ({(asset.vol * 100).toFixed(1)}%) · recomputed daily with the breach surface
      </Text>
    </Card>
  )
}

export default MintPanel
