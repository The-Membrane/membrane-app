import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import { AssetWithBalance } from './hooks/useCombinBalance'
import useQuickActionState from './hooks/useQuickActionState'

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
  </HStack>
)

export const QASummary = () => {
  const { quickActionState } = useQuickActionState()
  const { summary } = quickActionState
  const cdt = useAssetBySymbol('CDT')

  return (
    <Stack h="max-content" overflow="auto" w="full">
      {summary?.map((asset) => {
        const badge = 'Deposit'
        return (
          <SummaryItem
            key={asset?.label + asset?.amount}
            label={asset?.label}
            amount={asset?.amount}
            logo={asset?.logo}
            logos={asset?.logos}
            isLP={asset?.isLP}
            badge={badge}
          />
        )
      })}

      {num(quickActionState.mint).isGreaterThan(0) && (
        <SummaryItem
          label="CDT"
          badge="Mint"
          amount={quickActionState.mint?.toFixed(2)}
          logo={cdt?.logo}
        />
      )}
    </Stack>
  )
}
