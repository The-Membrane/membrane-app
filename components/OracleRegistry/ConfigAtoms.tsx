import React from 'react'
import { Box, Link, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { BreachView, HolderView, ItemView } from '@/lib/oracleRegistry/config/apiTypes'

import { compactDigits, RED_META, smallText } from './configViewModel'

// Small building blocks shared by the config card: chips (glyph + word, never colour alone),
// block headings, red breach lines and controller links.

export const Chip: React.FC<{
  children: React.ReactNode
  token?: string
  glyph?: string
  title?: string
  loud?: boolean
}> = ({ children, token = SEMANTIC_COLORS.textSecondary, glyph, title, loud = true }) => (
  <Text
    as="span"
    title={title}
    display="inline-flex"
    alignItems="center"
    gap="4px"
    px="6px"
    py="1px"
    border="1px solid"
    borderColor={token}
    color={smallText(token)}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing={loud ? '0.08em' : undefined}
    lineHeight="16px"
    whiteSpace="nowrap"
  >
    {glyph && <span aria-hidden="true">{glyph}</span>}
    {children}
  </Text>
)

export const BlockTitle: React.FC<{
  id: string
  children: React.ReactNode
  aside?: React.ReactNode
}> = ({ id, children, aside }) => (
  <Box
    display="flex"
    flexWrap="wrap"
    alignItems="baseline"
    columnGap={SPACING.sm}
    rowGap="2px"
    mb={SPACING.sm}
  >
    <Text
      id={id}
      as="h3"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="11px"
      letterSpacing="0.2em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textSecondary}
    >
      {children}
    </Text>
    {aside && (
      <Text
        as="span"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={SEMANTIC_COLORS.textSecondary}
      >
        {aside}
      </Text>
    )}
  </Box>
)

export const ExtLink: React.FC<{
  href: string | null
  children: React.ReactNode
  title?: string
  /** Same-page link (a #change permalink): no new tab. */
  internal?: boolean
  /** Accessible name when the visible text alone does not say where it goes ("#"). */
  label?: string
}> = ({ href, children, title, internal, label }) =>
  href ? (
    <Link
      href={href}
      isExternal={!internal}
      title={title}
      aria-label={label}
      color={SEMANTIC_COLORS.textSecondary}
      textDecoration="underline"
      textDecorationColor={SEMANTIC_COLORS.borderStrong}
      textUnderlineOffset="2px"
      _hover={{ color: SEMANTIC_COLORS.primary }}
      _focusVisible={FOCUS_STYLES.ring}
    >
      {children}
    </Link>
  ) : (
    <Text as="span" title={title} color={SEMANTIC_COLORS.textSecondary}>
      {children}
    </Text>
  )

export const Holders: React.FC<{ holders: HolderView[] }> = ({ holders }) => (
  <>
    {holders.map((h, i) => (
      <React.Fragment key={`${h.label}-${i}`}>
        {i > 0 && ' | '}
        <ExtLink href={h.url}>{h.label}</ExtLink>
      </React.Fragment>
    ))}
  </>
)

/** One failing state rule: "■ AD-3 · cbBTC owner held by EOA 0xbbc9…db4f". */
export const BreachLine: React.FC<{ b: BreachView; rule?: string }> = ({ b, rule }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.xs}
    color={SEMANTIC_COLORS.textPrimary}
    lineHeight={1.5}
  >
    <Text as="span" color={RED_META.text} aria-hidden="true">
      {RED_META.glyph}{' '}
    </Text>
    <Text as="span" color={RED_META.text} title={rule}>
      {b.ruleId}
    </Text>{' '}
    {/* the route (or setting) the rule fails on: breaches never read as identical lines */}
    {b.where ? `· ${b.where} ` : ''}· {b.message}
    {/* floor breaches carry the severity rank: the value at risk behind the route */}
    {b.valueAtRisk && (
      <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
        {' '}
        · {b.valueAtRisk}
      </Text>
    )}
  </Text>
)

/** One head-state setting: its display line, every failing rule (red) and any read warning. */
export const ItemLine: React.FC<{ i: ItemView; rules: Record<string, string> }> = ({
  i,
  rules,
}) => (
  <Box py="4px" borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="11px"
      color={i.breaches.length ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
      wordBreak="break-word"
    >
      {i.breaches.length > 0 && (
        <Text as="span" color={RED_META.text} aria-hidden="true">
          {RED_META.glyph}{' '}
        </Text>
      )}
      {compactDigits(i.display)}
    </Text>
    {i.breaches.map((b) => (
      <BreachLine key={`${b.ruleId}-${b.message}`} b={b} rule={rules[b.ruleId]} />
    ))}
    {i.warnings.map((w) => (
      <Text
        key={w}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={SEMANTIC_COLORS.warning}
      >
        <span aria-hidden="true">? </span>
        {w}
      </Text>
    ))}
  </Box>
)
