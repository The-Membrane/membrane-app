import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { ConfigCardView, ConfigChangeView } from '@/lib/oracleRegistry/config/apiTypes'

import { Chip, ExtLink } from './ConfigAtoms'
import {
  announcementChip,
  batchLoudChips,
  batchOpensByDefault,
  batchRows,
  blockText,
  changeAnchor,
  compactDigits,
  DIMENSION_LABEL,
  filterRows,
  groupRows,
  hashToChangeId,
  historicalAside,
  nextFilter,
  permalinkLabel,
  RED_META,
  redChips,
  rowFrame,
  rowNoteLine,
  readBeforeEta,
  routeLabel,
  rowState,
  STATE_META,
  smallText,
  stateText,
  staleRedCount,
  tagChips,
  tagToken,
  timelineCountsLine,
  timelineFilterButtons,
  type TimelineFilter,
  type TimelineItem,
} from './configViewModel'
import { fmtUtc } from './viewModel'

// The change timeline: pending (amber) first, then proposed (blue), then historical (grey).
// A downgrade or floor breach takes the red border in ANY state, but the state is always
// written out next to its glyph. Every row is linkable (#<changeId>) and links to its tx, its
// Safe transaction or timelock, and names who can execute it when it is pending.

const FilterButton: React.FC<{
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
  token?: string
}> = ({ active, disabled, onClick, children, token = SEMANTIC_COLORS.primary }) => (
  <Box
    as="button"
    type="button"
    aria-pressed={active}
    disabled={disabled}
    onClick={onClick}
    px={SPACING.sm}
    py="3px"
    border="1px solid"
    borderColor={active ? token : SEMANTIC_COLORS.borderSubtle}
    bg={active ? SEMANTIC_COLORS.bgTertiary : 'transparent'}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="11px"
    // disabled labels still carry information ("Oracles: not collected"): AA-contrast text,
    // a dashed border says disabled (review round 7: 0.6 opacity on tertiary was ~1.8:1)
    color={disabled ? smallText(SEMANTIC_COLORS.textTertiary) : SEMANTIC_COLORS.textSecondary}
    borderStyle={disabled ? 'dashed' : 'solid'}
    cursor={disabled ? 'default' : 'pointer'}
    transition={TRANSITIONS.colors}
    _hover={disabled ? undefined : { borderColor: SEMANTIC_COLORS.borderStrong }}
    _focusVisible={FOCUS_STYLES.ring}
  >
    {children}
  </Box>
)

