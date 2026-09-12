// THE CLOSE.
//
// Offered only after a REAL run showed a real address a bad number — the gate lives in
// Simulator.tsx (not demo, comparison exists, the source engine liquidated). Asking a
// visitor for a contact off the worked example would be asking off a number that was
// never theirs.
//
// The counter is honest by construction: a cap is printed only when the API returns
// one (SIM_ALLOCATION_CAP). `capped_at: null` means no cap is stated anywhere, so this
// block states none either — it never invents scarcity.

import React, { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Box, Button, Input, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow, monoXs, tabular } from '@/components/Builder/styles'

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

interface AllocationSummary {
  claims: number
  capped_at: number | null
}

interface ClaimResult {
  rank: number | null
  ranked_at: string | null
}

export interface AllocationCloseProps {
  /** The address that was just read. Never the worked example. */
  address: string
}

export const AllocationClose: React.FC<AllocationCloseProps> = ({ address }) => {
  const [contact, setContact] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claimed, setClaimed] = useState<ClaimResult | null>(null)

  const summary = useQuery<AllocationSummary>({
    queryKey: ['sim_allocation'],
    queryFn: async () => {
      const r = await fetch('/api/sim/allocation')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as AllocationSummary
    },
    refetchOnMount: true,
    staleTime: 60_000,
  })

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (pending) return
      setPending(true)
      setError(null)
      try {
        const r = await fetch('/api/sim/allocation', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address, contact: contact.trim() }),
        })
        const j = (await r.json().catch(() => ({}))) as Partial<ClaimResult> & { error?: string }
        if (!r.ok) {
          setError(typeof j.error === 'string' ? j.error : `HTTP ${r.status}`)
        } else {
          setClaimed({ rank: j.rank ?? null, ranked_at: j.ranked_at ?? null })
          void summary.refetch()
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setPending(false)
      }
    },
    [address, contact, pending, summary],
  )

  const counter =
    summary.data != null
      ? `${summary.data.claims.toLocaleString('en-US')} claimed${
          summary.data.capped_at ? ` of ${summary.data.capped_at.toLocaleString('en-US')}` : ''
        }`
      : null

  const confirmation =
    claimed == null
      ? null
      : claimed.rank != null && claimed.ranked_at != null
        ? `You're #${claimed.rank} — ordered by your first run on ${new Date(claimed.ranked_at).toISOString().slice(0, 10)}.`
        : 'Claimed.'

  return (
    <Box
      data-testid="sim-allocation"
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      bg={SEMANTIC_COLORS.bgSecondary}
      borderRadius={0}
      px={{ base: SPACING.base, md: SPACING.lg }}
      py={{ base: SPACING.base, md: SPACING.lg }}
      display="grid"
      gap={SPACING.md}
    >
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="baseline"
        gap={SPACING.md}
        flexWrap="wrap"
      >
        <Text {...eyebrow}>launch allocation</Text>
        {counter && (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11px"
            {...tabular}
            color={SEMANTIC_COLORS.textSecondary}
          >
            {counter}
          </Text>
        )}
      </Box>

      <Text
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize="clamp(22px, 3.6vw, 34px)"
        lineHeight={1.12}
        letterSpacing="-0.01em"
        color={SEMANTIC_COLORS.textPrimary}
      >
        Get in before the next one.
      </Text>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="12.5px"
        lineHeight={1.8}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="82ch"
      >
        Launch allocation is ordered by when an address first ran this simulator — earliest first.
        Claim with the address you just read; leave a contact if you want to be reached.
      </Text>

      <Box as="form" display="flex" gap={SPACING.sm} flexWrap="wrap" onSubmit={onSubmit}>
        <Input
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          maxLength={120}
          placeholder="email · telegram · farcaster — optional"
          aria-label="Contact for the launch allocation — optional"
          flex="1 1 320px"
          minW="0"
          bg={SEMANTIC_COLORS.bgPrimary}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
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
        <Button type="submit" isDisabled={pending} {...BTN}>
          {pending ? 'Claiming…' : `Claim allocation for ${shortAddress(address)}`}
        </Button>
      </Box>

      {confirmation && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12.5px"
          lineHeight={1.7}
          color={SEMANTIC_COLORS.success}
        >
          {confirmation}
        </Text>
      )}

      {error && (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="12px"
          lineHeight={1.7}
          color={SEMANTIC_COLORS.danger}
        >
          {error}
        </Text>
      )}

      <Text {...monoXs} lineHeight={1.7}>
        Address + the contact you typed. Nothing else is stored.
      </Text>
    </Box>
  )
}

export default AllocationClose
