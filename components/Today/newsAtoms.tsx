import React, { type ReactNode } from 'react'
import NextLink from 'next/link'
import { Box, Link, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { NEWS, NEWS_FIGURE, NEWS_FONT } from '@/components/NewsEdition/tokens'

import { CAPS, HATCH, HEADLINE_LINE, HEADLINE_SLOT, TABULAR, TARGET } from './newsStyle'

// The Today bodies' newspaper furniture (membrane-board design/DESIGN_RULES.md §1, §6):
// kicker → headline → deck, hairline rules instead of boxes, right-aligned credit lines,
// a hatched band for stale or unavailable data, 44px actions. Mount inside a
// `.news-edition` root: the colours are its NEWS roles, and its CSS draws focus rings.
//
// TYPE SCALE (five steps on the page): Mono 11 (kickers, labels, credits), Mono 13
// (values, actions; the italic serif decks share it), Redaction 22 (headlines),
// Redaction 40 (the one $ figure), and the nameplate. The shared constants live in
// newsStyle.ts (a component file exports components only).

export function Kicker({ children }: { children: ReactNode }) {
  return (
    <Text
      as="p"
      fontFamily={NEWS_FONT.mono}
      fontSize={TYPOGRAPHY.label}
      lineHeight="16px"
      color={NEWS.accent}
      sx={CAPS}
    >
      {children}
    </Text>
  )
}

export function Headline({
  id,
  children,
  slot = true,
}: {
  id?: string
  children: ReactNode
  /** Reserve two lines. */
  slot?: boolean
}) {
  return (
    <Text
      as="h2"
      id={id}
      fontFamily={NEWS_FONT.display}
      fontWeight={TYPOGRAPHY.bold}
      fontSize="22px"
      lineHeight={HEADLINE_LINE}
      color={NEWS.ink}
      minH={slot ? HEADLINE_SLOT : undefined}
      pt={SPACING.xs}
    >
      {children}
    </Text>
  )
}

/** A figure, never broken across a line: bold Redaction inside a headline, bold mono
 *  in body text (NEWS_FIGURE). A decrease is red with the ✖ glyph. */
export function Figure({
  children,
  loss,
  face = 'display',
}: {
  children: ReactNode
  loss?: boolean
  face?: 'display' | 'text'
}) {
  return (
    <Text
      as="span"
      whiteSpace="nowrap"
      fontWeight={TYPOGRAPHY.bold}
      color={loss ? NEWS.danger : 'inherit'}
      {...NEWS_FIGURE[face]}
    >
      {loss && (
        <Box as="span" aria-hidden="true" mr="0.2em">
          ✖
        </Box>
      )}
      {children}
    </Text>
  )
}

export function Deck({ children }: { children: ReactNode }) {
  return (
    <Text
      as="p"
      fontFamily={TYPOGRAPHY.fontDisplay}
      fontStyle="italic"
      fontSize="13px"
      lineHeight="20px"
      color={NEWS.ink2}
    >
      {children}
    </Text>
  )
}

/** Provenance: a small right-aligned credit line, not a badge. */
export function Credit({ children, align = 'right' }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <Text
      as="p"
      textAlign={align}
      fontFamily={NEWS_FONT.mono}
      fontSize={TYPOGRAPHY.label}
      lineHeight="16px"
      color={NEWS.muted}
      overflowWrap="anywhere"
      sx={TABULAR}
    >
      {children}
    </Text>
  )
}

/** The headline's stand-in while its inputs are stale or missing: ░, ink, on the hatch. */
export function Withheld({ children, slot = true }: { children: ReactNode; slot?: boolean }) {
  return (
    <Text
      as="p"
      role="status"
      fontFamily={NEWS_FONT.mono}
      fontSize="13px"
      lineHeight="20px"
      color={NEWS.ink}
      minH={slot ? HEADLINE_SLOT : undefined}
      pt={SPACING.sm}
      sx={CAPS}
    >
      <Box as="span" aria-hidden="true" mr="0.4em">
        ░
      </Box>
      {children}
    </Text>
  )
}

/** An action: a 44px-tall link, mono, ink, underlined. */
export function ActionLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      as={NextLink}
      href={href}
      display="inline-flex"
      alignItems="center"
      minH={TARGET}
      fontFamily={NEWS_FONT.mono}
      fontSize="13px"
      lineHeight="16px"
      color={NEWS.ink}
      textDecoration="underline"
      textUnderlineOffset="3px"
      transition={TRANSITIONS.colors}
      _hover={{ color: NEWS.accent }}
    >
      {children}
    </Link>
  )
}

/** An action that acts on the page (opens something in place): an ActionLink's look,
 *  as a button. */
export function ActionButton({
  onClick,
  children,
  expanded,
  controls,
}: {
  onClick: () => void
  children: ReactNode
  /** aria-expanded, for a button that opens a region in place. */
  expanded?: boolean
  /** aria-controls: the id of the region it opens. */
  controls?: string
}) {
  return (
    <Box
      as="button"
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={controls}
      display="inline-flex"
      alignItems="center"
      minH={TARGET}
      fontFamily={NEWS_FONT.mono}
      fontSize="13px"
      lineHeight="16px"
      color={NEWS.ink}
      textDecoration="underline"
      textUnderlineOffset="3px"
      transition={TRANSITIONS.colors}
      _hover={{ color: NEWS.accent }}
    >
      {children}
    </Box>
  )
}

/** One module: a hairline rule on top, then its furniture. */
export function Module({
  label,
  hatched,
  children,
  rule = true,
}: {
  label?: string
  hatched?: boolean
  children: ReactNode
  rule?: boolean
}) {
  return (
    <Box
      as="section"
      aria-label={label}
      borderTop={rule ? `1px solid ${NEWS.rule}` : undefined}
      pt={SPACING.base}
      pb={SPACING.sm}
      bgImage={hatched ? HATCH : undefined}
      minW={0}
    >
      {children}
    </Box>
  )
}
