import React from 'react'
import NextLink from 'next/link'
import { useRouter } from 'next/router'
import {
  Box,
  Button,
  Link as ChakraLink,
  Slider,
  SliderFilledTrack,
  SliderThumb,
  SliderTrack,
  Text,
} from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DemoAwareCta } from '@/components/demo'

import { Eyebrow, Num } from './atoms'
import { VENUE_ORDER, VENUES } from './fixtures'
import { LandingCalc, LandingState, VenueKey } from './types'
import { btcs, carryFoot, carryVariant, usd, usdc } from './utils'

interface HeroProps {
  st: LandingState
  c: LandingCalc
  chainName: string
  onBtc: (v: number) => void
  onLtv: (v: number) => void
  onVenue: (v: VenueKey) => void
}

const VARIANT_BORDER: Record<string, string> = {
  default: SEMANTIC_COLORS.success,
  warn: SEMANTIC_COLORS.warning,
  neg: SEMANTIC_COLORS.danger,
}

/** A flow row: label left, value right. */
const FlowRow: React.FC<{ label: string; children: React.ReactNode; net?: boolean }> = ({ label, children, net }) => (
  <Box
    bg={net ? SEMANTIC_COLORS.bgTertiary : SEMANTIC_COLORS.bgSecondary}
    px={SPACING.md}
    py={SPACING.md}
    display="flex"
    justifyContent="space-between"
    alignItems="baseline"
    gap={SPACING.md}
  >
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="10px"
      letterSpacing="0.2em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textSecondary}
    >
      {label}
    </Text>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={net ? '18px' : '15px'}
      sx={{ fontVariantNumeric: 'tabular-nums' }}
      color={SEMANTIC_COLORS.textPrimary}
    >
      {children}
    </Text>
  </Box>
)

const Small: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text as="span" fontSize="11px" color={SEMANTIC_COLORS.textTertiary}>
    {children}
  </Text>
)

/** Renders the carry line for the active variant, mono numerals inline. */
const CarryLine: React.FC<{ st: LandingState; c: LandingCalc; variant: string }> = ({ st, c, variant }) => {
  const em = VARIANT_BORDER[variant]
  const B: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <Text as="b" fontWeight={TYPOGRAPHY.normal} color={em}>
      {children}
    </Text>
  )
  if (c.net < 0) {
    return (
      <>
        <Num>{usd(c.debt)}</Num> of liquidity, and holding it{' '}
        <B>
          costs you <Num color={em}>{usd(-c.net)}</Num> a year
        </B>
        .
      </>
    )
  }
  if (c.dropPct < 10) {
    return (
      <>
        <Num>{usd(c.debt)}</Num> of liquidity, but a{' '}
        <B>
          <Num color={em}>{c.dropPct.toFixed(0)}% drop</Num>
        </B>{' '}
        starts the liquidation clock.
      </>
    )
  }
  if (c.dropPct < 25) {
    return (
      <>
        <Num>{usd(c.debt)}</Num> of liquidity, earning <Num>{usd(c.net)}</Num> a year — with{' '}
        <B>
          <Num color={em}>{c.dropPct.toFixed(0)}%</Num> of room
        </B>{' '}
        beneath you.
      </>
    )
  }
  return (
    <>
      <Num>{usd(c.debt)}</Num> of liquidity, and it pays you{' '}
      <B>
        <Num color={em}>{usd(c.net)}</Num> a year
      </B>{' '}
      to hold it.
    </>
  )
}

