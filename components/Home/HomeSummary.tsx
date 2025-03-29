import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Badge, HStack, Image, Stack, Text } from '@chakra-ui/react'
import useQuickActionState from './hooks/useQuickActionState'
import { shiftDigits } from '@/helpers/math'

type SummaryItemProps = {
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
    logo
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
                <Image src={logo} w="24px" h="24px" />
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

export const HomeSummary = ({ tokenOutMinAmount }: { tokenOutMinAmount: number }) => {
    const { quickActionState } = useQuickActionState()


    return (
        <Stack h="max-content" overflow="auto" w="full">

            {num(quickActionState.usdcSwapToCDT).isGreaterThan(0) && (
                <>
                    <SummaryItem
                        label="CDT"
                        badge="Deposit"
                        amount={quickActionState.usdcSwapToCDT.toFixed(2)}
                        logo={"/images/cdt.svg"}
                    />
                    <SummaryItem
                        label="USDC"
                        badge="Swap"
                        amount={shiftDigits(tokenOutMinAmount, -6).toFixed(2)}
                        logo={"https://raw.githubusercontent.com/cosmos/chain-registry/master/_non-cosmos/ethereum/images/usdc.svg"}
                    />

                </>
            )}

            {num(quickActionState.rangeBoundLPwithdrawal).isGreaterThan(0) && (
                <SummaryItem
                    label="CDT"
                    badge="Withdraw"
                    amount={quickActionState.rangeBoundLPwithdrawal.toFixed(2)}
                    logo={"/images/cdt.svg"}
                />
            )}
        </Stack>
    )
}
