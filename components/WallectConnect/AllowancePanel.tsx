import React, { useMemo } from 'react'
import { Box, Button, HStack, Text, VStack } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import useAllowances, { type AllowanceRow } from '@/hooks/useAllowances'
import useTransaction from '@/hooks/useTransaction'
import { buildApprove } from '@/services/chain/allowance'
import { shiftDigits } from '@/helpers/math'

/**
 * Wallet-section allowance hygiene panel.
 *
 * Renders NOTHING while every allowance is zero — the common case, since the
 * pipeline emits exact approves consumed in the same flow. Nonzero rows are
 * almost always a dangling allowance from an abandoned flow; each row revokes
 * with one approve(0), and "Revoke all" submits every revoke through the
 * runner, which batches them into one atomic confirmation on 5792 wallets.
 */

const formatAmount = (row: AllowanceRow): string => {
  const value = shiftDigits(row.amount.toString(), -(row.asset.decimal ?? 18))
  const n = Number(value)
  if (!Number.isFinite(n)) return value.toString()
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toPrecision(4)
}

const AllowancePanel = () => {
  const { data: rows = [] } = useAllowances()

  const tx = useTransaction({
    msgs: undefined,
    successMessage: 'Approval revoked',
    shrinkMessage: true,
  })

  const revokeAllMsgs = useMemo(
    () => rows.map((row) => buildApprove(row.asset.base as `0x${string}`, row.spender, 0n)),
    [rows],
  )

  if (rows.length === 0) return null

  return (
    <Box
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      pt={SPACING.md}
      mt={SPACING.md}
    >
      <HStack justifyContent="space-between" mb={SPACING.sm}>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          textTransform="uppercase"
          letterSpacing="0.28em"
          color={SEMANTIC_COLORS.textSecondary}
        >
          Open approvals
        </Text>
        {rows.length > 1 && (
          <Button
            variant="link"
            size="xs"
            fontFamily={TYPOGRAPHY.fontMono}
            color={SEMANTIC_COLORS.danger}
            isLoading={tx.isPending}
            onClick={() => tx.mutate(revokeAllMsgs)}
            transition={TRANSITIONS.colors}
            _hover={{ color: SEMANTIC_COLORS.primary }}
            _active={ACTIVE_EFFECTS.dim}
            _focus={FOCUS_STYLES.ring}
            aria-label="Revoke all open approvals"
          >
            Revoke all
          </Button>
        )}
      </HStack>

      <VStack spacing={SPACING.xs} alignItems="stretch">
        {rows.map((row) => (
          <HStack
            key={`${row.asset.base}:${row.spender}`}
            justifyContent="space-between"
            gap={SPACING.sm}
          >
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textPrimary}
              noOfLines={1}
            >
              {formatAmount(row)} {row.asset.symbol}
              <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
                {' '}
                → {row.spenderLabel}
              </Text>
            </Text>
            <Button
              variant="link"
              size="xs"
              fontFamily={TYPOGRAPHY.fontMono}
              color={SEMANTIC_COLORS.textSecondary}
              isLoading={tx.isPending}
              onClick={() =>
                tx.mutate([buildApprove(row.asset.base as `0x${string}`, row.spender, 0n)])
              }
              transition={TRANSITIONS.colors}
              _hover={{ color: SEMANTIC_COLORS.primary }}
              _active={ACTIVE_EFFECTS.dim}
              _focus={FOCUS_STYLES.ring}
              aria-label={`Revoke ${row.asset.symbol} approval for ${row.spenderLabel}`}
            >
              Revoke
            </Button>
          </HStack>
        ))}
      </VStack>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        color={SEMANTIC_COLORS.textTertiary}
        mt={SPACING.sm}
      >
        Disconnecting keeps approvals live. Revoke to clear them.
      </Text>
    </Box>
  )
}

export default AllowancePanel
