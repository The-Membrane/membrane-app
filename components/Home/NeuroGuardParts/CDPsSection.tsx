import { memo } from "react"
import { Stack, Text, HStack } from "@chakra-ui/react"
import { colors } from "@/config/defaults"
import { MemoizedVaultEntry } from "./VaultEntry"

// Extracted CDPsSection component
// Hoisted out of NeuroGuardCard's body so it keeps a stable component identity
// across parent renders. A component defined inside another component is a brand-new
// function type on every render, which forces React to unmount + remount its whole
// subtree (losing state, refocusing, replaying animations). Everything it needs is
// already threaded via props; it otherwise closes over module-scope values only.
interface CDPsSectionProps {
  positions: any[]
  cdtMarketPrice: string
}

export const CDPsSection = memo(function CDPsSection({ positions, cdtMarketPrice }: CDPsSectionProps) {
  return (
    <Stack>
      <Text marginTop="3%" width="35%" variant="title" textTransform={"capitalize"} fontFamily="var(--font-inter)" fontSize="xl" letterSpacing="1px" display="flex" color={colors.earnText}>
        Your CDPs
      </Text>
      <HStack gap="9%" p={4}>
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
          TVL
        </Text>
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
          Debt
        </Text>
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
          Health
        </Text>
        <Text width="25%" justifyContent="left" variant="title" textAlign="center" color={colors.noState} fontSize="md" letterSpacing="1px" display="flex">
          Actions
        </Text>
      </HStack>
      {positions.map((cdpInfo) =>
        cdpInfo ? (
          <MemoizedVaultEntry
            key={cdpInfo.positionNumber}
            cdp={cdpInfo.position}
            positionNumber={cdpInfo.positionNumber}
            cdtMarketPrice={cdtMarketPrice}
          />
        ) : null
      )}
    </Stack>
  );
});

export default CDPsSection
