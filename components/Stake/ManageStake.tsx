import { Tab, TabIndicator, TabList, TabPanel, TabPanels, Tabs, Box } from '@chakra-ui/react'
import Staking from './Staking'
import ClaimAndRestake from './ClaimAndRestake'
import Unstaking from './Unstaking'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'

const ManageStake = () => {
  return (
    <Box
      w="full"
      p={{ base: SPACING.base, md: SPACING.xl }}
      display="flex"
      flexDirection="column"
      alignItems="center"
      gap={SPACING.lg}
      h="full"
      justifyContent="space-between"
      bg={SEMANTIC_COLORS.bgSecondary}
      borderRadius={0}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
    >
      <Tabs position="relative" variant="unstyled" w="full" isFitted>
        <TabList mb={SPACING.base}>
          <Tab
            _selected={{ color: SEMANTIC_COLORS.primary, fontWeight: TYPOGRAPHY.bold }}
            _focus={FOCUS_STYLES.ring}
            color={SEMANTIC_COLORS.textSecondary}
            fontSize={{ base: TYPOGRAPHY.small, md: TYPOGRAPHY.h4 }}
            transition={TRANSITIONS.colors}
            py={{ base: SPACING.xs, md: SPACING.sm }}
          >
            Manage
          </Tab>
          <Tab
            _selected={{ color: SEMANTIC_COLORS.primary, fontWeight: TYPOGRAPHY.bold }}
            _focus={FOCUS_STYLES.ring}
            color={SEMANTIC_COLORS.textSecondary}
            fontSize={{ base: TYPOGRAPHY.small, md: TYPOGRAPHY.h4 }}
            transition={TRANSITIONS.colors}
            py={{ base: SPACING.xs, md: SPACING.sm }}
          >
            Claim
          </Tab>
          <Tab
            _selected={{ color: SEMANTIC_COLORS.primary, fontWeight: TYPOGRAPHY.bold }}
            _focus={FOCUS_STYLES.ring}
            color={SEMANTIC_COLORS.textSecondary}
            fontSize={{ base: TYPOGRAPHY.small, md: TYPOGRAPHY.h4 }}
            transition={TRANSITIONS.colors}
            py={{ base: SPACING.xs, md: SPACING.sm }}
          >
            Unstaking
          </Tab>
        </TabList>
        <TabIndicator mt="-1.5px" height="2px" bg={SEMANTIC_COLORS.primary} borderRadius={0} />
        <TabPanels>
          <TabPanel px={0}>
            <Staking />
          </TabPanel>
          <TabPanel px={0}>
            <ClaimAndRestake />
          </TabPanel>
          <TabPanel px={0}>
            <Unstaking />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Box>
  )
}

export default ManageStake
