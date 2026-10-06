import React from 'react'
import { Box, Grid, Text } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { SectionHeading, Stamp } from '@/components/Carry/atoms'
import { Card } from '@/components/ui/Card'
import {
  CARD_WINDOW_DAYS,
  changeCell,
  cooldownNote,
  queueCell,
  waitCell,
  type Cell,
} from '@/components/Venue/exitQueueLogic'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { ExitQueueFeed } from '@/lib/exitQueue/feed'

/**
 * ExitQueueCard — per venue: the queue now, how long requests have actually taken,
 * and the last parameter change. Data: /api/venues/exit-queues (local ledger).
 * Durations are measured history, not a forecast; the beacon row is the chain's own
 * exit schedule. The card never prints an ETA.
 */

const COLUMNS = { base: '1fr', md: '150px minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1.2fr)' }

const CellText: React.FC<{ cell: Cell; label: string }> = ({ cell, label }) => (
  <Box>
    <Text
      display={{ base: 'block', md: 'none' }}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="9px"
      letterSpacing="0.12em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
    >
      {label}
    </Text>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.small}
      color={SEMANTIC_COLORS.textPrimary}
    >
      {cell.primary}
    </Text>
    {cell.secondary && (
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textSecondary}
        overflowWrap="anywhere"
      >
        {cell.secondary}
      </Text>
    )}
  </Box>
)

const Header: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    letterSpacing="0.12em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textTertiary}
  >
    {children}
  </Text>
)

const Note: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize={TYPOGRAPHY.small}
    color={SEMANTIC_COLORS.textSecondary}
  >
    {children}
  </Text>
)

export const ExitQueueCard: React.FC = () => {
  const { data, isError } = useQuery<ExitQueueFeed>({
    queryKey: ['venue_exit_queues'],
    queryFn: async () => {
      const response = await fetch('/api/venues/exit-queues', { cache: 'no-store' })
      if (!response.ok) throw new Error(`exit queues ${response.status}`)
      return response.json()
    },
    staleTime: 60_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  })

  const venues = (data?.venues ?? []).filter((v) => v.anchor)
  const anchorBlock = venues.length ? Math.max(...venues.map((v) => v.anchor!.block)) : null

  return (
    <Box>
      <SectionHeading
        index="08 /"
        title="Exit queues"
        note="withdrawal requests · measured history, not a forecast"
      />
      <Card p={SPACING.base}>
        {isError ? (
          <Note>The exit-queue ledger is unavailable on this host.</Note>
        ) : !data ? (
          <Note>Loading exit queues…</Note>
        ) : data.status === 'no_local_ledger' ? (
          <Note>
            No local exit-queue ledger on this host. Run `pnpm exitq:record --run` to build it.
          </Note>
        ) : (
          <Box>
            {data.observationStatus === 'paused' && (
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                fontWeight={700}
                color={SEMANTIC_COLORS.textPrimary}
                mb={SPACING.sm}
              >
                Recorder paused · the rows below are historical and may have changed.
              </Text>
            )}
            <Grid
              display={{ base: 'none', md: 'grid' }}
              templateColumns={COLUMNS}
              gap={SPACING.base}
              pb={SPACING.sm}
              borderBottom="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
            >
              <Header>Venue</Header>
              <Header>Queue now</Header>
              <Header>Requests took · last {CARD_WINDOW_DAYS}d</Header>
              <Header>Last parameter change</Header>
            </Grid>
            {venues.map((m, index) => {
              const cooldown = cooldownNote(m)
              return (
                <Grid
                  key={m.venue}
                  templateColumns={COLUMNS}
                  gap={SPACING.base}
                  py={SPACING.md}
                  borderBottom={index === venues.length - 1 ? 'none' : '1px solid'}
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                >
                  <Box>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.small}
                      fontWeight={700}
                      color={SEMANTIC_COLORS.textPrimary}
                    >
                      {m.label}
                    </Text>
                    {cooldown && (
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.textSecondary}
                      >
                        {cooldown}
                      </Text>
                    )}
                  </Box>
                  <CellText label="Queue now" cell={queueCell(m)} />
                  <CellText
                    label={`Requests took · last ${CARD_WINDOW_DAYS}d`}
                    cell={waitCell(m)}
                  />
                  <CellText label="Last parameter change" cell={changeCell(m)} />
                </Grid>
              )
            })}
            <Stamp>
              Request → claimable over the trailing {CARD_WINDOW_DAYS} days; requests still waiting
              count as waiting at least this long (Kaplan–Meier). Measured history, not a forecast.
              Beacon row: the chain&apos;s own exit schedule at the anchor; its window readings are
              measured history. Neither is a forecast.
              {anchorBlock != null &&
                ` Anchor: finalized block ${anchorBlock.toLocaleString('en-US')}.`}
            </Stamp>
          </Box>
        )}
      </Card>
    </Box>
  )
}

export default ExitQueueCard
