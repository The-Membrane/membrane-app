import React, { useEffect, useRef, useState } from 'react'
import { Box, Button, HStack, Input, Select, Text, VStack } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, HOVER_EFFECTS, TRANSITIONS } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow } from '@/components/Evidence/atoms'

import {
  MAX_RULES,
  RECHECK_MS,
  RULE_LIMITS,
  STORAGE_KEY,
  evaluateRules,
  makeRule,
  newlyFired,
  parseStored,
  validRule,
  type AlertInput,
  type AlertKind,
  type AlertRule,
  type Fired,
} from './alertRulesLogic'

// Your own alert rules on this X-ray. Stored only in this browser, checked on each
// read and re-read every 5 minutes while the page is open. Nothing is sent off-site.

const btn = {
  size: 'sm' as const,
  variant: 'outline' as const,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: TYPOGRAPHY.xs,
  minH: '44px',
  transition: TRANSITIONS.colorAndBorder,
  _hover: HOVER_EFFECTS.borderHighlight,
  _active: ACTIVE_EFFECTS.dim,
  _focus: FOCUS_STYLES.ring,
}

// Distance is entered in %, stored as a fraction.
const toStored = (kind: AlertKind, v: number) => (kind === 'distance' ? v / 100 : v)

export const AlertRules: React.FC<{
  address: string | null // null = demo fixture: rules evaluate, nothing re-reads or notifies
  input: AlertInput
  onRecheck: () => void
}> = ({ address, input, onRecheck }) => {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [kind, setKind] = useState<AlertKind>('distance')
  const [value, setValue] = useState('5')
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default')
  const [log, setLog] = useState<Array<Fired & { at: string }>>([])
  const prev = useRef<Set<string>>(new Set())

  useEffect(() => {
    try {
      const s = parseStored(window.localStorage.getItem(STORAGE_KEY))
      setRules(s && address && s.address.toLowerCase() === address.toLowerCase() ? s.rules : [])
    } catch {
      setRules([])
    }
    prev.current = new Set()
    setLog([])
    setPerm(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  }, [address])

  const save = (next: AlertRule[]) => {
    setRules(next)
    if (!address) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ address, rules: next }))
    } catch {
      /* storage blocked: rules live for this visit only */
    }
  }

  const fired = evaluateRules(rules, input)

  useEffect(() => {
    const fresh = newlyFired(prev.current, fired)
    prev.current = new Set(fired.map((f) => f.id))
    if (!address || !fresh.length) return
    const at = new Date().toISOString().slice(11, 16)
    setLog((l) => [...fresh.map((f) => ({ ...f, at })), ...l].slice(0, 10))
    if (perm === 'granted') {
      for (const f of fresh) {
        try {
          new Notification('Membrane X-ray alert', { body: f.text, tag: f.id })
        } catch {
          /* some mobile browsers only notify from a service worker */
        }
      }
    }
    // fired is derived from rules + input; key on its ids
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, fired.map((f) => f.id).join(','), perm])

  useEffect(() => {
    if (!address || !rules.length) return
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') onRecheck()
    }, RECHECK_MS)
    return () => window.clearInterval(t)
  }, [address, rules.length, onRecheck])

  const n = Number(value)
  const candidate = Number.isFinite(n) ? makeRule(kind, toStored(kind, n)) : null
  const canAdd = !!candidate && validRule(candidate) && rules.length < MAX_RULES
  const firedIds = new Set(fired.map((f) => f.id))

  return (
    <VStack align="stretch" spacing={SPACING.sm}>
      <Eyebrow>Your alerts · checked in this browser</Eyebrow>
      <HStack spacing={SPACING.sm} flexWrap="wrap" align="end">
        <Select
          aria-label="Alert type"
          value={kind}
          onChange={(e) => setKind(e.target.value as AlertKind)}
          w={{ base: '100%', md: 'auto' }}
          minH="44px"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          borderRadius={0}
          borderColor={SEMANTIC_COLORS.hairline}
          _focus={FOCUS_STYLES.ring}
        >
          {(Object.keys(RULE_LIMITS) as AlertKind[]).map((k) => (
            <option key={k} value={k}>
              {RULE_LIMITS[k].label}
            </option>
          ))}
        </Select>
        <HStack spacing={SPACING.xs}>
          <Input
            aria-label="Alert threshold"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            w="96px"
            minH="44px"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.hairline}
            transition={TRANSITIONS.colorAndBorder}
            _focus={FOCUS_STYLES.ring}
          />
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textSecondary}
          >
            {kind === 'distance' ? '%' : kind === 'hf' ? 'HF' : 'days'}
          </Text>
        </HStack>
        <Button
          {...btn}
          w={{ base: '100%', md: 'auto' }}
          isDisabled={!canAdd}
          onClick={() => candidate && save([...rules, candidate])}
        >
          Add alert
        </Button>
        {address && perm === 'default' ? (
          <Button {...btn} onClick={() => Notification.requestPermission().then((p) => setPerm(p))}>
            Allow browser notifications
          </Button>
        ) : null}
      </HStack>
      {rules.length ? (
        <VStack align="stretch" spacing={SPACING.none}>
          {rules.map((r) => (
            <HStack
              key={r.id}
              justify="space-between"
              borderTop="1px solid"
              borderColor={SEMANTIC_COLORS.hairline}
              py={SPACING.xs}
            >
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={firedIds.has(r.id) ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textPrimary}
              >
                {firedIds.has(r.id) ? 'FIRING · ' : ''}
                {RULE_LIMITS[r.kind].label}{' '}
                {r.kind === 'distance' ? `${(r.threshold * 100).toFixed(1)}%` : r.threshold}
              </Text>
              <Button
                {...btn}
                variant="ghost"
                w="auto"
                flexShrink={0}
                aria-label={`Remove alert: ${RULE_LIMITS[r.kind].label}`}
                onClick={() => save(rules.filter((x) => x.id !== r.id))}
              >
                Remove
              </Button>
            </HStack>
          ))}
        </VStack>
      ) : null}
      {log.length ? (
        <Box>
          {log.map((l, i) => (
            <Text
              key={i}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.warning}
            >
              {l.at} UTC · {l.text}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
      >
        {address
          ? `Saved in this browser for this address. Re-read every 5 minutes while this tab is open; a rule fires once when it is crossed. Nothing is sent off-site${perm === 'unsupported' ? '; this browser has no notifications' : perm === 'denied' ? '; notifications are blocked in this browser' : ''}.`
          : 'Demo: rules check the example loop. Enter an address or connect to watch a real position.'}
      </Text>
    </VStack>
  )
}

export default AlertRules
