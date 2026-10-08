import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { ConfigCardView, OAppView, RouteRowView } from '@/lib/oracleRegistry/config/apiTypes'

import { BlockTitle, BreachLine, Chip, ExtLink, Holders, ItemLine } from './ConfigAtoms'
import {
  closedRoutesDisclosure,
  eCell,
  oappSummary,
  operatorLabels,
  RED_META,
  remoteOperatorsDiffer,
  routeFlags,
  routeValueText,
  smallText,
  unreadLines,
} from './configViewModel'

// Bridge dimension: one route table per LayerZero OApp — a row per remote chain with the
// effective verifier count E on all four sides (Ethereum in / out, remote in / out). ■ marks a
// live side under the absolute floor (fewer than 2 distinct known operators). Remote sides
// that could not be read say UNREAD rather than looking calm. Closed routes fold away.

const GRID = { base: '1fr 1fr', md: 'minmax(150px, 1.3fr) 60px 60px 60px 60px minmax(160px, 2fr)' }

const ECellView: React.FC<{
  label: string
  side: RouteRowView['local']['send'] | undefined
  unread?: string | null
}> = ({ label, side, unread }) => {
  const c = eCell(side, unread)
  return (
    <Box role="cell" title={c.label} display="flex" alignItems="baseline" gap="6px">
      <Text
        as="span"
        display={{ base: 'inline', md: 'none' }}
        fontSize="10px"
        whiteSpace="nowrap"
        color={SEMANTIC_COLORS.textSecondary}
      >
        {label}
      </Text>
      <Text as="span" color={smallText(c.token)} fontWeight={c.glyph ? 700 : undefined}>
        {c.glyph && <span aria-hidden="true">{c.glyph} </span>}
        {c.text}
      </Text>
      {side?.live && side.shape !== 'closed' && (
        <Text
          as="span"
          fontSize="10px"
          color={SEMANTIC_COLORS.textSecondary}
          display={{ base: 'inline', md: 'none' }}
        >
          {side.shape}
        </Text>
      )}
    </Box>
  )
}

const RouteRow: React.FC<{ r: RouteRowView; rules: Record<string, string> }> = ({ r, rules }) => {
  const unread = r.remote?.unread ?? null
  const opSide = r.local.receive ?? r.local.send
  const ops = opSide ? operatorLabels(opSide) : []
  const differs = remoteOperatorsDiffer(r.local.receive, r.remote?.receive)
  const flags = routeFlags(r)
  // the reason a side was not read is text, not only a tooltip (touch / screen readers)
  const unread_ = unreadLines(r)
  return (
    <Box
      role="row"
      display="grid"
      gridTemplateColumns={GRID}
      columnGap={SPACING.md}
      rowGap="2px"
      py="6px"
      px={SPACING.sm}
      borderTop="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      borderLeft="3px solid"
      borderLeftColor={r.floorBreach || flags.breaches.length ? RED_META.token : 'transparent'}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.xs}
      color={r.live ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
    >
      <Box role="cell" gridColumn={{ base: '1 / -1', md: 'auto' }} minW={0}>
        <Text as="span">{r.chain}</Text>
        <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
          {' '}
          · {r.eid}
        </Text>
        {r.floorBreach && (
          <Text as="span" ml="6px">
            <Chip token={RED_META.token} glyph={RED_META.glyph}>
              FLOOR BREACH
            </Chip>
          </Text>
        )}
        {r.floorBreach && (
          // the severity rank: the value at risk behind the route (rows are sorted by it)
          <Text
            as="span"
            ml="6px"
            fontSize="11px"
            color={SEMANTIC_COLORS.textSecondary}
            title={r.valueAtRisk?.priceBasis}
          >
            {routeValueText(r.valueAtRisk)}
          </Text>
        )}
        {r.remote?.url && (
          <Text as="span" ml="6px" fontSize="10px">
            <ExtLink href={r.remote.url} title={`remote OApp ${r.remote.address}`}>
              remote ↗
            </ExtLink>
          </Text>
        )}
      </Box>
      <ECellView label="ETH in" side={r.local.receive} />
      <ECellView label="ETH out" side={r.local.send} />
      <ECellView label="remote in" side={r.remote?.receive} unread={unread} />
      <ECellView label="remote out" side={r.remote?.send} unread={unread} />
      <Box
        role="cell"
        gridColumn={{ base: '1 / -1', md: 'auto' }}
        color={SEMANTIC_COLORS.textSecondary}
        minW={0}
      >
        <Text as="span" wordBreak="break-word">
          {ops.length ? ops.join(', ') : '—'}
        </Text>
        {r.local.receive?.confirmations && (
          <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
            {' '}
            · {r.local.receive.confirmations} conf
          </Text>
        )}
        {differs && r.remote?.receive && (
          <Text color={SEMANTIC_COLORS.textSecondary} wordBreak="break-word">
            remote in: {operatorLabels(r.remote.receive).join(', ') || '—'}
          </Text>
        )}
        {(flags.tags.length > 0 || flags.warnings.length > 0) && (
          <Text color={SEMANTIC_COLORS.textSecondary} fontSize="11px" wordBreak="break-word">
            {[...flags.tags, ...flags.warnings].join(' · ')}
          </Text>
        )}
      </Box>
      {unread_.length > 0 && (
        <Box role="cell" gridColumn="1 / -1" color={SEMANTIC_COLORS.warning} fontSize="11px">
          {unread_.map((u) => (
            <Text key={u} wordBreak="break-word">
              <span aria-hidden="true">? </span>
              {u}
            </Text>
          ))}
        </Box>
      )}
      {flags.breaches.length > 0 && (
        <Box role="cell" gridColumn="1 / -1">
          {flags.breaches.map((b) => (
            <BreachLine key={`${b.ruleId}-${b.message}`} b={b} rule={rules[b.ruleId]} />
          ))}
        </Box>
      )}
    </Box>
  )
}

