import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  FormControl,
  FormErrorMessage,
  FormLabel,
  HStack,
  Input,
  Link,
  SimpleGrid,
  Text,
  VStack,
} from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import useWallet from '@/hooks/useWallet'
import {
  ALERT_EVENTS,
  consentStatement,
  normalizeChoices,
  normalizeEmailAddress,
  type AlertEvent,
} from '@/lib/alerts/consent'

type Status = {
  consentReady: boolean
  telegramLinkReady: boolean
  emailConfirmationReady: boolean
  ethereumContractsListed: boolean
  onchainEventIngestionReady: boolean
  deliveryEnabled: boolean
  venueObservationBotConfigured: boolean
}

type Saved = {
  exists: boolean
  events?: AlertEvent[]
  requestedChannels?: string[]
  paused?: boolean
  telegramConfirmed?: boolean
  emailConfirmed?: boolean
  deliveryEnabled?: false
}

const EVENT_COPY: Record<AlertEvent, { title: string; detail: string }> = {
  delay_started: {
    title: 'Protection delay started',
    detail:
      'An actual Membrane position enters its onchain delay. The notice will show the observed start, not a simulated countdown.',
  },
  position_kept: {
    title: 'Position Kept',
    detail:
      'An onchain protection outcome is recorded for your position. Modeled simulator results never trigger this.',
  },
  curator_vault_action: {
    title: 'CuratorVault action',
    detail:
      'A verified action occurs in a vault tied to your position. Specific action types will be listed before delivery starts.',
  },
  venue_capacity_change: {
    title: 'Venue capacity change',
    detail:
      'A measured capacity reading changes. This is observation, not a forecast that you will be unable to exit.',
  },
}