const Row: React.FC<{
  r: ConfigChangeView
  now: number | null
  asOfTs: number
  rules: Record<string, string>
  targeted: boolean
  /** A call inside a batch: the op-wide lines (queue, executor, ETA, announcement) sit on the batch. */
  inBatch?: boolean
}> = ({ r, now, asOfTs, rules, targeted, inBatch = false }) => {
  const f = rowFrame(r)
  const reds = redChips(r)
  // The header carries the subject-wide status; rows repeat it only where it matters.
  const ann = !inBatch && (r.state !== 'historical' || r.red) ? announcementChip(r) : null
  const tags = tagChips(r.tags)
  const quiet = rowState(r) === 'historical' || rowState(r) === 'stale'
  return (
    <Box
      as="li"
      id={r.id}
      tabIndex={-1}
      display="grid"
      gridTemplateColumns={{ base: '1fr', md: '190px minmax(0, 1fr) minmax(120px, auto)' }}
      columnGap={SPACING.base}
      rowGap="4px"
      mt="6px"
      py={SPACING.sm}
      pl={SPACING.md}
      pr={SPACING.sm}
      border="1px solid"
      borderColor={f.outline ?? 'transparent'}
      borderLeftWidth={f.accentWidth === '3px' ? '3px' : '1px'}
      borderLeftColor={f.accent}
      borderTopColor={f.outline ?? SEMANTIC_COLORS.borderSubtle}
      boxShadow={targeted ? `0 0 0 2px ${SEMANTIC_COLORS.primary}` : undefined}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.xs}
      _focusVisible={FOCUS_STYLES.ring}
      sx={{ scrollMarginTop: '96px' }}
    >
      <Box>
        <Text color={f.state.text ?? f.state.token} fontWeight={600} letterSpacing="0.04em">
          <span aria-hidden="true">{f.state.glyph} </span>
          {stateText(r, now)}
        </Text>
        <Text color={SEMANTIC_COLORS.textSecondary} fontSize="11px">
          {r.ts ? fmtUtc(r.ts) : '—'}
        </Text>
        <Text color={SEMANTIC_COLORS.textSecondary} fontSize="11px">
          {blockText(r)}
        </Text>
      </Box>

      <Box minW={0}>
        <Text
          color={quiet && !r.red ? SEMANTIC_COLORS.textSecondary : SEMANTIC_COLORS.textPrimary}
          wordBreak="break-word"
        >
          <Text
            as="span"
            color={SEMANTIC_COLORS.textSecondary}
            fontSize="10px"
            letterSpacing="0.12em"
          >
            {DIMENSION_LABEL[r.dimension].toUpperCase()}
            {r.route ? ` · ${routeLabel(r.route)}` : ''} ·{' '}
          </Text>
          {compactDigits(r.title)}
        </Text>
        {(r.before || r.after) && (
          <Text color={SEMANTIC_COLORS.textSecondary} fontSize="11px" wordBreak="break-word">
            {compactDigits(r.before ?? '—')} → {compactDigits(r.after ?? '—')}
          </Text>
        )}
        <Box display="flex" flexWrap="wrap" gap="4px" mt="4px">
          {reds.map((c) => (
            <Chip key={c} token={RED_META.token} glyph={RED_META.glyph}>
              {c}
            </Chip>
          ))}
          {r.ruleIds.map((id) => (
            <Chip
              key={id}
              token={r.red ? RED_META.token : SEMANTIC_COLORS.textSecondary}
              title={rules[id] ?? id}
              loud={false}
            >
              {id}
            </Chip>
          ))}
          {tags
            .filter((t) => t.loud)
            .map((t) => (
              <Chip key={t.label} token={tagToken(t)}>
                {t.label}
              </Chip>
            ))}
          {ann && (
            <Chip
              token={ann.tone === 'danger' ? RED_META.token : SEMANTIC_COLORS.textSecondary}
              title={ann.title}
            >
              {ann.label}
            </Chip>
          )}
        </Box>
        {(tags.some((t) => !t.loud) || r.notes.length > 0) && (
          <Text
            color={SEMANTIC_COLORS.textSecondary}
            fontSize="11px"
            mt="2px"
            wordBreak="break-word"
          >
            {rowNoteLine(r.tags, r.notes)}
          </Text>
        )}
      </Box>

      <Box
        fontSize="11px"
        color={SEMANTIC_COLORS.textSecondary}
        textAlign={{ base: 'left', md: 'right' }}
      >
        <Box
          display="flex"
          flexWrap="wrap"
          gap="8px"
          justifyContent={{ base: 'flex-start', md: 'flex-end' }}
        >
          {r.txUrl && <ExtLink href={r.txUrl}>tx ↗</ExtLink>}
          {r.queue && !inBatch && (
            <ExtLink href={r.queue.url} title={`op ${r.queue.opId}`}>
              {r.queue.kind === 'safe' ? 'Safe tx ↗' : `${r.queue.label} ↗`}
            </ExtLink>
          )}
          <ExtLink
            href={changeAnchor(r.id)}
            title="Link to this change"
            label={permalinkLabel(r.title)}
            internal
          >
            #
          </ExtLink>
        </Box>
        {!inBatch && <OpLines r={r} now={now} asOfTs={asOfTs} />}
      </Box>
    </Box>
  )
}

/** Who can execute a pending timelock op, its ETA, and whether the read predates the ETA. */
const OpLines: React.FC<{ r: ConfigChangeView; now: number | null; asOfTs: number }> = ({
  r,
  now,
  asOfTs,
}) => (
  <>
    {r.state === 'pending' && r.queue?.kind === 'oz_timelock' && (
      <Text mt="2px" color={SEMANTIC_COLORS.textSecondary} wordBreak="break-word">
        executable by {r.executableBy ?? 'executor not read'}
      </Text>
    )}
    {r.state === 'pending' && r.eta && r.eta > 1 && (
      <Text color={SEMANTIC_COLORS.textSecondary}>ETA {fmtUtc(r.eta)}</Text>
    )}
    {r.state === 'pending' && readBeforeEta(r.eta, asOfTs, now) && (
      <Text
        color={SEMANTIC_COLORS.warning}
        title="The ETA passed after the collector's last read, so this op may have executed since"
      >
        <span aria-hidden="true">? </span>last read before ETA
      </Text>
    )}
  </>
)

