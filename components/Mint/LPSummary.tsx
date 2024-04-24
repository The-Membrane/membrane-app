import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import { AssetWithBalance } from './hooks/useCombinBalance'
import useLPState from './hooks/useLPState'

type SummaryItemProps = Partial<AssetWithBalance> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
  logos?: string[]
  isLP?: boolean
}

const SummaryItem = ({
  label,
  amount = 0,
  badge,
  showBadge = true,
  logo,
  logos,
  isLP,
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
    </HStack>
    <HStack>
      <Text>{num(amount).abs().toString()}</Text>
    </HStack>    
    {label === "SWAP" ? <Text variant="value" textTransform="unset">
        to USDC
    </Text> :  null}
  </HStack>
)

export const LPSummary = () => {
  const { LPState } = useLPState()
  const cdt = useAssetBySymbol('CDT')
  const usdc = useAssetBySymbol('USDC')

  if (LPState.newCDT === 0) return null  

  return (
    <Stack h="max-content" overflow="auto" w="full">

        <SummaryItem
          label="CDT"
          badge="SWAP"
          amount={num(LPState.newCDT).div(2).toNumber().toFixed(0)}
          logo={cdt?.logo}
        />
          
        <SummaryItem
          label="CDT/USDC"
          badge="LP"
          amount={LPState.newCDT.toFixed(0)}
          isLP={true}
          logos={[cdt!.logo, usdc!.logo]}
        />

    </Stack>
  )
}
