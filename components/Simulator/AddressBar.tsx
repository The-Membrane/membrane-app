// The one action this page asks for: paste an address.
//
// The page is already populated when this renders (demo-first), so this bar is an
// upgrade path, not a gate. Loading a real address REPLACES the worked example
// outright — the two are never mixed, and a failed read never falls back to demo data.
//
// Left-aligned, one row, one line of small print. Everything that used to be explained
// here is either in the hero above it or in the fine print at the foot of the page.

import React from 'react'
import { Box, Button, Input, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

const BTN = {
  bg: 'transparent',
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderStrong,
  color: SEMANTIC_COLORS.textPrimary,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10.5px',
  letterSpacing: '0.14em',
  textTransform: 'uppercase' as const,
  h: 'auto',
  px: SPACING.base,
  py: SPACING.md,
  transition: TRANSITIONS.colors,
  _hover: {
    borderColor: SEMANTIC_COLORS.success,
    color: SEMANTIC_COLORS.success,
    bg: 'transparent',
  },
  _active: { opacity: 0.85 },
  _focus: FOCUS_STYLES.ring,
  _disabled: {
    opacity: 0.35,
    cursor: 'not-allowed',
    borderColor: SEMANTIC_COLORS.borderSubtle,
    color: SEMANTIC_COLORS.textTertiary,
  },
}

const LINK_BTN = {
  bg: 'transparent',
  border: 0,
  borderRadius: 0,
  color: SEMANTIC_COLORS.textSecondary,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10.5px',
  letterSpacing: '0.06em',
  h: 'auto',
  minW: 'auto',
  px: 0,
  py: 0,
  textDecoration: 'underline',
  transition: TRANSITIONS.colors,
  _hover: { color: SEMANTIC_COLORS.success, bg: 'transparent' },
  _focus: FOCUS_STYLES.ring,
}

export interface AddressBarProps {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  /** Set once a real address has been read; null while the worked example is showing. */
  loadedAddress: string | null
  onClear: () => void
  isLoading: boolean
  /** Verbatim reason the input was rejected, or null. */
  error: string | null
}

export const AddressBar: React.FC<AddressBarProps> = ({
  value,
  onChange,
  onSubmit,
  loadedAddress,
  onClear,
  isLoading,
  error,
}) => (
  <Box
    bg={SEMANTIC_COLORS.bgPrimary}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    p={SPACING.md}
    display="grid"
    gap={SPACING.sm}
    justifyItems="start"
    textAlign="left"
    maxW="560px"
    w="100%"
  >
    <Box
      as="form"
      display="flex"
      gap={SPACING.sm}
      flexWrap="wrap"
      justifyContent="flex-start"
      w="100%"
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <Input
        // Stable anchor: the "Run your position ↑" CTAs under the fold scroll to this
        // element and focus it (CarrySection, and the CTA repeat at the foot of the
        // page). Renaming it silently breaks both buttons.
        id="sim-address-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0x… paste any address"
        aria-label="Ethereum address to read a lending position from"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'simulator-address-error' : undefined}
        flex="1 1 240px"
        minW="0"
        bg={SEMANTIC_COLORS.bgSecondary}
        border="1px solid"
        borderColor={error ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.borderSubtle}
        borderRadius={0}
        color={SEMANTIC_COLORS.textPrimary}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="12.5px"
        h="auto"
        px={SPACING.md}
        py={SPACING.md}
        transition={TRANSITIONS.colors}
        _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
        _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
        _focus={FOCUS_STYLES.ring}
      />
      <Button type="submit" isDisabled={isLoading} {...BTN}>
        {isLoading ? 'Reading…' : loadedAddress ? 'Run another' : 'Run mine'}
      </Button>
    </Box>

    {loadedAddress && (
      <Button type="button" onClick={onClear} {...LINK_BTN}>
        Back to example
      </Button>
    )}

    {error && (
      <Text
        id="simulator-address-error"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11.5px"
        color={SEMANTIC_COLORS.danger}
      >
        {error}
      </Text>
    )}

    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="11px"
      color={SEMANTIC_COLORS.textTertiary}
      lineHeight={1.6}
    >
      Read-only · no wallet · address logged
    </Text>
  </Box>
)

export default AddressBar
