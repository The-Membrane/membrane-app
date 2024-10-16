import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, Checkbox, HStack, Image, Stack, Text } from '@chakra-ui/react'
import useQuickActionState from './hooks/useQuickActionState'
import { AssetWithBalance } from '../Mint/hooks/useCombinBalance'
import { useMemo } from 'react'
import { loopMax } from '@/config/defaults'

type SummaryItemProps = Partial<AssetWithBalance> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
  logos?: string[]
  isLP?: boolean
  newValue?: number
  startingValue?: number
}

const SummaryItem = ({
  label,
  amount = 0,
  badge,
  showBadge = true,
  logo,
  logos,
  isLP,
  newValue,
  startingValue,
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
      <HStack>
        {isLP ? (
          <HStack>
            <Image src={logos?.[0]} w="24px" h="24px" />
            <Image src={logos?.[1]} w="24px" h="24px" ml="-16px" />
          </HStack>
        ) : (
          <Image src={logo} w="24px" h="24px" />
        )}
        <Text variant="value" textTransform="unset">
          {label}
        </Text>
      </HStack>

      {showBadge && (
        <Badge fontSize="10px" colorScheme="green">
          {badge}
        </Badge>
      )}
      {badge === "SWAP" ? <Text variant="value" textTransform="unset">
      to USDC
      </Text> : badge === "LOOP" ? <Text variant="value" textTransform="unset">
       for {num(newValue??0).div(startingValue??0).multipliedBy(100).toFixed(0)}% leverage on {label} at a ${newValue} new position value
      </Text>
      : null}
    </HStack>
    <HStack>
      {badge !== "LOOP" ? <Text>{num(amount).abs().toString()}</Text> : null}
    </HStack>
  </HStack>
)

export const QASummary = ({ newPositionValue, summary } : {newPositionValue: number, summary: any[]}) => {
  const { quickActionState, setQuickActionState } = useQuickActionState()
  const TVL = (quickActionState?.levAssets?.map((asset) => asset.sliderValue??0).reduce((a, b) => a + b, 0)??0)

  return (
    <Stack h="max-content" overflow="auto" w="full">

      {summary.map((asset) => {
        const badge = 'Deposit'
        return (
          <SummaryItem
            key={asset?.label + asset?.amount}
            label={asset?.label}
            amount={asset?.amount}
            logo={asset?.logo}
            isLP={asset?.isLP}
            badge={badge}
          />
        )
      })}

      <SummaryItem
        key={""}
        label={quickActionState?.levAssets?.[0].symbol??""}
        amount={num(quickActionState?.levAssets?.[0].amount).toNumber()}
        logo={quickActionState?.levAssets?.[0].logo}
        isLP={quickActionState?.levAssets?.[0].isLP}
        badge={"LOOP"}
        startingValue={TVL}
        newValue={newPositionValue}
      />
      <Checkbox isChecked={quickActionState.useCookies} paddingBottom={"4%"} borderColor={"#00A3F9"} onChange={() => {setQuickActionState({useCookies: !quickActionState.useCookies})}}> 
        Use cookies to track performance
      </Checkbox >
    </Stack>    
  )
}
