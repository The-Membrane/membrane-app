import { Card, CardFooter, CardHeader, Stack, Text } from '@chakra-ui/react'
import { ConnectButton } from '../WallectConnect'

const LockedAccess = () => {
  return (
    <Stack w="420px" h="full" >
      <Card boxShadow={"0 0 25px rgba(90, 90, 90, 0.5)"} >
        <CardHeader>
          <Text variant="title" fontSize="24px">
            Access Pending
          </Text>
          <Text color="white" fontSize="xs" fontWeight="normal">
            Connect your wallet to access.
          </Text>
        </CardHeader>
        <CardFooter>
          <ConnectButton />
        </CardFooter>
      </Card>
    </Stack>
  )
}

export default LockedAccess
