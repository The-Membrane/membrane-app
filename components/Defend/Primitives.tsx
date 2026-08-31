import React, { useState } from 'react'
import { Box, Text, TextProps } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { StatusClass } from './types'

/** Map a proto status class to a semantic color. */
export const statusColor = (s: StatusClass): string =>
  s === 'bad'
    ? SEMANTIC_COLORS.danger
    : s === 'warn'
    ? SEMANTIC_COLORS.warning
    : SEMANTIC_COLORS.textPrimary

/** Mono, 11px, uppercase, letter-spaced eyebrow (proto `.eyebrow`). */
export const Eyebrow: React.FC<TextProps> = ({ children, ...props }) => (
  <Text
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.label}
    textTransform="uppercase"
    letterSpacing="0.28em"
    color={SEMANTIC_COLORS.textSecondary}
    {...props}
  >
    {children}
  </Text>
)

/** Numbered section header row: "NN / <heading>  · <note>" (proto `.sect`). */
export const SectionHeading: React.FC<{ index: string; title: string; note?: React.ReactNode }> = ({
  index,
  title,
  note,
}) => (
  <Box
    mt={SPACING.xl}
    mb={SPACING.sm}
    display="flex"
    alignItems="baseline"
    gap={SPACING.md}
    flexWrap="wrap"
  >
    <Eyebrow>{index} /</Eyebrow>
    <Text
      as="h2"
      fontFamily={TYPOGRAPHY.fontDisplay}
      fontSize={TYPOGRAPHY.h3}
      color={SEMANTIC_COLORS.textPrimary}
    >
      {title}
    </Text>
    {note && (
      <Text
        as="span"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        color={SEMANTIC_COLORS.textTertiary}
      >
        {note}
      </Text>
    )}
  </Box>
)

/** Faint provenance/footnote line (proto `.stamp`). */
export const Stamp: React.FC<TextProps> = ({ children, ...props }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.xs}
    color={SEMANTIC_COLORS.textTertiary}
    lineHeight={1.7}
    mt={SPACING.md}
    {...props}
  >
    {children}
  </Text>
)

/** Warm intro paragraph (proto `.warm`). Renders provided children. */
export const Warm: React.FC<TextProps> = ({ children, ...props }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.xs}
    color={SEMANTIC_COLORS.textSecondary}
    maxW="80ch"
    lineHeight={1.7}
    {...props}
  >
    {children}
  </Text>
)

/** Click-to-copy chip with "copied" feedback (proto `.copy`). */
export const CopyChip: React.FC<{ value: string; children: React.ReactNode } & TextProps> = ({
  value,
  children,
  ...props
}) => {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    try {
      void navigator.clipboard?.writeText(value)
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 900)
  }
  return (
    <Text
      as="span"
      role="button"
      tabIndex={0}
      onClick={onCopy}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onCopy()
      }}
      cursor="pointer"
      fontFamily={TYPOGRAPHY.fontMono}
      color={SEMANTIC_COLORS.textSecondary}
      transition={TRANSITIONS.colors}
      _hover={{ color: SEMANTIC_COLORS.success }}
      {...props}
    >
      {copied ? 'copied' : children}
    </Text>
  )
}
