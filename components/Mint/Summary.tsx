import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import { AssetWithBalance } from './hooks/useCombinBalance'
import useMintState from './hooks/useMintState'

type SummaryItemProps = Partial<AssetWithBalance> & {
  label: string
  amount?: string | number
  showBadge?: boolean
  badge?: string
  logo?: string
}

const SummaryItem = ({ label, amount = 0, badge, showBadge = true, logo }: SummaryItemProps) => (
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
        <Image src={logo} w="20px" h="20px" />
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

export const Summary = () => {
  const { mintState } = useMintState()
  const { summary } = mintState
  const cdt = useAssetBySymbol('CDT')

  if (!mintState.isTakeAction) return null

  return (
    <Stack h="max-content" overflow="auto" w="full">
      {summary?.map((asset) => {
        const badge = num(asset.amount).isGreaterThan(0) ? 'Deposit' : 'Withdraw'
        return (
          <SummaryItem
            key={asset?.label}
            label={asset?.label}
            amount={asset?.amount}
            logo={asset?.logo}
            badge={badge}
          />
        )
      })}

      {num(mintState.mint).isGreaterThan(0) && (
        <SummaryItem
          label="CDT"
          badge="Mint"
          amount={mintState.mint?.toFixed(2)}
          logo={cdt?.logo}
        />
      )}

      {num(mintState.repay).isGreaterThan(0) && (
        <SummaryItem
          badge="Repay"
          label="CDT"
          amount={mintState.repay?.toFixed(2)}
          logo={cdt?.logo}
        />
      )}
    </Stack>
  )
}
