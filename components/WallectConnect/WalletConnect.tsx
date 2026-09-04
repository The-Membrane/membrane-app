import { WalletIcon } from '@/components/Icons'
import { colors } from '@/config/defaults'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { truncate } from '@/helpers/truncate'
import useWallet from '@/hooks/useWallet'
import { Button, HStack, Icon, Stack, Text } from '@chakra-ui/react'
import { useMemo, useState } from 'react'
import { FaSignOutAlt } from 'react-icons/fa'
import AllowancePanel from './AllowancePanel'
import ConnectButton from './ConnectButton'

const hoverStyles = {
  borderRadius: '8px',
  border: `1px solid ${SEMANTIC_COLORS.borderStrong}`,
  color: colors.walletIcon,
}

const WalletConnect = () => {
  const [isHovered, setIsHovered] = useState(false)
  const { isWalletConnected, disconnect, address, connector } = useWallet()

  const shortAddress = useMemo(() => truncate(address), [address])
  const walletLabel = connector?.name ?? 'Connected'

  if (isWalletConnected) {
    return (
      <Stack gap={0}>
        <HStack
          as={Button}
          variant="unstyled"
          _hover={hoverStyles}
          justifyContent={{ base: "center", md: "start" }}
          fontWeight="normal"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onClick={() => disconnect()}
          leftIcon={<Icon as={FaSignOutAlt} boxSize={5} color={isHovered ? colors.walletIcon : SEMANTIC_COLORS.textPrimary} />}
          color={isHovered ? colors.tabBG : SEMANTIC_COLORS.textPrimary}
          py="6"
          pl="2"
          bg="color-mix(in srgb, var(--m-text-primary) 8%, transparent)"
        >
          <Stack gap="-2px" alignItems="flex-start" ml="-6px">
            <Text fontSize="sm">{walletLabel}</Text>
            <Text fontSize="xs" color={colors.noState}>
              {shortAddress}
            </Text>
          </Stack>
        </HStack>
        {/* Hidden while every allowance is zero — costs no space in the common case. */}
        <AllowancePanel />
      </Stack>
    )
  }
  return <ConnectButton />
  // return (
  //   <HStack
  //     as={Button}
  //     variant="unstyled"
  //     _hover={hoverStyles}
  //     justifyContent={{ base: "center", md: "start" }}
  //     fontWeight="normal"
  //     onMouseEnter={() => setIsHovered(true)}
  //     onMouseLeave={() => setIsHovered(false)}
  //     onClick={connect}
  //   >
  //     <WalletIcon color={isHovered ? colors.walletIcon : 'white'} />
  //     <Text fontSize="lg">Wallet</Text>
  //   </HStack>
  // )
}

export default WalletConnect
