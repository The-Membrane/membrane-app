import { num } from '@/helpers/num'
import { Box, Button, Divider, HStack, Image, Text, VStack, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react'
import { useMemo, useState } from 'react'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Card } from '@/components/ui/Card'
import { ResponsiveTableContainer, MobileCard, MobileCardDataItem } from '@/components/ui/ResponsiveTable'
import { useAcquisitionConfig, useCurrentAcquisition } from '@/hooks/useAcquisition'
import { useTransmuterTVL } from '@/hooks/useTransmuterData'
import { AcquisitionProgressBar } from '@/components/acquisition/AcquisitionProgressBar'
import { shiftDigits } from '@/helpers/math'
import { LendModal } from './LendModal'

// Format MBRN amount for display
const formatMbrn = (amount: number) => {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M MBRN`
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(0)}K MBRN`
  return `${amount.toFixed(0)} MBRN`
}

export const AvailableToLend = () => {
  const { chainName } = useChainRoute()
  const usdcAsset = useAssetBySymbol('USDC', chainName)

  // Acquisition data
  const { data: acquisitionConfig } = useAcquisitionConfig()
  const { data: currentWindow } = useCurrentAcquisition()
  const { data: tvlRaw } = useTransmuterTVL()

  // Parse acquisition model data
  const acquisitionModel = useMemo(() => {
    const model = acquisitionConfig?.acquisition_model
    const maxMbrn = model?.max_mbrn_emission
      ? num(model.max_mbrn_emission).div(1e6).toNumber() // Convert from uMBRN to MBRN
      : 0
    const accrualRate = model?.base_acquisition_rate
      ? num(model.base_acquisition_rate).toNumber()
      : 0
    const tvl = tvlRaw ? shiftDigits(tvlRaw, -6).toNumber() : 0

    // Reward rate: MBRN per USDC = maxMbrn / TVL
    const rewardRate = tvl > 0 ? maxMbrn / tvl : 0

    return { maxMbrn, accrualRate, rewardRate, tvl }
  }, [acquisitionConfig, tvlRaw])

  // Active window timeline
  const windowData = useMemo(() => {
    const lockdrop = currentWindow?.lockdrop
    if (!lockdrop) return null
    return {
      startTime: lockdrop.start_time as number | undefined,
      depositEnd: lockdrop.deposit_end as number | undefined,
      withdrawalEnd: lockdrop.withdrawal_end as number | undefined,
    }
  }, [currentWindow])

  const [lendModalOpen, setLendModalOpen] = useState(false)

  const handleLendClick = () => {
    setLendModalOpen(true)
  }

  const rewardRateDisplay = acquisitionModel.rewardRate > 0
    ? `${acquisitionModel.rewardRate.toFixed(2)} MBRN`
    : '-'

  const availableRewardsDisplay = acquisitionModel.maxMbrn > 0
    ? formatMbrn(acquisitionModel.maxMbrn)
    : 'Coming Soon'

  const accrualSubtitle = acquisitionModel.accrualRate > 0
    ? `${acquisitionModel.accrualRate.toFixed(6)} MBRN/sec`
    : undefined

  // Mobile card
  const renderMobileCard = () => {
    const cardData: MobileCardDataItem[] = [
      {
        label: 'Asset',
        value: (
          <HStack spacing={2} justify="flex-end">
            <Image
              src={usdcAsset?.logo || '/images/usdc.svg'}
              alt="USDC"
              w="20px"
              h="20px"
              borderRadius="full"
              fallbackSrc="/images/default-token.svg"
            />
            <Text fontWeight="medium">USDC</Text>
          </HStack>
        ),
      },
      {
        label: 'Reward Rate',
        value: (
          <VStack spacing={0} align="flex-end">
            <Text color={acquisitionModel.rewardRate > 0 ? 'white' : 'whiteAlpha.700'}>
              {rewardRateDisplay}
            </Text>
            <Text color="whiteAlpha.400" fontSize="xs">per 1 USDC</Text>
          </VStack>
        ),
      },
      {
        label: 'Available Rewards',
        value: (
          <Box textAlign="right">
            <Text color={acquisitionModel.maxMbrn > 0 ? 'cyan.400' : 'whiteAlpha.700'}>
              {availableRewardsDisplay}
            </Text>
            {accrualSubtitle && (
              <Text color="whiteAlpha.500" fontSize="xs">{accrualSubtitle}</Text>
            )}
          </Box>
        ),
      },
      {
        label: 'Action',
        value: (
          <Button
            size="xs"
            variant="outline"
            colorScheme="purple"
            onClick={handleLendClick}
            color="purple.300"
            borderColor="purple.400"
            _hover={{ bg: 'purple.500', color: 'white', borderColor: 'purple.500' }}
          >
            + Lend
          </Button>
        ),
      },
    ]

    return <MobileCard key="usdc-lend" data={cardData} />
  }

  return (
  <>
    <Card p={4}>
      <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
        Available to Lend
      </Text>

      <ResponsiveTableContainer
        desktopTable={
          <Table variant="unstyled" size="sm">
            <Thead>
              <Tr>
                <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2}>
                  Asset
                </Th>
                <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2} isNumeric>
                  Reward Rate
                </Th>
                <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2} isNumeric>
                  Available Rewards
                </Th>
                <Th px={2} width="100px"></Th>
              </Tr>
            </Thead>
            <Tbody>
              <Tr _hover={{ bg: 'whiteAlpha.50' }}>
                <Td px={2} py={3}>
                  <HStack spacing={2}>
                    <Image
                      src={usdcAsset?.logo || '/images/usdc.svg'}
                      alt="USDC"
                      w="24px"
                      h="24px"
                      borderRadius="full"
                      fallbackSrc="/images/default-token.svg"
                    />
                    <Text color="white" fontWeight="medium" fontSize="sm">
                      USDC
                    </Text>
                  </HStack>
                </Td>
                <Td px={2} py={3} isNumeric>
                  <Text
                    color={acquisitionModel.rewardRate > 0 ? 'white' : 'whiteAlpha.700'}
                    fontSize="sm"
                  >
                    {rewardRateDisplay}
                  </Text>
                  <Text color="whiteAlpha.400" fontSize="xs">per 1 USDC</Text>
                </Td>
                <Td px={2} py={3} isNumeric>
                  <Text color={acquisitionModel.maxMbrn > 0 ? 'cyan.400' : 'whiteAlpha.700'} fontSize="sm">
                    {availableRewardsDisplay}
                  </Text>
                  {accrualSubtitle && (
                    <Text color="whiteAlpha.500" fontSize="xs">{accrualSubtitle}</Text>
                  )}
                </Td>
                <Td px={2} py={3}>
                  <Button
                    size="xs"
                    variant="outline"
                    colorScheme="purple"
                    onClick={handleLendClick}
                    color="purple.300"
                    borderColor="purple.400"
                    _hover={{ bg: 'purple.500', color: 'white', borderColor: 'purple.500' }}
                  >
                    + Lend
                  </Button>
                </Td>
              </Tr>
            </Tbody>
          </Table>
        }
        mobileCards={<>{renderMobileCard()}</>}
      />

      {/* Acquisition Timeline */}
      {windowData?.startTime && windowData?.depositEnd && windowData?.withdrawalEnd && (
        <Box mt={4}>
          <Divider borderColor="purple.400" borderWidth="1px" mb={2} boxShadow="0 0 8px rgba(167, 139, 250, 0.4)" />
          <AcquisitionProgressBar
            startTime={windowData.startTime}
            depositEnd={windowData.depositEnd}
            withdrawalEnd={windowData.withdrawalEnd}
          />
        </Box>
      )}
    </Card>

    <LendModal
      isOpen={lendModalOpen}
      onClose={() => setLendModalOpen(false)}
    />
  </>
  )
}

export default AvailableToLend