/**
 * The calls of one queued op (timelock scheduleBatch / Safe multiSend) as one item: the op's
 * state, ETA, executor and links once, then the calls behind a disclosure. A batch with a red
 * call opens by default and takes the red border; so does one holding the deep-linked call.
 * Review round 6: the calls' loud chips (WIDER DVN SET, CALL NOT DECODED, TIMELOCK BYPASS…) are
 * repeated on the header, and a batch carrying one opens by default too.
 */
const Batch: React.FC<{
  b: Extract<TimelineItem, { kind: 'batch' }>
  now: number | null
  asOfTs: number
  rules: Record<string, string>
  target: string | null
}> = ({ b, now, asOfTs, rules, target }) => {
  const { head } = b
  const f = rowFrame({ state: head.state, stage: head.stage, red: b.redCount > 0 })
  const ann = announcementChip(head)
  const holdsTarget = b.rows.some((r) => r.id === target)
  const [open, setOpen] = useState(batchOpensByDefault(b))
  const ruleIds = [...new Set(b.rows.flatMap((r) => r.ruleIds))]
  const loud = batchLoudChips(b.rows)
  return (
    <Box
      as="li"
      mt="6px"
      py={SPACING.sm}
      pl={SPACING.md}
      pr={SPACING.sm}
      border="1px solid"
      borderColor={f.outline ?? 'transparent'}
      borderLeftWidth={f.accentWidth === '3px' ? '3px' : '1px'}
      borderLeftColor={f.accent}
      borderTopColor={f.outline ?? SEMANTIC_COLORS.borderSubtle}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.xs}
    >
      <Box
        display="grid"
        gridTemplateColumns={{ base: '1fr', md: '190px minmax(0, 1fr) minmax(120px, auto)' }}
        columnGap={SPACING.base}
        rowGap="4px"
      >
        <Box>
          <Text color={f.state.text ?? f.state.token} fontWeight={600} letterSpacing="0.04em">
            <span aria-hidden="true">{f.state.glyph} </span>
            {stateText(head, now)}
          </Text>
          <Text color={SEMANTIC_COLORS.textSecondary} fontSize="11px">
            {head.ts ? fmtUtc(head.ts) : '—'}
          </Text>
          <Text color={SEMANTIC_COLORS.textSecondary} fontSize="11px">
            {blockText(head)}
          </Text>
        </Box>
        <Box minW={0}>
          <Text color={SEMANTIC_COLORS.textPrimary} wordBreak="break-word">
            <Text
              as="span"
              color={SEMANTIC_COLORS.textSecondary}
              fontSize="10px"
              letterSpacing="0.12em"
            >
              BATCH · {b.rows.length} CALLS ·{' '}
            </Text>
            {b.summary}
          </Text>
          <Box display="flex" flexWrap="wrap" gap="4px" mt="4px">
            {b.redCount > 0 ? (
              <Chip token={RED_META.token} glyph={RED_META.glyph}>
                {b.redCount} RED
              </Chip>
            ) : (
              <Chip loud={false}>0 red</Chip>
            )}
            {ruleIds.map((id) => (
              <Chip
                key={id}
                token={b.redCount ? RED_META.token : SEMANTIC_COLORS.textSecondary}
                title={rules[id] ?? id}
                loud={false}
              >
                {id}
              </Chip>
            ))}
            {loud.map((t) => (
              <Chip key={t.label} token={tagToken(t)}>
                {t.label}
              </Chip>
            ))}
            {ann && (
              <Chip
                token={ann.tone === 'danger' ? RED_META.token : SEMANTIC_COLORS.textSecondary}
                title={ann.title}
              >
                {ann.label}
              </Chip>
            )}
          </Box>
        </Box>
        <Box
          fontSize="11px"
          color={SEMANTIC_COLORS.textSecondary}
          textAlign={{ base: 'left', md: 'right' }}
        >
          <Box
            display="flex"
            flexWrap="wrap"
            gap="8px"
            justifyContent={{ base: 'flex-start', md: 'flex-end' }}
          >
            {head.txUrl && <ExtLink href={head.txUrl}>tx ↗</ExtLink>}
            {head.queue && (
              <ExtLink href={head.queue.url} title={`op ${head.queue.opId}`}>
                {head.queue.kind === 'safe' ? 'Safe tx ↗' : `${head.queue.label} ↗`}
              </ExtLink>
            )}
          </Box>
          <OpLines r={head} now={now} asOfTs={asOfTs} />
        </Box>
      </Box>
      <Box
        as="details"
        mt="4px"
        open={open || holdsTarget}
        onToggle={(e: React.SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)}
      >
        <Box
          as="summary"
          cursor="pointer"
          fontSize="11px"
          color={SEMANTIC_COLORS.textSecondary}
          _focusVisible={FOCUS_STYLES.ring}
        >
          {b.rows.length} calls
        </Box>
        <Box as="ol" listStyleType="none" m={0} p={0}>
          {b.rows.map((r) => (
            <Row
              key={r.id}
              r={r}
              now={now}
              asOfTs={asOfTs}
              rules={rules}
              targeted={r.id === target}
              inBatch
            />
          ))}
        </Box>
      </Box>
    </Box>
  )
}

