// Paste-an-address input.
//
// The page is already populated when this renders (demo-first), so this bar is an
// upgrade path, not a gate. Loading a real address REPLACES the worked example
// outright — the two are never mixed, and a failed read never falls back to demo data.

import React from 'react'
import { Box, Button, Input, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow, monoXs } from '@/components/Builder/styles'

import { shortAddress } from './format'

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
    bg={SEMANTIC_COLORS.bgSecondary}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    p={SPACING.base}
    display="grid"
    gap={SPACING.sm}
  >
    <Text {...eyebrow}>01 / your position</Text>
    <Box
      as="form"
      display="flex"
      gap={SPACING.sm}
      flexWrap="wrap"
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0x… paste any address with a lending position"
        aria-label="Ethereum address to read a lending position from"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'simulator-address-error' : undefined}
        flex="1 1 320px"
        minW="0"
        bg={SEMANTIC_COLORS.bgPrimary}
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
        {isLoading ? 'Reading…' : 'Read this address'}
      </Button>
      {loadedAddress && (
        <Button type="button" onClick={onClear} {...BTN}>
          Back to the worked example
        </Button>
      )}
    </Box>

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

    <Text {...monoXs} lineHeight={1.7}>
      {loadedAddress
        ? `Reading ${shortAddress(loadedAddress)} on Ethereum mainnet over a public RPC. Read-only — no signature, no connection, nothing is sent anywhere.`
        : 'Read-only. Pasting an address reads Aave V3, Spark, Morpho Blue and Compound V3 on Ethereum mainnet over a public RPC — no wallet connection, no signature.'}
    </Text>
  </Box>
)

export default AddressBar
