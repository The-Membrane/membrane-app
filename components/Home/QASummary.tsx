import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, Checkbox, HStack, Image, Stack, Text } from '@chakra-ui/react'
import useQuickActionState from './hooks/useQuickActionState'
import { AssetWithBalance } from '../Mint/hooks/useCombinBalance'
import { useMemo } from 'react'
import { loopMax } from '@/config/defaults'

type SummaryItemProps = Partial<AssetWithBalance> & {
  key: string
  label: string
  amount?: string | number
  badge?: string
  logo?: string
}

const SummaryItem = ({
  key,
  label,
  amount = 0,
  badge,
  logo,
}: SummaryItemProps) => (
  <HStack
    key={label}
    justifyContent="space-between"
    pb="1"
    my="1"
    borderBottom="1px solid"
    borderColor="whiteAlpha.200"
  >
    <HStack>
      <Image src={logo} w="20px" h="20px" />
      <Text variant="value" textTransform="unset">
        {label} {amount} {key} into Auto-Compounding Omni-Pool Vault
      </Text>
    </HStack>
  </HStack>
)

export const QASummary = (logo: any) => {
  const { quickActionState, setQuickActionState } = useQuickActionState()

  return (
    <Stack h="max-content" overflow="auto" w="full">

      <SummaryItem
        key={quickActionState.autoSPdeposit > 0 && quickActionState.autoSPwithdrawal > 0 ? "CDT" : "USDC"}
        label={quickActionState.autoSPdeposit > 0 ? "Deposit" : "Withdraw"}
        amount={quickActionState.autoSPdeposit > 0 ? quickActionState.autoSPdeposit : quickActionState.autoSPwithdrawal}
        logo={logo}
        badge={"EARN"}
      />
    </Stack>    
  )
}