export const Hero: React.FC<HeroProps> = ({ st, c, chainName, onBtc, onLtv, onVenue }) => {
  const router = useRouter()
  const variant = carryVariant(c)
  const emColor = VARIANT_BORDER[variant]

  return (
    <Box
      display="grid"
      gridTemplateColumns={{ base: '1fr', lg: '1.35fr 1fr' }}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
    >
      {/* ---- stage ---- */}
      <Box bg={SEMANTIC_COLORS.bgPrimary} p={{ base: SPACING.lg, md: SPACING.xl }} display="grid" gap={SPACING.lg} alignContent="start">
        <Eyebrow>Your bitcoin, still yours</Eyebrow>

        {/* The page's single h1, aligned with the PageSeo title (SEO_RULESET R9);
            crawlers previously found zero h1 in this tree (docs/GEO_AUDIT.md P0). */}
        <Text
          as="h1"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h1}
          fontWeight={TYPOGRAPHY.bold}
          lineHeight="1.15"
          color={SEMANTIC_COLORS.textPrimary}
        >
          Borrow against your bitcoin, keep the bitcoin
        </Text>

        <Box display="grid" gap={SPACING.sm}>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={{ base: '28px', md: '42px' }}
            lineHeight="1.05"
            letterSpacing="-0.02em"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
            color={SEMANTIC_COLORS.textPrimary}
          >
            {st.btc.toFixed(2)}{' '}
            <Text as="span" fontStyle="normal" color={SEMANTIC_COLORS.textTertiary} fontSize="0.62em" letterSpacing="0.12em">
              BTC
            </Text>
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textSecondary}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {usd(c.coll)} at today’s price · you keep all of it
          </Text>
        </Box>

        {/* flow */}
        <Box display="grid" gap="1px" bg={SEMANTIC_COLORS.borderSubtle} border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
          <FlowRow label="You receive">
            {usd(c.debt)} <Small>CDT</Small>
          </FlowRow>
          <FlowRow label="It earns">
            {usd(c.earn)}
            <Small>/yr at {(c.v.apr * 100).toFixed(1)}%</Small>
          </FlowRow>
          <FlowRow label="Interest costs">
            {usd(c.cost)}
            <Small>/yr at 3.0%</Small>
          </FlowRow>
          <FlowRow label="Net to you" net>
            <Text as="span" color={c.net >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}>
              {usdc(c.net)}
              <Small>/yr</Small>
            </Text>
          </FlowRow>
        </Box>

        {/* carry payload */}
        <Box border="1px solid" borderColor={emColor} p={SPACING.base} display="grid" gap={SPACING.sm}>
          <Text as="p" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={{ base: '17px', md: '24px' }} lineHeight="1.3" color={SEMANTIC_COLORS.textPrimary}>
            <CarryLine st={st} c={c} variant={variant} />
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textSecondary}>
            {carryFoot(st, c)}
          </Text>
        </Box>
      </Box>

      {/* ---- rail ---- */}
      <Box
        bg={SEMANTIC_COLORS.bgSecondary}
        borderLeft={{ base: 'none', lg: '1px solid' }}
        borderTop={{ base: '1px solid', lg: 'none' }}
        borderColor={SEMANTIC_COLORS.borderStrong}
        p={SPACING.base}
        display="grid"
        gap={SPACING.base}
        alignContent="start"
      >
        {/* play door */}
        <Box display="grid" gap={SPACING.sm} pb={SPACING.md} borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
          <NextLink href={`/${chainName}/builder`} passHref legacyBehavior>
            <ChakraLink
              display="block"
              textAlign="center"
              textDecoration="none"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12.5px"
              letterSpacing="0.04em"
              bg={SEMANTIC_COLORS.success}
              color={SEMANTIC_COLORS.bgPrimary}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.success}
              borderRadius={0}
              py={SPACING.md}
              px={SPACING.sm}
              transition={TRANSITIONS.colors}
              _hover={{ textDecoration: 'none', opacity: 0.9 }}
              _focus={FOCUS_STYLES.ring}
            >
              Play today’s gauntlet →
            </ChakraLink>
          </NextLink>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" letterSpacing="0.08em" color={SEMANTIC_COLORS.textSecondary} textAlign="center">
            No wallet. Same floors for everyone today. Real measured data.
          </Text>
        </Box>

        {/* control: BTC */}
        <ControlHead label="Bitcoin you hold" value={`${st.btc.toFixed(2)} BTC`} />
        <Slider aria-label="Bitcoin held" min={0.05} max={10} step={0.05} value={st.btc} onChange={onBtc} focusThumbOnChange={false}>
          <SliderTrack bg={SEMANTIC_COLORS.borderStrong} h="2px" borderRadius={0}>
            <SliderFilledTrack bg={SEMANTIC_COLORS.success} />
          </SliderTrack>
          <SliderThumb boxSize="11px" bg={SEMANTIC_COLORS.success} borderRadius={0} _focusVisible={FOCUS_STYLES.ring} />
        </Slider>

        {/* control: LTV */}
        <ControlHead label="Liquidity you want" value={`${(st.ltv * 100).toFixed(0)}% LTV`} />
        <Slider
          aria-label="Loan to value"
          min={5}
          max={70}
          step={1}
          value={st.ltv * 100}
          onChange={(v) => onLtv(v / 100)}
          focusThumbOnChange={false}
        >
          <SliderTrack bg={SEMANTIC_COLORS.borderStrong} h="2px" borderRadius={0}>
            <SliderFilledTrack bg={SEMANTIC_COLORS.success} />
          </SliderTrack>
          <SliderThumb boxSize="11px" bg={SEMANTIC_COLORS.success} borderRadius={0} _focusVisible={FOCUS_STYLES.ring} />
        </Slider>

        {/* control: venue segment */}
        <ControlHead label="Put it to work in" value={VENUES[st.venue].nm} />
        <Box display="flex" gap={SPACING.sm}>
          {VENUE_ORDER.map((key) => {
            const active = st.venue === key
            return (
              <Button
                key={key}
                flex={1}
                aria-pressed={active}
                onClick={() => onVenue(key)}
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="10px"
                letterSpacing="0.08em"
                textTransform="uppercase"
                fontWeight={TYPOGRAPHY.normal}
                h="auto"
                py={SPACING.sm}
                px={SPACING.xs}
                borderRadius={0}
                border="1px solid"
                borderColor={active ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderStrong}
                bg={active ? SEMANTIC_COLORS.success : 'transparent'}
                color={active ? SEMANTIC_COLORS.bgPrimary : SEMANTIC_COLORS.textPrimary}
                transition={TRANSITIONS.colors}
                _hover={active ? {} : { borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success, bg: 'transparent' }}
                _focus={FOCUS_STYLES.ring}
              >
                {key === 'steady' ? 'Steady' : key === 'bal' ? 'Balanced' : 'Higher'}
              </Button>
            )
          })}
        </Box>

        {/* the borrow CTA — demo-aware; no addresses deployed yet, so it opens the borrow flow */}
        <DemoAwareCta
          onAction={() => router.push(`/${chainName}/mint`)}
          connectLabel="Connect wallet"
          w="100%"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12.5px"
          letterSpacing="0.04em"
          fontWeight={TYPOGRAPHY.normal}
          h="auto"
          py={SPACING.md}
          borderRadius={0}
          bg={SEMANTIC_COLORS.success}
          color={SEMANTIC_COLORS.bgPrimary}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.success}
          transition={TRANSITIONS.colors}
          _hover={{ opacity: 0.9 }}
          _focus={FOCUS_STYLES.ring}
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {`Borrow ${usd(c.debt)} · ${(st.ltv * 100).toFixed(0)}% LTV · ${c.net >= 0 ? '+' : ''}${usdc(c.net)}/yr`}
        </DemoAwareCta>

        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10.5px" color={SEMANTIC_COLORS.textSecondary} textAlign="center" lineHeight="1.5">
          Max 73% LTV on BTC. {c.v.note}.
        </Text>

        <NextLink href={`/${chainName}/position?demo`} passHref legacyBehavior>
          <ChakraLink
            display="block"
            textAlign="center"
            mt={SPACING.sm}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="10px"
            letterSpacing="0.14em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.success}
            textDecoration="underline"
            _focus={FOCUS_STYLES.ring}
          >
            see a live position first — demo wallet →
          </ChakraLink>
        </NextLink>

        {/* terms line — plain link to /terms */}
        <Box
          display="flex"
          gap={SPACING.sm}
          alignItems="flex-start"
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
          pt={SPACING.md}
        >
          <Text as="span" color={SEMANTIC_COLORS.warning} flex="none">
            ◆
          </Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10.5px" color={SEMANTIC_COLORS.textSecondary} lineHeight="1.55">
            By borrowing you agree to the{' '}
            <ChakraLink href="/terms" isExternal color={SEMANTIC_COLORS.success} textUnderlineOffset="3px" _focus={FOCUS_STYLES.ring}>
              Terms of Service
            </ChakraLink>
            . Your signature records it, and names that document.
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

const ControlHead: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={SPACING.md} fontSize="11px">
    <Text fontFamily={TYPOGRAPHY.fontMono} letterSpacing="0.08em" color={SEMANTIC_COLORS.textSecondary}>
      {label}
    </Text>
    <Text fontFamily={TYPOGRAPHY.fontMono} sx={{ fontVariantNumeric: 'tabular-nums' }} color={SEMANTIC_COLORS.textPrimary}>
      {value}
    </Text>
  </Box>
)

export default Hero
