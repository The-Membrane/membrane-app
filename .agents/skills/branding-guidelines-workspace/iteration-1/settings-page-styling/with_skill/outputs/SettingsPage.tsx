import React, { useState, useCallback, useMemo, memo } from 'react'
import {
  Box,
  VStack,
  HStack,
  Text,
  Switch,
  Select,
  Button,
  FormControl,
  FormLabel,
  Input,
  Divider,
  IconButton,
  Tooltip,
} from '@chakra-ui/react'
import { CopyIcon, CheckIcon, ExternalLinkIcon } from '@chakra-ui/icons'
import { motion } from 'framer-motion'

// Config imports
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import {
  TRANSITIONS,
  HOVER_EFFECTS,
  ACTIVE_EFFECTS,
  FOCUS_STYLES,
  MOTION_VARIANTS,
} from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

// Component imports
import { Card } from '@/components/ui/Card'

// =============================================================================
// Types
// =============================================================================

interface NotificationPreferences {
  transactionAlerts: boolean
  liquidationWarnings: boolean
  epochNotifications: boolean
  priceAlerts: boolean
  governanceUpdates: boolean
}

interface DisplayPreferences {
  theme: 'dark' // Dark mode only - no light mode and never will be
  language: string
  compactMode: boolean
  showUsdValues: boolean
  animationsEnabled: boolean
}

interface WalletSettings {
  connectedAddress: string
  autoConnect: boolean
  defaultSlippage: string
  explorerUrl: string
}

// =============================================================================
// Section Header Component
// =============================================================================

const SectionHeader = memo(({ title, description }: { title: string; description: string }) => (
  <Box mb={SPACING.base}>
    <Text
      fontSize={TYPOGRAPHY.h3}
      fontWeight={TYPOGRAPHY.semibold}
      color={SEMANTIC_COLORS.textPrimary}
      mb={SPACING.xs}
    >
      {title}
    </Text>
    <Text
      fontSize={TYPOGRAPHY.small}
      color={SEMANTIC_COLORS.textSecondary}
    >
      {description}
    </Text>
  </Box>
))

SectionHeader.displayName = 'SectionHeader'

// =============================================================================
// Toggle Row Component
// =============================================================================

const ToggleRow = memo(({
  label,
  description,
  isChecked,
  onChange,
}: {
  label: string
  description?: string
  isChecked: boolean
  onChange: (checked: boolean) => void
}) => (
  <HStack
    justify="space-between"
    align="center"
    py={SPACING.sm}
    px={SPACING.md}
    borderRadius="16px"
    bg="rgba(10, 10, 10, 0.4)"
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    transition={TRANSITIONS.all}
    _hover={{
      borderColor: SEMANTIC_COLORS.borderMedium,
      bg: 'rgba(10, 10, 10, 0.6)',
    }}
  >
    <Box flex={1}>
      <Text
        fontSize={TYPOGRAPHY.body}
        fontWeight={TYPOGRAPHY.medium}
        color={SEMANTIC_COLORS.textPrimary}
      >
        {label}
      </Text>
      {description && (
        <Text
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
          mt={SPACING.xs}
        >
          {description}
        </Text>
      )}
    </Box>
    <Switch
      isChecked={isChecked}
      onChange={(e) => onChange(e.target.checked)}
      colorScheme="purple"
      size="md"
    />
  </HStack>
))

ToggleRow.displayName = 'ToggleRow'

// =============================================================================
// Settings Page Component
// =============================================================================

