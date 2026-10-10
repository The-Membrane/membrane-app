import React, { useState, useCallback, memo } from 'react'
import {
  Box,
  VStack,
  HStack,
  Text,
  Container,
  Switch,
  Select,
  FormControl,
  FormLabel,
  Input,
  Button,
  Divider,
  useToast,
} from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES, MOTION_VARIANTS } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

// ============================================
// Types
// ============================================

interface NotificationPreferences {
  transactionAlerts: boolean
  revenueUpdates: boolean
  liquidationWarnings: boolean
  epochNotifications: boolean
  governanceProposals: boolean
}

interface DisplayPreferences {
  theme: 'dark' | 'light' | 'system'
  language: string
  compactMode: boolean
  showUsdValues: boolean
}

interface WalletSettings {
  autoConnect: boolean
  displayName: string
  slippageTolerance: string
  gasAdjustment: string
}

// ============================================
// Sub-components
// ============================================

/**
 * Section header with title, description, and divider
 */
const SectionHeader = memo(({ title, description }: { title: string; description: string }) => (
  <Box mb={SPACING.base}>
    <Text
      fontSize={TYPOGRAPHY.h2}
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

/**
 * A toggle row with label, description, and switch
 */
const ToggleRow = memo(({
  label,
  description,
  isChecked,
  onChange,
}: {
  label: string
  description: string
  isChecked: boolean
  onChange: (checked: boolean) => void
}) => (
  <HStack
    justify="space-between"
    align="center"
    py={SPACING.md}
    borderBottom="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    _last={{ borderBottom: 'none' }}
  >
    <Box flex={1} pr={SPACING.base}>
      <Text
        fontSize={TYPOGRAPHY.body}
        fontWeight={TYPOGRAPHY.medium}
        color={SEMANTIC_COLORS.textPrimary}
      >
        {label}
      </Text>
      <Text
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
        mt={SPACING.xs}
      >
        {description}
      </Text>
    </Box>
    <Switch
      isChecked={isChecked}
      onChange={(e) => onChange(e.target.checked)}
      colorScheme="purple"
      size="md"
      aria-label={label}
    />
  </HStack>
))
ToggleRow.displayName = 'ToggleRow'

// ============================================
// Main Settings Page
// ============================================

export const SettingsPage: React.FC = () => {
  const toast = useToast()

  // Notification preferences state
  const [notifications, setNotifications] = useState<NotificationPreferences>({
    transactionAlerts: true,
    revenueUpdates: true,
    liquidationWarnings: true,
    epochNotifications: false,
    governanceProposals: false,
  })

  // Display preferences state
  const [display, setDisplay] = useState<DisplayPreferences>({
    theme: 'dark',
    language: 'en',
    compactMode: false,
    showUsdValues: true,
  })

  // Wallet settings state
  const [wallet, setWallet] = useState<WalletSettings>({
    autoConnect: true,
    displayName: '',
    slippageTolerance: '1.0',
    gasAdjustment: '1.3',
  })

  // Handlers
  const handleNotificationChange = useCallback(
    (key: keyof NotificationPreferences) => (checked: boolean) => {
      setNotifications((prev) => ({ ...prev, [key]: checked }))
    },
    []
  )

  const handleDisplayChange = useCallback(
    (key: keyof DisplayPreferences, value: string | boolean) => {
      setDisplay((prev) => ({ ...prev, [key]: value }))
    },
    []
  )

  const handleWalletChange = useCallback(
    (key: keyof WalletSettings, value: string | boolean) => {
      setWallet((prev) => ({ ...prev, [key]: value }))
    },
    []
  )

  const handleSave = useCallback(() => {
    toast({
      title: 'Settings saved',
      description: 'Your preferences have been updated successfully.',
      status: 'success',
      duration: 3000,
      isClosable: true,
    })
  }, [toast])

  const handleReset = useCallback(() => {
    setNotifications({
      transactionAlerts: true,
      revenueUpdates: true,
      liquidationWarnings: true,
      epochNotifications: false,
      governanceProposals: false,
    })
    setDisplay({
      theme: 'dark',
      language: 'en',
      compactMode: false,
      showUsdValues: true,
    })
    setWallet({
      autoConnect: true,
      displayName: '',
      slippageTolerance: '1.0',
      gasAdjustment: '1.3',
    })
    toast({
      title: 'Settings reset',
      description: 'All preferences have been restored to defaults.',
      status: 'info',
      duration: 3000,
      isClosable: true,
    })
  }, [toast])

  return (
    <Container maxW="container.md" py={SPACING.xl}>
      <motion.div
        variants={MOTION_VARIANTS.fadeInUp}
        initial="hidden"
        animate="visible"
      >
        <VStack spacing={SPACING_PATTERNS.sectionGap} align="stretch">
          {/* Page Title */}
          <Box mb={SPACING.sm}>
            <Text
              fontSize={TYPOGRAPHY.h1}
              fontWeight={TYPOGRAPHY.bold}
              color="white"
              fontFamily="mono"
              textTransform="uppercase"
              letterSpacing="wide"
              mb={SPACING.sm}
            >
              Settings
            </Text>
            <Text
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.textSecondary}
              fontFamily="mono"
            >
              Manage your notification, display, and wallet preferences
            </Text>
          </Box>

          {/* ============================================ */}
          {/* Notification Preferences */}
          {/* ============================================ */}
          <Card variant="default">
            <VStack spacing={SPACING.none} align="stretch">
              <SectionHeader
                title="Notifications"
                description="Control which alerts and updates you receive."
              />
              <Divider borderColor={SEMANTIC_COLORS.borderMedium} mb={SPACING.sm} />

              <ToggleRow
                label="Transaction Alerts"
                description="Get notified when your transactions are confirmed or fail."
                isChecked={notifications.transactionAlerts}
                onChange={handleNotificationChange('transactionAlerts')}
              />
              <ToggleRow
                label="Revenue Updates"
                description="Receive periodic updates about your earned revenue."
                isChecked={notifications.revenueUpdates}
                onChange={handleNotificationChange('revenueUpdates')}
              />
              <ToggleRow
                label="Liquidation Warnings"
                description="Critical alerts when your positions approach liquidation thresholds."
                isChecked={notifications.liquidationWarnings}
                onChange={handleNotificationChange('liquidationWarnings')}
              />
              <ToggleRow
                label="Epoch Notifications"
                description="Updates at the start and end of each epoch cycle."
                isChecked={notifications.epochNotifications}
                onChange={handleNotificationChange('epochNotifications')}
              />
              <ToggleRow
                label="Governance Proposals"
                description="Alerts for new governance proposals and voting deadlines."
                isChecked={notifications.governanceProposals}
                onChange={handleNotificationChange('governanceProposals')}
              />
            </VStack>
          </Card>

          {/* ============================================ */}
          {/* Display Preferences */}
          {/* ============================================ */}
          <Card variant="default">
            <VStack spacing={SPACING_PATTERNS.formFieldGap} align="stretch">
              <SectionHeader
                title="Display"
                description="Customize the look and feel of the application."
              />
              <Divider borderColor={SEMANTIC_COLORS.borderMedium} mb={SPACING.sm} />

              {/* Theme Selection */}
              <FormControl>
                <FormLabel
                  fontSize={TYPOGRAPHY.label}
                  fontWeight={TYPOGRAPHY.medium}
                  textTransform="uppercase"
                  letterSpacing="0.1em"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Theme
                </FormLabel>
                <Select
                  value={display.theme}
                  onChange={(e) => handleDisplayChange('theme', e.target.value)}
                  bg={SEMANTIC_COLORS.bgSecondary}
                  borderColor={SEMANTIC_COLORS.borderMedium}
                  color={SEMANTIC_COLORS.textPrimary}
                  transition={TRANSITIONS.all}
                  _focus={FOCUS_STYLES.ring}
                  _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
                  aria-label="Select theme"
                >
                  <option value="dark" style={{ background: '#1a1a2e' }}>Dark</option>
                  <option value="light" style={{ background: '#1a1a2e' }}>Light</option>
                  <option value="system" style={{ background: '#1a1a2e' }}>System</option>
                </Select>
              </FormControl>

              {/* Language Selection */}
              <FormControl>
                <FormLabel
                  fontSize={TYPOGRAPHY.label}
                  fontWeight={TYPOGRAPHY.medium}
                  textTransform="uppercase"
                  letterSpacing="0.1em"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Language
                </FormLabel>
                <Select
                  value={display.language}
                  onChange={(e) => handleDisplayChange('language', e.target.value)}
                  bg={SEMANTIC_COLORS.bgSecondary}
                  borderColor={SEMANTIC_COLORS.borderMedium}
                  color={SEMANTIC_COLORS.textPrimary}
                  transition={TRANSITIONS.all}
                  _focus={FOCUS_STYLES.ring}
                  _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
                  aria-label="Select language"
                >
                  <option value="en" style={{ background: '#1a1a2e' }}>English</option>
                  <option value="es" style={{ background: '#1a1a2e' }}>Spanish</option>
                  <option value="fr" style={{ background: '#1a1a2e' }}>French</option>
                  <option value="de" style={{ background: '#1a1a2e' }}>German</option>
                  <option value="ja" style={{ background: '#1a1a2e' }}>Japanese</option>
                  <option value="ko" style={{ background: '#1a1a2e' }}>Korean</option>
                  <option value="zh" style={{ background: '#1a1a2e' }}>Chinese</option>
                </Select>
              </FormControl>

              <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

              {/* Compact Mode Toggle */}
              <HStack justify="space-between" align="center">
                <Box>
                  <Text
                    fontSize={TYPOGRAPHY.body}
                    fontWeight={TYPOGRAPHY.medium}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    Compact Mode
                  </Text>
                  <Text
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                    mt={SPACING.xs}
                  >
                    Reduce spacing and padding for a denser layout.
                  </Text>
                </Box>
                <Switch
                  isChecked={display.compactMode}
                  onChange={(e) => handleDisplayChange('compactMode', e.target.checked)}
                  colorScheme="purple"
                  size="md"
                  aria-label="Toggle compact mode"
                />
              </HStack>

              {/* Show USD Values Toggle */}
              <HStack justify="space-between" align="center">
                <Box>
                  <Text
                    fontSize={TYPOGRAPHY.body}
                    fontWeight={TYPOGRAPHY.medium}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    Show USD Values
                  </Text>
                  <Text
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                    mt={SPACING.xs}
                  >
                    Display token values in their USD equivalent.
                  </Text>
                </Box>
                <Switch
                  isChecked={display.showUsdValues}
                  onChange={(e) => handleDisplayChange('showUsdValues', e.target.checked)}
                  colorScheme="purple"
                  size="md"
                  aria-label="Toggle USD values display"
                />
              </HStack>
            </VStack>
          </Card>

          {/* ============================================ */}
          {/* Wallet Settings */}
          {/* ============================================ */}
          <Card variant="default">
            <VStack spacing={SPACING_PATTERNS.formFieldGap} align="stretch">
              <SectionHeader
                title="Wallet"
                description="Configure wallet connection and transaction parameters."
              />
              <Divider borderColor={SEMANTIC_COLORS.borderMedium} mb={SPACING.sm} />

              {/* Auto-Connect Toggle */}
              <HStack justify="space-between" align="center">
                <Box>
                  <Text
                    fontSize={TYPOGRAPHY.body}
                    fontWeight={TYPOGRAPHY.medium}
                    color={SEMANTIC_COLORS.textPrimary}
                  >
                    Auto-Connect Wallet
                  </Text>
                  <Text
                    fontSize={TYPOGRAPHY.xs}
                    color={SEMANTIC_COLORS.textTertiary}
                    mt={SPACING.xs}
                  >
                    Automatically reconnect your wallet on page load.
                  </Text>
                </Box>
                <Switch
                  isChecked={wallet.autoConnect}
                  onChange={(e) => handleWalletChange('autoConnect', e.target.checked)}
                  colorScheme="purple"
                  size="md"
                  aria-label="Toggle auto-connect wallet"
                />
              </HStack>

              <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

              {/* Display Name */}
              <FormControl>
                <FormLabel
                  fontSize={TYPOGRAPHY.label}
                  fontWeight={TYPOGRAPHY.medium}
                  textTransform="uppercase"
                  letterSpacing="0.1em"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Display Name
                </FormLabel>
                <Input
                  value={wallet.displayName}
                  onChange={(e) => handleWalletChange('displayName', e.target.value)}
                  placeholder="Enter a display name"
                  bg={SEMANTIC_COLORS.bgSecondary}
                  borderColor={SEMANTIC_COLORS.borderMedium}
                  color={SEMANTIC_COLORS.textPrimary}
                  transition={TRANSITIONS.all}
                  _focus={FOCUS_STYLES.ring}
                  _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
                  _placeholder={{ color: SEMANTIC_COLORS.textTertiary }}
                  aria-label="Wallet display name"
                />
              </FormControl>

              {/* Slippage Tolerance */}
              <FormControl>
                <FormLabel
                  fontSize={TYPOGRAPHY.label}
                  fontWeight={TYPOGRAPHY.medium}
                  textTransform="uppercase"
                  letterSpacing="0.1em"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Slippage Tolerance (%)
                </FormLabel>
                <HStack spacing={SPACING.sm}>
                  {['0.5', '1.0', '2.0'].map((val) => (
                    <Button
                      key={val}
                      size="sm"
                      variant={wallet.slippageTolerance === val ? 'solid' : 'ghost'}
                      colorScheme={wallet.slippageTolerance === val ? 'purple' : undefined}
                      onClick={() => handleWalletChange('slippageTolerance', val)}
                      transition={TRANSITIONS.transformAndShadow}
                      _focus={FOCUS_STYLES.ring}
                      aria-label={`Set slippage to ${val}%`}
                    >
                      {val}%
                    </Button>
                  ))}
                  <Input
                    value={wallet.slippageTolerance}
                    onChange={(e) => handleWalletChange('slippageTolerance', e.target.value)}
                    placeholder="Custom"
                    size="sm"
                    maxW="80px"
                    bg={SEMANTIC_COLORS.bgSecondary}
                    borderColor={SEMANTIC_COLORS.borderMedium}
                    color={SEMANTIC_COLORS.textPrimary}
                    textAlign="center"
                    transition={TRANSITIONS.all}
                    _focus={FOCUS_STYLES.ring}
                    _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
                    aria-label="Custom slippage tolerance"
                  />
                </HStack>
              </FormControl>

              {/* Gas Adjustment */}
              <FormControl>
                <FormLabel
                  fontSize={TYPOGRAPHY.label}
                  fontWeight={TYPOGRAPHY.medium}
                  textTransform="uppercase"
                  letterSpacing="0.1em"
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Gas Adjustment
                </FormLabel>
                <HStack spacing={SPACING.sm}>
                  {['1.2', '1.3', '1.5'].map((val) => (
                    <Button
                      key={val}
                      size="sm"
                      variant={wallet.gasAdjustment === val ? 'solid' : 'ghost'}
                      colorScheme={wallet.gasAdjustment === val ? 'purple' : undefined}
                      onClick={() => handleWalletChange('gasAdjustment', val)}
                      transition={TRANSITIONS.transformAndShadow}
                      _focus={FOCUS_STYLES.ring}
                      aria-label={`Set gas adjustment to ${val}x`}
                    >
                      {val}x
                    </Button>
                  ))}
                  <Input
                    value={wallet.gasAdjustment}
                    onChange={(e) => handleWalletChange('gasAdjustment', e.target.value)}
                    placeholder="Custom"
                    size="sm"
                    maxW="80px"
                    bg={SEMANTIC_COLORS.bgSecondary}
                    borderColor={SEMANTIC_COLORS.borderMedium}
                    color={SEMANTIC_COLORS.textPrimary}
                    textAlign="center"
                    transition={TRANSITIONS.all}
                    _focus={FOCUS_STYLES.ring}
                    _hover={{ borderColor: SEMANTIC_COLORS.borderStrong }}
                    aria-label="Custom gas adjustment"
                  />
                </HStack>
                <Text
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                  mt={SPACING.sm}
                >
                  Higher values reduce the chance of out-of-gas errors but increase fees.
                </Text>
              </FormControl>
            </VStack>
          </Card>

          {/* ============================================ */}
          {/* Action Buttons */}
          {/* ============================================ */}
          <HStack spacing={SPACING_PATTERNS.buttonGroupGap} justify="flex-end">
            <Button
              variant="ghost"
              onClick={handleReset}
              transition={TRANSITIONS.transformAndShadow}
              _focus={FOCUS_STYLES.ring}
              aria-label="Reset all settings to defaults"
            >
              Reset to Defaults
            </Button>
            <Button
              colorScheme="purple"
              onClick={handleSave}
              transition={TRANSITIONS.transformAndShadow}
              _hover={HOVER_EFFECTS.lift}
              _active={ACTIVE_EFFECTS.press}
              _focus={FOCUS_STYLES.ring}
              aria-label="Save settings"
            >
              Save Settings
            </Button>
          </HStack>
        </VStack>
      </motion.div>
    </Container>
  )
}

export default SettingsPage

