// The page's one gesture: paste an address, or fill it from a connected wallet. Read-only:
// connecting only supplies the address; nothing is signed and nothing is sent. The wallet
// itself is the page's concern (PositionV0); this form only renders and reports.

import React from 'react'
import { Box, Button, Input } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'

import { Small } from './primitives'
import { CAPS, TYPE } from './typeScale'

const INPUT_ID = 'position-address-input'

export interface AddressFormProps {
  value: string
  onChange: (v: string) => void
  onSubmit: (v: string) => void
  /** Fill from the connected wallet, or ask to connect one. */
  onWallet: () => void
  walletConnected: boolean
  isReading: boolean
  error: string | null
}

export const AddressForm: React.FC<AddressFormProps> = ({
  value,
  onChange,
  onSubmit,
  onWallet,
  walletConnected,
  isReading,
  error,
}) => {
  return (
    <Box display="grid" gap={SPACING.sm} minW={0}>
      <Box
        as="form"
        display="flex"
        flexWrap="wrap"
        gap={SPACING.sm}
        minW={0}
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault()
          onSubmit(value)
        }}
      >
        <Input
          id={INPUT_ID}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0x… paste any Ethereum address"
          aria-label="Ethereum address to read lending positions from"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${INPUT_ID}-error` : `${INPUT_ID}-note`}
          autoComplete="off"
          spellCheck={false}
          flex="1 1 240px"
          minW={0}
          w="auto"
          textAlign="left"
          h="44px"
          px={SPACING.md}
          bg={NEWS.card}
          color={NEWS.ink}
          border={`1px solid ${error ? NEWS.danger : NEWS.ruleStrong}`}
          borderRadius={0}
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPE.body}
          transition={TRANSITIONS.colors}
          _placeholder={{ color: NEWS.muted }}
          _hover={{ borderColor: NEWS.ink }}
          _focusVisible={{ borderColor: NEWS.ink, outline: `2px solid ${NEWS.ink}`, outlineOffset: '2px' }}
        />
        <Button
          type="submit"
          isDisabled={isReading}
          w="auto"
          h="44px"
          minW="96px"
          px={SPACING.base}
          bg={NEWS.ink}
          color={NEWS.paper}
          border={`1px solid ${NEWS.ink}`}
          borderRadius={0}
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPE.label}
          fontWeight={700}
          {...CAPS}
          transition={TRANSITIONS.colors}
          _hover={{ bg: NEWS.ink2, borderColor: NEWS.ink2 }}
          _active={{ opacity: 0.85 }}
          _disabled={{ opacity: 0.5, cursor: 'progress' }}
        >
          {isReading ? 'Reading…' : 'Read'}
        </Button>
      </Box>
      <Box display="flex" flexWrap="wrap" alignItems="center" columnGap={SPACING.base} minW={0}>
        <Button
          type="button"
          variant="unstyled"
          onClick={onWallet}
          w="auto"
          h="44px"
          minW={0}
          px={0}
          color={NEWS.accent}
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPE.label}
          fontWeight={700}
          {...CAPS}
          textDecoration="underline"
          textUnderlineOffset="3px"
          transition={TRANSITIONS.colors}
          _hover={{ color: NEWS.ink }}
        >
          {walletConnected ? 'Use connected wallet' : 'Connect a wallet to fill this'}
        </Button>
        <Small id={`${INPUT_ID}-note`}>
          Read-only. No signature. Morpho positions are looked up through Morpho&apos;s public API.
        </Small>
      </Box>
      {error && (
        <Small id={`${INPUT_ID}-error`} role="alert" color={NEWS.danger}>
          ✖ {error}
        </Small>
      )}
    </Box>
  )
}