const SettingsPage: React.FC = () => {
  // ---------------------------------------------------------------------------
  // Notification preferences state
  // ---------------------------------------------------------------------------
  const [notifications, setNotifications] = useState<NotificationPreferences>({
    transactionAlerts: true,
    liquidationWarnings: true,
    epochNotifications: false,
    priceAlerts: false,
    governanceUpdates: true,
  })

  // ---------------------------------------------------------------------------
  // Display preferences state
  // ---------------------------------------------------------------------------
  const [display, setDisplay] = useState<DisplayPreferences>({
    theme: 'dark',
    language: 'en',
    compactMode: false,
    showUsdValues: true,
    animationsEnabled: true,
  })

  // ---------------------------------------------------------------------------
  // Wallet settings state
  // ---------------------------------------------------------------------------
  const [wallet, setWallet] = useState<WalletSettings>({
    connectedAddress: 'osmo1abc...xyz',
    autoConnect: true,
    defaultSlippage: '1.5',
    explorerUrl: 'https://www.mintscan.io/osmosis',
  })

  const [addressCopied, setAddressCopied] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  const updateNotification = useCallback((key: keyof NotificationPreferences, value: boolean) => {
    setNotifications((prev) => ({ ...prev, [key]: value }))
    setHasUnsavedChanges(true)
  }, [])

  const updateDisplay = useCallback((key: keyof DisplayPreferences, value: string | boolean) => {
    setDisplay((prev) => ({ ...prev, [key]: value }))
    setHasUnsavedChanges(true)
  }, [])

  const updateWallet = useCallback((key: keyof WalletSettings, value: string | boolean) => {
    setWallet((prev) => ({ ...prev, [key]: value }))
    setHasUnsavedChanges(true)
  }, [])

  const handleCopyAddress = useCallback(() => {
    navigator.clipboard.writeText(wallet.connectedAddress)
    setAddressCopied(true)
    setTimeout(() => setAddressCopied(false), 2000)
  }, [wallet.connectedAddress])

  const handleSave = useCallback(() => {
    // Persist settings (implement with your state management)
    setHasUnsavedChanges(false)
  }, [])

  const handleReset = useCallback(() => {
    setNotifications({
      transactionAlerts: true,
      liquidationWarnings: true,
      epochNotifications: false,
      priceAlerts: false,
      governanceUpdates: true,
    })
    setDisplay({
      theme: 'dark',
      language: 'en',
      compactMode: false,
      showUsdValues: true,
      animationsEnabled: true,
    })
    setWallet((prev) => ({
      ...prev,
      autoConnect: true,
      defaultSlippage: '1.5',
    }))
    setHasUnsavedChanges(false)
  }, [])

  // Active notification count for summary
  const activeNotificationCount = useMemo(() => {
    return Object.values(notifications).filter(Boolean).length
  }, [notifications])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <Box
      maxW="720px"
      mx="auto"
      px={{ base: SPACING_PATTERNS.pagePadding.base, md: SPACING_PATTERNS.pagePadding.md, lg: SPACING_PATTERNS.pagePadding.lg }}
      py={SPACING.xl}
    >
      {/* Page Title */}
      <motion.div
        variants={MOTION_VARIANTS.fadeInUp}
        initial="hidden"
        animate="visible"
      >
        <VStack align="flex-start" spacing={SPACING.sm} mb={SPACING['2xl']}>
          <Text
            fontSize={TYPOGRAPHY.h1}
            fontWeight={TYPOGRAPHY.bold}
            color={SEMANTIC_COLORS.textPrimary}
          >
            Settings
          </Text>
          <Text
            fontSize={TYPOGRAPHY.body}
            color={SEMANTIC_COLORS.textSecondary}
          >
            Manage your notification preferences, display options, and wallet configuration.
          </Text>
        </VStack>
      </motion.div>

      {/* Sections Container */}
      <motion.div
        variants={MOTION_VARIANTS.staggerContainer}
        initial="hidden"
        animate="visible"
      >
        <VStack spacing={SPACING_PATTERNS.sectionGap} align="stretch">

          {/* ================================================================
              SECTION 1: Notification Preferences
              ================================================================ */}
          <motion.div variants={MOTION_VARIANTS.staggerItem}>
            <Card variant="default">
              <SectionHeader
                title="Notifications"
                description={`${activeNotificationCount} of ${Object.keys(notifications).length} alerts active`}
              />

              <VStack spacing={SPACING.sm} align="stretch">
                <ToggleRow
                  label="Transaction Alerts"
                  description="Get notified when transactions confirm or fail"
                  isChecked={notifications.transactionAlerts}
                  onChange={(val) => updateNotification('transactionAlerts', val)}
                />
                <ToggleRow
                  label="Liquidation Warnings"
                  description="Critical alerts when positions approach liquidation"
                  isChecked={notifications.liquidationWarnings}
                  onChange={(val) => updateNotification('liquidationWarnings', val)}
                />
                <ToggleRow
                  label="Epoch Notifications"
                  description="Alerts at the start of each new epoch"
                  isChecked={notifications.epochNotifications}
                  onChange={(val) => updateNotification('epochNotifications', val)}
                />
                <ToggleRow
                  label="Price Alerts"
                  description="Notifications for significant price movements"
                  isChecked={notifications.priceAlerts}
                  onChange={(val) => updateNotification('priceAlerts', val)}
                />
                <ToggleRow
                  label="Governance Updates"
                  description="Stay informed about new proposals and voting"
                  isChecked={notifications.governanceUpdates}
                  onChange={(val) => updateNotification('governanceUpdates', val)}
                />
              </VStack>
            </Card>
          </motion.div>

          {/* ================================================================
              SECTION 2: Display Preferences
              ================================================================ */}
          <motion.div variants={MOTION_VARIANTS.staggerItem}>
            <Card variant="default">
              <SectionHeader
                title="Display"
                description="Customize how the app looks and feels"
              />

              <VStack spacing={SPACING_PATTERNS.formFieldGap} align="stretch">
                {/* Theme (locked to dark) */}
                <FormControl>
                  <FormLabel
                    fontSize={TYPOGRAPHY.label}
                    fontWeight={TYPOGRAPHY.normal}
                    textTransform="uppercase"
                    letterSpacing="0.1em"
                    color={SEMANTIC_COLORS.textTertiary}
                    mb={SPACING.sm}
                  >
                    Theme
                  </FormLabel>
                  <HStack
                    justify="space-between"
                    align="center"
                    py={SPACING.sm}
                    px={SPACING.md}
                    borderRadius="16px"
                    bg="rgba(10, 10, 10, 0.4)"
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                  >
                    <HStack spacing={SPACING.sm}>
                      <Box
                        w="10px"
                        h="10px"
                        borderRadius="full"
                        bg={SEMANTIC_COLORS.primary}
                        boxShadow="0 0 8px rgba(166, 146, 255, 0.6)"
                      />
                      <Text
                        fontSize={TYPOGRAPHY.body}
                        fontWeight={TYPOGRAPHY.medium}
                        color={SEMANTIC_COLORS.textPrimary}
                      >
                        Dark Mode
                      </Text>
                    </HStack>
                    <Text
                      fontSize={TYPOGRAPHY.xs}
                      color={SEMANTIC_COLORS.textTertiary}
                      fontStyle="italic"
                    >
                      Always on
                    </Text>
                  </HStack>
                </FormControl>

                {/* Language */}
                <FormControl>
                  <FormLabel
                    fontSize={TYPOGRAPHY.label}
                    fontWeight={TYPOGRAPHY.normal}
                    textTransform="uppercase"
                    letterSpacing="0.1em"
                    color={SEMANTIC_COLORS.textTertiary}
                    mb={SPACING.sm}
                  >
                    Language
                  </FormLabel>
                  <Select
                    value={display.language}
                    onChange={(e) => updateDisplay('language', e.target.value)}
                    bg="rgb(12, 5, 15)"
                    border="1px solid"
                    borderColor="rgb(127, 79, 128)"
                    borderRadius="16px"
                    color={SEMANTIC_COLORS.textPrimary}
                    fontSize={TYPOGRAPHY.body}
                    transition={TRANSITIONS.all}
                    _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
                    _focus={FOCUS_STYLES.ring}
                    sx={{
                      option: {
                        bg: 'rgb(22, 24, 39)',
                        color: SEMANTIC_COLORS.textPrimary,
                      },
                    }}
                  >
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="zh">Chinese</option>
                    <option value="ja">Japanese</option>
                    <option value="ko">Korean</option>
                    <option value="ru">Russian</option>
                    <option value="tr">Turkish</option>
                  </Select>
                </FormControl>

                {/* Divider between dropdowns and toggles */}
                <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

                {/* Toggle settings */}
                <ToggleRow
                  label="Compact Mode"
                  description="Reduce padding and spacing for a denser layout"
                  isChecked={display.compactMode}
                  onChange={(val) => updateDisplay('compactMode', val)}
                />
                <ToggleRow
                  label="Show USD Values"
                  description="Display estimated dollar amounts alongside token values"
                  isChecked={display.showUsdValues}
                  onChange={(val) => updateDisplay('showUsdValues', val)}
                />
                <ToggleRow
                  label="Animations"
                  description="Enable motion effects and transitions throughout the app"
                  isChecked={display.animationsEnabled}
                  onChange={(val) => updateDisplay('animationsEnabled', val)}
                />
              </VStack>
            </Card>
          </motion.div>

          {/* ================================================================
              SECTION 3: Wallet Settings
              ================================================================ */}
          <motion.div variants={MOTION_VARIANTS.staggerItem}>
            <Card variant="default">
              <SectionHeader
                title="Wallet"
                description="Manage your connected wallet and transaction defaults"
              />

              <VStack spacing={SPACING_PATTERNS.formFieldGap} align="stretch">
                {/* Connected Address */}
                <FormControl>
                  <FormLabel
                    fontSize={TYPOGRAPHY.label}
                    fontWeight={TYPOGRAPHY.normal}
                    textTransform="uppercase"
                    letterSpacing="0.1em"
                    color={SEMANTIC_COLORS.textTertiary}
                    mb={SPACING.sm}
                  >
                    Connected Address
                  </FormLabel>
                  <HStack
                    py={SPACING.sm}
                    px={SPACING.md}
                    borderRadius="16px"
                    bg="rgba(10, 10, 10, 0.4)"
                    border="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                  >
                    <Box
                      w="8px"
                      h="8px"
                      borderRadius="full"
                      bg={SEMANTIC_COLORS.success}
                      boxShadow="0 0 6px rgba(34, 211, 238, 0.6)"
                      flexShrink={0}
                    />
                    <Text
                      fontSize={TYPOGRAPHY.body}
                      fontFamily="mono"
                      color={SEMANTIC_COLORS.textPrimary}
                      flex={1}
                      isTruncated
                    >
                      {wallet.connectedAddress}
                    </Text>
                    <HStack spacing={SPACING.xs}>
                      <Tooltip
                        label={addressCopied ? 'Copied' : 'Copy address'}
                        placement="top"
                        bg="rgba(10, 10, 10, 0.95)"
                        borderRadius="8px"
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderMedium}
                      >
                        <IconButton
                          aria-label="Copy wallet address"
                          icon={addressCopied ? <CheckIcon /> : <CopyIcon />}
                          size="sm"
                          variant="ghost"
                          color={addressCopied ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textSecondary}
                          transition={TRANSITIONS.all}
                          _hover={HOVER_EFFECTS.brighten}
                          _focus={FOCUS_STYLES.ring}
                          onClick={handleCopyAddress}
                        />
                      </Tooltip>
                      <Tooltip
                        label="View on explorer"
                        placement="top"
                        bg="rgba(10, 10, 10, 0.95)"
                        borderRadius="8px"
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderMedium}
                      >
                        <IconButton
                          aria-label="View address on block explorer"
                          icon={<ExternalLinkIcon />}
                          size="sm"
                          variant="ghost"
                          color={SEMANTIC_COLORS.textSecondary}
                          transition={TRANSITIONS.all}
                          _hover={HOVER_EFFECTS.brighten}
                          _focus={FOCUS_STYLES.ring}
                          as="a"
                          href={`${wallet.explorerUrl}/account/${wallet.connectedAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        />
                      </Tooltip>
                    </HStack>
                  </HStack>
                </FormControl>

                {/* Default Slippage */}
                <FormControl>
                  <FormLabel
                    fontSize={TYPOGRAPHY.label}
                    fontWeight={TYPOGRAPHY.normal}
                    textTransform="uppercase"
                    letterSpacing="0.1em"
                    color={SEMANTIC_COLORS.textTertiary}
                    mb={SPACING.sm}
                  >
                    Default Slippage Tolerance
                  </FormLabel>
                  <HStack spacing={SPACING.sm}>
                    {['0.5', '1.0', '1.5', '3.0'].map((value) => (
                      <Button
                        key={value}
                        size="sm"
                        variant={wallet.defaultSlippage === value ? 'solid' : 'ghost'}
                        colorScheme={wallet.defaultSlippage === value ? 'purple' : undefined}
                        bg={wallet.defaultSlippage === value ? SEMANTIC_COLORS.primary : 'transparent'}
                        color={wallet.defaultSlippage === value ? 'white' : SEMANTIC_COLORS.textSecondary}
                        borderRadius="8px"
                        border="1px solid"
                        borderColor={
                          wallet.defaultSlippage === value
                            ? SEMANTIC_COLORS.primary
                            : SEMANTIC_COLORS.borderMedium
                        }
                        fontFamily="mono"
                        fontSize={TYPOGRAPHY.small}
                        transition={TRANSITIONS.transformAndShadow}
                        _hover={
                          wallet.defaultSlippage === value
                            ? HOVER_EFFECTS.lift
                            : HOVER_EFFECTS.borderHighlight
                        }
                        _active={ACTIVE_EFFECTS.press}
                        _focus={FOCUS_STYLES.ring}
                        onClick={() => updateWallet('defaultSlippage', value)}
                      >
                        {value}%
                      </Button>
                    ))}
                    <Input
                      value={
                        !['0.5', '1.0', '1.5', '3.0'].includes(wallet.defaultSlippage)
                          ? wallet.defaultSlippage
                          : ''
                      }
                      onChange={(e) => updateWallet('defaultSlippage', e.target.value)}
                      placeholder="Custom"
                      size="sm"
                      w="80px"
                      bg="rgb(12, 5, 15)"
                      border="1px solid"
                      borderColor="rgb(127, 79, 128)"
                      borderRadius="16px"
                      color={SEMANTIC_COLORS.textPrimary}
                      fontFamily="mono"
                      fontSize={TYPOGRAPHY.small}
                      textAlign="center"
                      transition={TRANSITIONS.all}
                      _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
                      _focus={FOCUS_STYLES.ring}
                      aria-label="Custom slippage tolerance percentage"
                    />
                  </HStack>
                  {parseFloat(wallet.defaultSlippage) > 3 && (
                    <Text
                      fontSize={TYPOGRAPHY.xs}
                      color={SEMANTIC_COLORS.warning}
                      mt={SPACING.sm}
                    >
                      High slippage tolerance. Transactions may execute at unfavorable prices.
                    </Text>
                  )}
                </FormControl>

                {/* Block Explorer */}
                <FormControl>
                  <FormLabel
                    fontSize={TYPOGRAPHY.label}
                    fontWeight={TYPOGRAPHY.normal}
                    textTransform="uppercase"
                    letterSpacing="0.1em"
                    color={SEMANTIC_COLORS.textTertiary}
                    mb={SPACING.sm}
                  >
                    Block Explorer
                  </FormLabel>
                  <Select
                    value={wallet.explorerUrl}
                    onChange={(e) => updateWallet('explorerUrl', e.target.value)}
                    bg="rgb(12, 5, 15)"
                    border="1px solid"
                    borderColor="rgb(127, 79, 128)"
                    borderRadius="16px"
                    color={SEMANTIC_COLORS.textPrimary}
                    fontSize={TYPOGRAPHY.body}
                    transition={TRANSITIONS.all}
                    _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
                    _focus={FOCUS_STYLES.ring}
                    sx={{
                      option: {
                        bg: 'rgb(22, 24, 39)',
                        color: SEMANTIC_COLORS.textPrimary,
                      },
                    }}
                  >
                    <option value="https://www.mintscan.io/osmosis">Mintscan</option>
                    <option value="https://celatone.osmosis.zone">Celatone</option>
                    <option value="https://ping.pub/osmosis">Ping.pub</option>
                  </Select>
                </FormControl>

                {/* Divider before toggles */}
                <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

                {/* Auto-connect toggle */}
                <ToggleRow
                  label="Auto-Connect Wallet"
                  description="Automatically reconnect your wallet when you return"
                  isChecked={wallet.autoConnect}
                  onChange={(val) => updateWallet('autoConnect', val)}
                />
              </VStack>
            </Card>
          </motion.div>

          {/* ================================================================
              ACTION BUTTONS
              ================================================================ */}
          <motion.div variants={MOTION_VARIANTS.staggerItem}>
            <HStack spacing={SPACING_PATTERNS.buttonGroupGap} justify="flex-end">
              <Button
                variant="ghost"
                color={SEMANTIC_COLORS.textSecondary}
                fontSize={TYPOGRAPHY.body}
                borderRadius="8px"
                transition={TRANSITIONS.transformAndShadow}
                _hover={HOVER_EFFECTS.borderHighlight}
                _active={ACTIVE_EFFECTS.press}
                _focus={FOCUS_STYLES.ring}
                onClick={handleReset}
                isDisabled={!hasUnsavedChanges}
              >
                Reset to Defaults
              </Button>
              <Button
                colorScheme="purple"
                bg={SEMANTIC_COLORS.primary}
                color="white"
                fontSize={TYPOGRAPHY.body}
                fontWeight={TYPOGRAPHY.semibold}
                borderRadius="8px"
                px={SPACING.xl}
                transition={TRANSITIONS.transformAndShadow}
                _hover={{
                  ...HOVER_EFFECTS.lift,
                  boxShadow: '0 0 20px rgba(166, 146, 255, 0.4), 0 4px 12px rgba(0, 0, 0, 0.15)',
                }}
                _active={ACTIVE_EFFECTS.press}
                _focus={FOCUS_STYLES.ring}
                onClick={handleSave}
                isDisabled={!hasUnsavedChanges}
              >
                Save Changes
              </Button>
            </HStack>
          </motion.div>

        </VStack>
      </motion.div>
    </Box>
  )
}

export default memo(SettingsPage)

