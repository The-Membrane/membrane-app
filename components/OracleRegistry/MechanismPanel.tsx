import React from 'react'
import { Box, Link, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { CardView, ChangeItem } from '@/lib/oracleRegistry/apiTypes'

import { formatParam, onchainContext, type ParamDisplay, paramRows } from './paramFormat'
import {
  etherscanAddress,
  etherscanTx,
  fmtDuration,
  fmtUtc,
  HISTORY_SOURCE_LABEL,
  shortAddr,
  UPDATE_MODEL_LABEL,
  usedByLine,
} from './viewModel'

// The cold tier of a card: how the price is made, who can change it, who reads it, and
// what changed. Opt-in behind the card's "Mechanism" toggle; every address links out.

const Row: React.FC<{ k: string; children: React.ReactNode }> = ({ k, children }) => (
  <Box as="div" py="5px" borderTop="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
    <Text
      as="dt"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="9px"
      letterSpacing="0.16em"
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
    >
      {k}
    </Text>
    <Box
      as="dd"
      m={0}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="11px"
      lineHeight={1.5}
      color={SEMANTIC_COLORS.textSecondary}
      wordBreak="break-word"
    >
      {children}
    </Box>
  </Box>
)

const AddrLink: React.FC<{ address: string; label?: string }> = ({ address, label }) => (
  <Link
    href={etherscanAddress(address)}
    isExternal
    color={SEMANTIC_COLORS.textPrimary}
    textDecoration="underline"
    textDecorationColor={SEMANTIC_COLORS.borderStrong}
    _hover={{ color: SEMANTIC_COLORS.primary }}
    _focusVisible={FOCUS_STYLES.ring}
  >
    {label ?? shortAddr(address)} ↗
  </Link>
)

const isAddr = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

/** A parameter in its unit; the raw value stays on hover and as quiet secondary text. */
const ParamText: React.FC<{ d: ParamDisplay }> = ({ d }) =>
  d.raw == null ? (
    <>{d.text}</>
  ) : (
    <Text as="span" title={`raw value: ${d.raw}`}>
      <Text as="span" color={SEMANTIC_COLORS.textPrimary}>
        {d.text}
      </Text>
      <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
        {' '}
        (raw {d.raw})
      </Text>
    </Text>
  )

const ParamList: React.FC<{ rows: [string, ParamDisplay][] }> = ({ rows }) => (
  <>
    {rows.map(([k, d]) => (
      <Text as="span" display="block" key={k}>
        {k}: <ParamText d={d} />
      </Text>
    ))}
  </>
)

export const MechanismPanel: React.FC<{
  card: CardView
  changes: ChangeItem[]
  id: string
}> = ({ card, changes, id }) => {
  const m = card.mechanism
  const onchain = Object.entries(card.onchain)
  const extras = Object.entries(card.extras)
  const ctx = onchainContext(card)
  return (
    <Box id={id} as="dl" mt={SPACING.sm}>
      <Row k="Source">{m.source}</Row>
      <Row k="Aggregation">{m.aggregation}</Row>
      <Row k="Update">{UPDATE_MODEL_LABEL[m.updateModel]}</Row>
      <Row k="Heartbeat · deviation">
        {m.heartbeatSeconds ? fmtDuration(m.heartbeatSeconds) : 'none on-chain'} ·{' '}
        {m.deviationThresholdBps != null
          ? `${Number((m.deviationThresholdBps / 100).toFixed(2))}%`
          : 'no deviation trigger'}
      </Row>
      {m.twapWindowSeconds != null && <Row k="TWAP window">{fmtDuration(m.twapWindowSeconds)}</Row>}
      {m.cap && (
        <Row k="Cap">
          <ParamList rows={paramRows(m.cap, { priceDecimals: card.decimals })} />
        </Row>
      )}
      {m.discount && (
        <Row k="Discount">
          <ParamList rows={paramRows(m.discount)} />
        </Row>
      )}
      {m.pegAssumption && <Row k="Peg assumed">{m.pegAssumption}</Row>}
      <Row k="Fallback">{m.fallback ?? 'none declared'}</Row>
      {(m.access || m.publicRead) && (
        <Row k="Access">
          {[
            m.access,
            m.publicRead === 'zero_address_only'
              ? 'readable via eth_call from address(0) only'
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Row>
      )}
      {card.basis && (
        <Row k="Basis">
          {card.basis.label}: {card.basis.explanation}
        </Row>
      )}
      <Row k="Consensus role">
        {card.role}
        {card.countedInConsensus ? ' (counted in this median)' : ''} · {card.consensusNote}
      </Row>
      {m.components.length > 0 && (
        <Row k="Components">
          {m.components.map((c) => (
            <Text as="span" display="block" key={`${c.role}-${c.address}`}>
              {c.label} · <AddrLink address={c.address} />
            </Text>
          ))}
        </Row>
      )}
      {(onchain.length > 0 || extras.length > 0) && (
        <Row k="Read on-chain">
          {[...onchain, ...extras].map(([k, v]) => (
            <Text as="span" display="block" key={k}>
              {k.replace(/^source:/, 'source · ').replace(/^component:/, 'component · ')}:{' '}
              {isAddr(v) ? <AddrLink address={v} /> : <ParamText d={formatParam(k, v, ctx)} />}
            </Text>
          ))}
        </Row>
      )}
      <Row k="Used by">
        {card.usedBy.length
          ? card.usedBy.map((u) => (
              <Text as="span" display="block" key={`${u.protocol}-${u.market}`}>
                {usedByLine(u)}
              </Text>
            ))
          : 'reference feed'}
      </Row>
      {m.governance.length > 0 && (
        <Row k="Who can change it">
          {m.governance.map((g) => (
            <Text as="span" display="block" key={g.param}>
              {g.param}: {g.steeredBy}
              {g.setter ? ` · ${g.setter}` : ''}
              {g.event ? ` · emits ${g.event.replace(/\(.*?\)/g, '')}` : ''}
            </Text>
          ))}
        </Row>
      )}
      <Row k="History">
        {card.history
          ? `${HISTORY_SOURCE_LABEL[card.history.source] ?? card.history.source} · ${card.history.rawPoints.toLocaleString('en-US')} points${card.history.note ? ` · ${card.history.note}` : ''}`
          : HISTORY_SOURCE_LABEL[card.historyPlanned] === HISTORY_SOURCE_LABEL.none_public
            ? 'no public history'
            : 'history not collected'}
      </Row>
      {changes.length > 0 && (
        <Row k="Config changes">
          {changes.map((c) => (
            <Text as="span" display="block" key={c.id}>
              {fmtUtc(c.ts).slice(0, 10)} · {c.title}: {c.detail}
              {c.tx && (
                <>
                  {' '}
                  <Link
                    href={etherscanTx(c.tx)}
                    isExternal
                    color={SEMANTIC_COLORS.textPrimary}
                    _focusVisible={FOCUS_STYLES.ring}
                  >
                    tx ↗
                  </Link>
                </>
              )}
            </Text>
          ))}
        </Row>
      )}
      {card.warnings.length > 0 && <Row k="Read warnings">{card.warnings.join(' · ')}</Row>}
      <Row k="Contract">
        <AddrLink address={card.address} /> · {card.readMethod}
        {card.decimals != null ? ` · ${card.decimals} decimals` : ''}
      </Row>
      <Row k="Docs">
        <Link
          href={card.docsUrl}
          isExternal
          color={SEMANTIC_COLORS.textPrimary}
          textDecoration="underline"
          textDecorationColor={SEMANTIC_COLORS.borderStrong}
          _hover={{ color: SEMANTIC_COLORS.primary }}
          _focusVisible={FOCUS_STYLES.ring}
        >
          {card.docsUrl.replace(/^https?:\/\//, '').slice(0, 48)} ↗
        </Link>
      </Row>
    </Box>
  )
}

export default MechanismPanel
