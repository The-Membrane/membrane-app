import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, Checkbox, HStack, Image, Stack, Text } from '@chakra-ui/react'
import useQuickActionState from './hooks/useQuickActionState'
import { AssetWithBalance } from '../Mint/hooks/useCombinBalance'
import { useMemo } from 'react'
import { loopMax } from '@/config/defaults'
import useEarnState from '../Earn/hooks/useEarnState'

type SummaryItemProps = Partial<AssetWithBalance> & {
  actionKey: string
  label: string
  amount?: string | number
  badge?: string
  logo?: string
}

const SummaryItem = ({
  actionKey,
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
      <Badge fontSize="10px" colorScheme="green">
        {badge}
      </Badge>
      <Text variant="value" textTransform="unset">
        {label} {amount} {actionKey === "USDC" ? "USDC" : "CDT"} {label === "Withdraw" ? "from" : "into"} {actionKey === "CDT" ? "Auto-Compounding Omni-Pool Vault" : actionKey === "LP" ? "Range Bound LP Vault" : "Manic USDC Vault"}
      </Text>
    </HStack>
  </HStack>
)

export const QASummary = ({ logo }: { logo?: string }) => {
  const { quickActionState } = useQuickActionState()
  const { earnState } = useEarnState()

  const key = ((quickActionState.autoSPdeposit > 0 || quickActionState.autoSPwithdrawal > 0) ? "CDT" : (quickActionState.rangeBoundLPdeposit > 0 || quickActionState.rangeBoundLPwithdrawal > 0)  ? "LP" : "USDC").toString()
  console.log("key", key)
  return (
    <Stack h="max-content" overflow="auto" w="full">

      <SummaryItem
        actionKey={key}
        label={quickActionState.autoSPdeposit > 0 || earnState.deposit > 0 ||  quickActionState.rangeBoundLPdeposit > 0 ? "Deposit" : "Withdraw"}
        amount={quickActionState.autoSPdeposit > 0 ? quickActionState.autoSPdeposit 
          : quickActionState.autoSPwithdrawal > 0 ? quickActionState.autoSPwithdrawal 
          : earnState.deposit > 0 ? earnState.deposit
          : earnState.withdraw > 0 ? earnState.withdraw 
          : quickActionState.rangeBoundLPdeposit > 0 ? quickActionState.rangeBoundLPdeposit
          : quickActionState.rangeBoundLPwithdrawal > 0 ? quickActionState.rangeBoundLPwithdrawal :
          0        
        }
        logo={logo}
        badge={"EARN"}
      />
    </Stack>    
  )
}
