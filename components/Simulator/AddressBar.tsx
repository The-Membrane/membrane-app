// The one action this page asks for: paste an address.
//
// The page is already populated when this renders (demo-first), so this bar is an
// upgrade path, not a gate. Loading a real address REPLACES the worked example
// outright — the two are never mixed, and a failed read never falls back to demo data.
//
// Centred under the verdict, one row, one line of small print. Everything that used to be explained
// here is either in the hero above it or in the fine print at the foot of the page.

import React from 'react'
import { Box, Button, Input, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import useWallet from '@/hooks/useWallet'
import { LANDING_PASTE_PROMPT } from '@/lib/position-sim/guarantee'
import { LABEL, NEWS, NEWS_FONT, useNewsEdition } from '@/components/NewsEdition'

/** The page's one action, named. The CTA repeat says it with an arrow ("… ↑"); the
 *  news edition's paste box uses it as its heading. */
export const RUN_YOUR_POSITION = 'Run your position'

const BTN = {
  bg: 'transparent',
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderStrong,
  color: SEMANTIC_COLORS.textPrimary,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10.5px',
  letterSpacing: '0.24em',
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
  /** Landing hero form: connect is the primary action (solid phosphor, first), the
   *  paste box is secondary. On /simulator paste stays primary. */
  primaryConnect?: boolean
  /** Label for the primary connect button; falls back to the plain connect copy. */
  connectLabel?: string
  /** Replaces the generic disclosure line with one that names venues, chain and data. */
  readNote?: string
  isLoading: boolean
  /** Verbatim reason the input was rejected, or null. */
  error: string | null
  /** DOM id — the hero's is 'sim-address-input'; extra bars below the fold must differ. */
  inputId?: string
}

export const AddressBar: React.FC<AddressBarProps> = ({
  value,
  onChange,
  onSubmit,
  primaryConnect = false,
  connectLabel,
  readNote,
  loadedAddress,
  onClear,
  isLoading,
  error,
  inputId = 'sim-address-input',
}) => {
  // Optional shortcut (owner 2026-09-12): a connected wallet can fill the box so
  // nobody has to copy their address. Still read-only — connecting is never
  // required, and the read path is identical to a pasted address.
  const { address: walletAddress, isWalletConnected, connect } = useWallet()
  const useWalletAddress = () => {
    if (isWalletConnected && walletAddress) onChange(walletAddress)
    else connect()
  }

  const news = useNewsEdition()
  if (news) {
    // THE NEWS EDITION'S PASTE BOX (canvas "Landing"): a sidebar card on the card stock,
    // square, 1px ink, solid edges — reading an address signs nothing, so no dashed
    // "leads to a signature" edge. Same input id, handlers, labels and states.
    const link = {
      bg: 'transparent',
      border: 0,
      borderRadius: 0,
      h: 'auto',
      minW: 'auto',
      minH: '32px',
      px: 0,
      py: 0,
      fontFamily: NEWS_FONT.mono,
      fontSize: '12px',
      fontWeight: 400,
      textDecoration: 'underline',
      _hover: { bg: 'transparent', opacity: 0.85 },
    }
    return (
      <Box
        as="aside"
        aria-label={RUN_YOUR_POSITION}
        border="1px solid"
        borderColor={NEWS.ink}
        bg={NEWS.card}
        p="18px"
        display="flex"
        flexDirection="column"
        gap="12px"
        w="100%"
        minW={0}
      >
        <Text as="h2" {...LABEL} fontSize="12px" color={NEWS.accent}>
          {RUN_YOUR_POSITION}
        </Text>
        <Text as="label" htmlFor={inputId} fontFamily={NEWS_FONT.mono} fontSize="12px" color={NEWS.ink2}>
          {LANDING_PASTE_PROMPT}
        </Text>
        {primaryConnect && (
          <Button
            type="button"
            onClick={useWalletAddress}
            {...BTN}
            w="100%"
            bg={NEWS.cta}
            borderColor={NEWS.cta}
            color={NEWS.onCta}
            fontWeight={700}
            _hover={{ bg: NEWS.cta, borderColor: NEWS.ink }}
          >
            {isWalletConnected && walletAddress
              ? 'Use connected wallet'
              : (connectLabel ?? 'Connect a wallet')}
          </Button>
        )}
        <Box
          as="form"
          display="flex"
          flexDirection="column"
          gap="12px"
          w="100%"
          onSubmit={(e: React.FormEvent) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          <Input
            // Stable anchor: the CTAs under the fold scroll to this element and focus it.
            id={inputId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={primaryConnect ? '0x… connect or paste an address' : '0x… paste any address'}
            aria-label="Ethereum address to read a lending position from"
            isInvalid={Boolean(error)}
            aria-describedby={error ? `${inputId}-error` : undefined}
            minW="0"
            h="auto"
            minH="44px"
            px="10px"
            py="10px"
            bg={NEWS.paper}
            color={NEWS.ink}
            border={0}
            borderBottom="2px solid"
            borderColor={error ? NEWS.danger : NEWS.ink}
            borderRadius={0}
            fontFamily={NEWS_FONT.mono}
            fontSize="15px"
            _placeholder={{ color: NEWS.muted }}
            _hover={{ borderColor: error ? NEWS.danger : NEWS.ink }}
            _focusVisible={{ boxShadow: 'none', borderColor: NEWS.accent }}
            _invalid={{ boxShadow: 'none', borderColor: NEWS.danger }}
          />
          <Button
            type="submit"
            isDisabled={isLoading}
            h="auto"
            minH="46px"
            bg={NEWS.ink}
            color={NEWS.paper}
            border={0}
            borderRadius={0}
            fontFamily={NEWS_FONT.mono}
            fontWeight={700}
            fontSize="13px"
            letterSpacing="0.16em"
            textTransform="uppercase"
            _hover={{ bg: NEWS.ink, opacity: 0.9 }}
            _active={{ opacity: 0.85 }}
            _disabled={{ opacity: 0.45, cursor: 'not-allowed' }}
          >
            {isLoading ? 'Reading…' : loadedAddress ? 'Run another' : 'Run mine'}
          </Button>
        </Box>
        <Box display="flex" flexWrap="wrap" gap="6px 16px">
          {!primaryConnect && (
            <Button type="button" onClick={useWalletAddress} {...link} color={NEWS.accent}>
              {isWalletConnected && walletAddress
                ? 'Use connected wallet'
                : 'Connect a wallet to fill this in'}
            </Button>
          )}
          {loadedAddress && (
            <Button type="button" onClick={onClear} {...link} color={NEWS.ink2}>
              Back to example
            </Button>
          )}
        </Box>
        {error && (
          <Text id={`${inputId}-error`} fontFamily={NEWS_FONT.mono} fontSize="12px" color={NEWS.danger}>
            {error}
          </Text>
        )}
        <Text
          fontFamily={NEWS_FONT.mono}
          fontSize="12px"
          lineHeight={1.6}
          color={NEWS.muted}
          borderTop="1px solid"
          borderColor={NEWS.rule}
          pt="10px"
        >
          {readNote ?? 'Read-only · no signature · address logged'}
        </Text>
      </Box>
    )
  }

  return (
    <Box
      bg={SEMANTIC_COLORS.bgPrimary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p={SPACING.md}
      display="grid"
      gap={SPACING.sm}
      justifyItems="center"
      textAlign="center"
      maxW="560px"
      w="100%"
    >
      {primaryConnect && (
        <Button
          type="button"
          onClick={useWalletAddress}
          {...BTN}
          w="100%"
          bg={SEMANTIC_COLORS.success}
          borderColor={SEMANTIC_COLORS.success}
          color={SEMANTIC_COLORS.bgPrimary}
          fontWeight={TYPOGRAPHY.medium}
          _hover={{ bg: SEMANTIC_COLORS.success, borderColor: SEMANTIC_COLORS.textPrimary }}
        >
          {isWalletConnected && walletAddress
            ? 'Use connected wallet'
            : (connectLabel ?? 'Connect a wallet')}
        </Button>
      )}

      <Box
        as="form"
        display="flex"
        gap={SPACING.sm}
        flexWrap="wrap"
        justifyContent="center"
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
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={primaryConnect ? '0x… connect or paste an address' : '0x… paste any address'}
          aria-label="Ethereum address to read a lending position from"
          isInvalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : undefined}
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

      {!primaryConnect && (
        <Button type="button" onClick={useWalletAddress} {...LINK_BTN}>
          {isWalletConnected && walletAddress
            ? 'Use connected wallet'
            : 'Connect a wallet to fill this in'}
        </Button>
      )}

      {loadedAddress && (
        <Button type="button" onClick={onClear} {...LINK_BTN}>
          Back to example
        </Button>
      )}

      {error && (
        <Text
          id={`${inputId}-error`}
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
        {readNote ?? 'Read-only · no signature · address logged'}
      </Text>
    </Box>
  )
}

export default AddressBar