export const AlertSettings: React.FC = () => {
  const { address, isWalletConnected, connect, walletClient } = useWallet()
  const [status, setStatus] = useState<Status | null>(null)
  const [events, setEvents] = useState<AlertEvent[]>([])
  const [telegram, setTelegram] = useState(false)
  const [email, setEmail] = useState(false)
  const [emailAddress, setEmailAddress] = useState('')
  const [emailTouched, setEmailTouched] = useState(false)
  const [saved, setSaved] = useState<Saved | null>(null)
  const [telegramLink, setTelegramLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingAction = useRef<'subscribe' | 'pause' | 'inspect' | null>(null)
  const currentAddress = useRef(address)
  currentAddress.current = address
  const [stateAddress, setStateAddress] = useState(address)
  const addressStateIsCurrent = stateAddress === address
  const normalizedEmail = email ? normalizeEmailAddress(emailAddress) : null
  const emailInvalid = email && emailTouched && !normalizedEmail
  const telegramUnavailable = telegram && !status?.telegramLinkReady

  useEffect(() => {
    setStateAddress(address)
    setEvents([])
    setTelegram(false)
    setEmail(false)
    setEmailAddress('')
    setEmailTouched(false)
    setSaved(null)
    setTelegramLink(null)
    setError(null)
    setBusy(false)
  }, [address])

  useEffect(() => {
    let active = true
    fetch('/api/alerts/status')
      .then((r) => r.json())
      .then((value) => {
        if (active) setStatus(value)
      })
      .catch(() => {
        if (active) setStatus(null)
      })
    return () => {
      active = false
    }
  }, [])

  const toggle = (event: AlertEvent) => {
    setEvents((old) =>
      old.includes(event) ? old.filter((value) => value !== event) : [...old, event],
    )
  }

  const signedRequest = useCallback(
    async (action: 'subscribe' | 'pause' | 'inspect') => {
      setError(null)
      setTelegramLink(null)
      if (!isWalletConnected || !address || !walletClient) {
        pendingAction.current = action
        connect()
        return
      }
      if (action === 'subscribe') {
        if (!events.length || (!telegram && !email)) {
          setError('Choose at least one event and a channel before signing.')
          return
        }
        if (telegramUnavailable) {
          setError('Telegram linking is unavailable. Uncheck Telegram to save email intent.')
          return
        }
        if (email && !normalizedEmail) {
          setEmailTouched(true)
          setError('Enter a valid email address before signing.')
          return
        }
      }
      const requestAddress = address
      setBusy(true)
      try {
        const challengeRes = await fetch('/api/alerts/challenge', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address }),
        })
        const challenge = await challengeRes.json()
        if (!challengeRes.ok) throw new Error(challenge.error ?? 'Challenge unavailable')
        const choice = normalizeChoices({
          address,
          action,
          events: action === 'subscribe' ? events : [],
          channels:
            action === 'subscribe'
              ? [
                  ...(telegram ? (['telegram'] as const) : []),
                  ...(email ? (['email'] as const) : []),
                ]
              : [],
          ...(action === 'subscribe' && email ? { emailAddress: normalizedEmail } : {}),
          issuedAt: challenge.issuedAt,
          nonce: challenge.nonce,
        })
        if (!choice) throw new Error('Could not construct alert consent')
        const signature = await walletClient.signMessage({
          account: address,
          message: consentStatement(choice),
        })
        const response = await fetch('/api/alerts/preferences', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...choice, signature }),
        })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error ?? 'Preference unavailable')
        if (currentAddress.current !== requestAddress) return
        setSaved(result.preference)
        setTelegramLink(result.telegramLink ?? null)
        setEmailAddress('')
        setEmailTouched(false)
        if (action === 'inspect' && result.preference?.exists) {
          setEvents(result.preference.events ?? [])
          setTelegram((result.preference.requestedChannels ?? []).includes('telegram'))
          setEmail((result.preference.requestedChannels ?? []).includes('email'))
        }
      } catch (cause) {
        if (currentAddress.current === requestAddress)
          setError(cause instanceof Error ? cause.message : 'Alert request failed')
      } finally {
        if (currentAddress.current === requestAddress) setBusy(false)
      }
    },
    [
      address,
      connect,
      email,
      events,
      isWalletConnected,
      normalizedEmail,
      telegram,
      telegramUnavailable,
      walletClient,
    ],
  )

  useEffect(() => {
    if (!isWalletConnected || !address || !walletClient || !pendingAction.current) return
    const action = pendingAction.current
    pendingAction.current = null
    void signedRequest(action)
  }, [address, isWalletConnected, signedRequest, walletClient])

  return (
    <Box
      maxW="1140px"
      mx="auto"
      px={SPACING.base}
      py={SPACING.xl}
      color={SEMANTIC_COLORS.textPrimary}
    >
      <Text as="h1" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h1}>
        Your alerts
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.body}
        color={SEMANTIC_COLORS.textSecondary}
        mt={SPACING.sm}
        maxW="72ch"
      >
        Choose what you want to hear about. Signing saves your intent; it does not start personal
        delivery yet.
      </Text>
      {!isWalletConnected && (
        <Text mt={SPACING.md} fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.warning}>
          Demo, not yours. Connect a wallet to sign preferences for your own address.
        </Text>
      )}

      <Card variant="default" p={SPACING.lg} mt={SPACING.xl}>
        <Text as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2}>
          What you can choose
        </Text>
        <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING.md} mt={SPACING.lg}>
          {ALERT_EVENTS.map((event) => (
            <Box
              key={event}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              p={SPACING.base}
            >
              <Checkbox
                isChecked={events.includes(event)}
                onChange={() => toggle(event)}
                isDisabled={busy}
                colorScheme="phosphor"
                minH="44px"
              >
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.body}
                  color={SEMANTIC_COLORS.textPrimary}
                >
                  {EVENT_COPY[event].title}
                </Text>
              </Checkbox>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textSecondary}
                mt={SPACING.xs}
              >
                {EVENT_COPY[event].detail}
              </Text>
            </Box>
          ))}
        </SimpleGrid>
      </Card>

      <Card variant="default" p={SPACING.lg} mt={SPACING.lg}>
        <Text as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2}>
          Where to send it
        </Text>
        <VStack align="stretch" spacing={SPACING.md} mt={SPACING.lg}>
          <Checkbox
            isChecked={telegram}
            onChange={(e) => setTelegram(e.target.checked)}
            isDisabled={busy || (!status?.telegramLinkReady && !telegram)}
            colorScheme="phosphor"
            minH="44px"
          >
            <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
              Telegram
            </Text>
          </Checkbox>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
          >
            After signing, open a ten-minute private-chat link to confirm the destination. A Radar
            address watch does not prove you own that wallet. Links remain unavailable until
            Telegram inbound confirmation is operator-verified.
          </Text>
          {telegramUnavailable && (
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.warning}
            >
              Telegram linking is unavailable. Uncheck Telegram to save email intent.
            </Text>
          )}
          <Checkbox
            isChecked={email}
            onChange={(event) => {
              setEmail(event.target.checked)
              setEmailTouched(false)
              if (!event.target.checked) setEmailAddress('')
            }}
            isDisabled={busy}
            colorScheme="phosphor"
            minH="44px"
          >
            <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary}>
              Email
            </Text>
          </Checkbox>
          {email && (
            <FormControl isInvalid={emailInvalid} maxW="32rem">
              <FormLabel htmlFor="alert-email-address" fontFamily={TYPOGRAPHY.fontMono}>
                Email address
              </FormLabel>
              <Input
                id="alert-email-address"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                value={emailAddress}
                onChange={(event) => setEmailAddress(event.target.value)}
                onBlur={() => {
                  setEmailTouched(true)
                  if (normalizedEmail) setEmailAddress(normalizedEmail)
                }}
                isDisabled={busy}
                aria-describedby="alert-email-help"
                aria-invalid={emailInvalid}
              />
              <FormErrorMessage fontFamily={TYPOGRAPHY.fontMono}>
                Enter a valid email address.
              </FormErrorMessage>
            </FormControl>
          )}
          <Text
            id="alert-email-help"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
          >
            Signing stores this address as unconfirmed contact intent. Inbox confirmation is not
            available yet. Saving it does not activate or send email or alerts.
          </Text>
        </VStack>
      </Card>

      <Card variant="default" p={SPACING.lg} mt={SPACING.lg}>
        <Text as="h2" fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h2}>
          Activation gates
        </Text>
        <VStack
          align="stretch"
          spacing={SPACING.sm}
          mt={SPACING.md}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
        >
          <Text color={status?.consentReady ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning}>
            Signed preference storage: {status?.consentReady ? 'ready' : 'unavailable'}
          </Text>
          <Text
            color={
              status?.onchainEventIngestionReady ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning
            }
          >
            Verified Ethereum event source:{' '}
            {status?.onchainEventIngestionReady ? 'ready' : 'not deployed or ingested'}
          </Text>
          <Text color={SEMANTIC_COLORS.warning}>Personal delivery: not active</Text>
          {addressStateIsCurrent && saved?.exists && (
            <Text color={SEMANTIC_COLORS.textPrimary}>
              {saved.paused ? 'Signed intent paused. ' : 'Signed intent saved. '}
              {saved.paused && 'Previous channel choices may be retained. '}
              {!saved.paused &&
                saved.requestedChannels?.includes('telegram') &&
                (saved.telegramConfirmed
                  ? 'Telegram chat confirmed for this consent. '
                  : 'Telegram chat needs confirmation for this consent. ')}
              {!saved.paused &&
                saved.requestedChannels?.includes('email') &&
                'Email contact intent saved, but the address is unconfirmed. No email will be sent. '}
              Personal delivery remains off.
            </Text>
          )}
        </VStack>
        <HStack mt={SPACING.lg} spacing={SPACING.md} flexWrap="wrap">
          <Button
            onClick={() => signedRequest('subscribe')}
            isLoading={busy}
            isDisabled={
              !status?.consentReady ||
              busy ||
              events.length === 0 ||
              (email && !normalizedEmail) ||
              telegramUnavailable ||
              (!telegram && !email)
            }
          >
            {isWalletConnected ? 'Sign alert choices' : 'Connect to set alerts'}
          </Button>
          <Button
            variant="outline"
            onClick={() => signedRequest('inspect')}
            isDisabled={!status?.consentReady || busy || !isWalletConnected}
          >
            Check saved choices
          </Button>
          <Button
            variant="ghost"
            onClick={() => signedRequest('pause')}
            isDisabled={!status?.consentReady || busy || !isWalletConnected}
          >
            Pause my intent
          </Button>
        </HStack>
        {addressStateIsCurrent && telegramLink && (
          <Text mt={SPACING.md} fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small}>
            <Link href={telegramLink} isExternal color={SEMANTIC_COLORS.info}>
              Confirm this Telegram chat
            </Link>{' '}
            within ten minutes. The link works once.
          </Text>
        )}
        {error && (
          <Text
            role="alert"
            mt={SPACING.md}
            fontFamily={TYPOGRAPHY.fontMono}
            color={SEMANTIC_COLORS.danger}
          >
            {error}
          </Text>
        )}
      </Card>
      <Text
        mt={SPACING.lg}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        color={SEMANTIC_COLORS.textSecondary}
      >
        Existing Radar venue alarms are a separate public-address watch. They are not proof of
        ownership and do not enable these personal notices.
      </Text>
    </Box>
  )
}