const Group: React.FC<{
  id: string
  title: string
  aside: string
  meta: { glyph: string; token: string }
  children: React.ReactNode
}> = ({ id, title, aside, meta, children }) => (
  <Box as="section" aria-labelledby={id} mt={SPACING.md}>
    <Text
      id={id}
      as="h4"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="11px"
      letterSpacing="0.2em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textSecondary}
    >
      <Text as="span" color={smallText(meta.token)} aria-hidden="true">
        {meta.glyph}{' '}
      </Text>
      {title}
      <Text
        as="span"
        letterSpacing="normal"
        textTransform="none"
        color={SEMANTIC_COLORS.textSecondary}
      >
        {' '}
        · {aside}
      </Text>
    </Text>
    <Box as="ol" listStyleType="none" m={0} p={0}>
      {children}
    </Box>
  </Box>
)

export const ConfigTimeline: React.FC<{
  view: ConfigCardView
  now: number | null
  onLoadAll: () => void
  loadingAll: boolean
}> = ({ view, now, onLoadAll, loadingAll }) => {
  const [filter, setFilter] = useState<TimelineFilter>({ dimension: null, redOnly: false })
  const [target, setTarget] = useState<string | null>(null)
  const { rows, complete } = view.timeline
  // a red op in the Stale group is never hidden behind a closed toggle
  const staleRed = staleRedCount(rows)
  const [staleOpen, setStaleOpen] = useState(staleRed > 0)
  useEffect(() => {
    if (staleRed > 0) setStaleOpen(true)
  }, [staleRed])

  useEffect(() => {
    const read = () => setTarget(hashToChangeId(window.location.hash))
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])

  // Deep link (#<changeId>): scroll to the row once; fetch the full history if it was trimmed.
  const handled = useRef<string | null>(null)
  useEffect(() => {
    if (!target || handled.current === target) return
    const row = rows.find((r) => r.id === target)
    if (!row) {
      if (!complete && !loadingAll) onLoadAll()
      else if (complete) handled.current = target
      return
    }
    handled.current = target
    if (rowState(row) === 'stale') setStaleOpen(true)
    setFilter({ dimension: null, redOnly: false })
    const id = window.requestAnimationFrame(() => {
      const el = document.getElementById(target)
      if (!el) return
      el.scrollIntoView({ block: 'center' })
      el.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(id)
  }, [target, rows, complete, loadingAll, onLoadAll])

  // the labels count the FULL timeline (review round 6), never only the loaded rows
  // (timelineFilterButtons reads view.timeline.totals)
  const groups = useMemo(() => groupRows(filterRows(rows, filter)), [rows, filter])
  const row = (r: ConfigChangeView) => (
    <Row
      key={r.id}
      r={r}
      now={now}
      asOfTs={view.asOf.ts}
      rules={view.rules}
      targeted={r.id === target}
    />
  )
  const item = (it: TimelineItem) =>
    it.kind === 'row' ? (
      row(it.row)
    ) : (
      <Batch
        key={it.key}
        b={it}
        now={now}
        asOfTs={view.asOf.ts}
        rules={view.rules}
        target={target}
      />
    )
  const ops = (rows: readonly ConfigChangeView[]) => {
    const n = batchRows(rows).length
    return n < rows.length ? ` · ${n} ${n === 1 ? 'op' : 'ops'}` : ''
  }
  // a filtered view of a trimmed timeline would miss rows: pressing a filter loads the rest
  const press = (a: Parameters<typeof nextFilter>[1]) => {
    setFilter((f) => nextFilter(f, a))
    if (a.kind !== 'all' && !complete && !loadingAll) onLoadAll()
  }
  const shown =
    groups.pending.length + groups.stale.length + groups.proposed.length + groups.historical.length

  return (
    <Box as="section" aria-labelledby="config-timeline" mt={SPACING.xl}>
      <Text
        id="config-timeline"
        as="h3"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h3}
        color={SEMANTIC_COLORS.textPrimary}
      >
        Changes
        <Text
          as="span"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          color={SEMANTIC_COLORS.textSecondary}
          ml={SPACING.sm}
        >
          {timelineCountsLine(view)}
        </Text>
      </Text>

      <Box
        display="flex"
        flexWrap="wrap"
        gap="6px"
        mt={SPACING.sm}
        role="group"
        aria-label="Filter changes"
      >
        {timelineFilterButtons(view, filter).map((b) =>
          b.key === 'red' ? (
            <FilterButton
              key={b.key}
              active={b.active}
              disabled={b.disabled}
              token={RED_META.token}
              onClick={() => press({ kind: 'red' })}
            >
              <Text as="span" color={RED_META.text} aria-hidden="true">
                {RED_META.glyph}{' '}
              </Text>
              {b.label}
            </FilterButton>
          ) : (
            <FilterButton
              key={b.key}
              active={b.active}
              disabled={b.disabled}
              onClick={() => {
                const k = b.key
                press(
                  k === 'all' || k === 'red' ? { kind: k } : { kind: 'dimension', dimension: k },
                )
              }}
            >
              {b.label}
            </FilterButton>
          ),
        )}
      </Box>

      {shown === 0 && (
        <Text
          mt={SPACING.md}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textSecondary}
        >
          {rows.length
            ? 'no changes match this filter'
            : view.available
              ? 'no changes recorded in the scanned range'
              : 'not collected: no history, pending or proposed changes were read'}
        </Text>
      )}

      {groups.pending.length > 0 && (
        <Group
          id="config-pending"
          title="Pending"
          aside={`${groups.pending.length} queued on-chain${ops(groups.pending)}`}
          meta={STATE_META.pending}
        >
          {batchRows(groups.pending).map(item)}
        </Group>
      )}
      {groups.stale.length > 0 && (
        <Box
          as="details"
          mt={SPACING.md}
          open={staleOpen}
          onToggle={(e: React.SyntheticEvent<HTMLDetailsElement>) =>
            setStaleOpen(e.currentTarget.open)
          }
        >
          <Box
            as="summary"
            cursor="pointer"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11px"
            letterSpacing="0.2em"
            textTransform="uppercase"
            color={SEMANTIC_COLORS.textSecondary}
            _focusVisible={FOCUS_STYLES.ring}
          >
            <span aria-hidden="true">{STATE_META.stale.glyph} </span>
            Stale
            {staleRed > 0 && (
              <Text as="span" ml="6px" letterSpacing="normal" color={RED_META.text}>
                <span aria-hidden="true">{RED_META.glyph} </span>
                {staleRed} red
              </Text>
            )}
            <Text
              as="span"
              letterSpacing="normal"
              textTransform="none"
              color={SEMANTIC_COLORS.textSecondary}
            >
              {' '}
              · {groups.stale.length} past ETA, cannot execute now — not counted as pending
              {staleRed > 0 ? ' (red ones count as open red flags)' : ''}
            </Text>
          </Box>
          <Box as="ol" listStyleType="none" m={0} p={0}>
            {batchRows(groups.stale).map(item)}
          </Box>
        </Box>
      )}
      {groups.proposed.length > 0 && (
        <Group
          id="config-proposed"
          title="Proposed"
          aside={`${groups.proposed.length} in a Safe queue, not on-chain yet${ops(groups.proposed)}`}
          meta={STATE_META.proposed}
        >
          {batchRows(groups.proposed).map(item)}
        </Group>
      )}
      {groups.historical.length > 0 && (
        <Group
          id="config-historical"
          title="Historical"
          aside={historicalAside({
            matching: groups.historical.length,
            filtered: !!filter.dimension || filter.redOnly,
            timeline: view.timeline,
          })}
          meta={STATE_META.historical}
        >
          {groups.historical.map(row)}
        </Group>
      )}
      {!complete && (
        <Box mt={SPACING.md}>
          <FilterButton active={false} disabled={loadingAll} onClick={onLoadAll}>
            {loadingAll
              ? 'loading full history…'
              : `Show all ${view.timeline.historicalTotal} historical changes`}
          </FilterButton>
        </Box>
      )}
    </Box>
  )
}

export default ConfigTimeline