const HeaderRow: React.FC = () => (
  <Box
    role="row"
    display={{ base: 'none', md: 'grid' }}
    gridTemplateColumns={GRID}
    columnGap={SPACING.md}
    px={SPACING.sm}
    pb="4px"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.12em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.textSecondary}
  >
    <Box role="columnheader">Route · eid</Box>
    <Box role="columnheader" title="Effective distinct known operators, Ethereum receive side">
      ETH in
    </Box>
    <Box role="columnheader" title="Ethereum send side">
      ETH out
    </Box>
    <Box role="columnheader" title="Remote chain receive side">
      Rem in
    </Box>
    <Box role="columnheader" title="Remote chain send side">
      Rem out
    </Box>
    <Box role="columnheader">Operators (ETH in)</Box>
  </Box>
)

const OAppTable: React.FC<{ o: OAppView; rules: Record<string, string> }> = ({ o, rules }) => {
  const live = o.routes.filter((r) => r.live)
  const closed = o.routes.filter((r) => !r.live)
  const disclosure = closedRoutesDisclosure(closed)
  return (
    <Box mt={SPACING.md}>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textPrimary}
      >
        <ExtLink href={o.url} title={o.address}>
          {o.label}
        </ExtLink>
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={SEMANTIC_COLORS.textSecondary}
        lineHeight={1.6}
      >
        owner{' '}
        <Holders
          holders={
            o.owner.length ? o.owner : [{ kind: 'unresolved', label: 'not read', url: null }]
          }
        />
        {' · '}delegate{' '}
        <Holders
          holders={
            o.delegate.length ? o.delegate : [{ kind: 'unresolved', label: 'not read', url: null }]
          }
        />
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={SEMANTIC_COLORS.textSecondary}
        mb="4px"
      >
        {oappSummary(o)}
      </Text>
      <Box role="table" aria-label={`${o.label} routes`} overflowX="hidden">
        <HeaderRow />
        {live.map((r) => (
          <RouteRow key={r.eid} r={r} rules={rules} />
        ))}
      </Box>
      {closed.length > 0 && (
        <Box
          as="details"
          mt="4px"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          color={SEMANTIC_COLORS.textSecondary}
          // a closed route with a red flag opens the disclosure (never collapsed under calm text)
          open={disclosure.open || undefined}
        >
          <Box
            as="summary"
            cursor="pointer"
            _focusVisible={FOCUS_STYLES.ring}
            color={disclosure.red ? RED_META.text : undefined}
          >
            {disclosure.summary}
          </Box>
          <Box role="table" aria-label={`${o.label} closed routes`}>
            {closed.map((r) => (
              <RouteRow key={r.eid} r={r} rules={rules} />
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

export const ConfigBridge: React.FC<{
  bridge: ConfigCardView['bridge']
  rules: Record<string, string>
  /** false: no collector output — say "not collected", never "no LayerZero OApp". */
  available?: boolean
}> = ({ bridge, rules, available = true }) => {
  const routes = bridge.oapps.reduce((n, o) => n + o.routes.length, 0)
  return (
    <Box as="section" aria-labelledby="config-bridge">
      <BlockTitle
        id="config-bridge"
        aside={
          !available
            ? 'not collected'
            : [
                routes
                  ? `${routes} LayerZero ${routes === 1 ? 'route' : 'routes'}`
                  : 'no LayerZero OApp',
                // CCIP pools, Wormhole NTT managers, canonical rollup bridges
                bridge.ccip.length
                  ? `${bridge.ccip.length} other ${bridge.ccip.length === 1 ? 'bridge' : 'bridges'}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')
        }
      >
        Bridge
      </BlockTitle>
      {bridge.oapps.map((o) => (
        <OAppTable key={o.address} o={o} rules={rules} />
      ))}
      {bridge.dvns.length > 0 && (
        <Box
          mt={SPACING.md}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          color={SEMANTIC_COLORS.textSecondary}
        >
          <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
            DVN signer sets ·{' '}
          </Text>
          {bridge.dvns.map((d, i) => (
            <React.Fragment key={d.address}>
              {i > 0 && ' · '}
              <ExtLink href={d.url} title={d.address}>
                {d.name}
              </ExtLink>{' '}
              {d.quorum ?? '?'}-of-{d.signers ?? '?'}
            </React.Fragment>
          ))}
        </Box>
      )}
      {bridge.ccip.length > 0 && (
        <Box mt={SPACING.md}>
          {bridge.ccip.map((c) => (
            <ItemLine key={c.key} i={c} rules={rules} />
          ))}
        </Box>
      )}
    </Box>
  )
}

export default ConfigBridge
