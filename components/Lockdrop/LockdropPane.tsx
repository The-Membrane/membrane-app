import { useUserInfo } from '@/components/Lockdrop/hooks/useLockdrop'
import { TxButton } from '@/components/TxButton'
import {
  Card,
  Center,
  Input,
  Spinner,
  Table,
  TableCaption,
  TableContainer,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
} from '@chakra-ui/react'
import { Controller, useForm } from 'react-hook-form'
import useClaim from './hooks/useClaim'

type Props = {}

const InputField = ({ name, control }: any) => {
  return (
    <Controller
      name={name}
      control={control}
      rules={{ required: true }}
      render={({ field }) => <Input {...field} type="number" placeholder="0.00" />}
    />
  )
}

type Lockup = {
  deposit: string
  lockUpDuration: string
  isNew: boolean
}

const LockItem = ({ deposit, lockUpDuration, isNew }: Lockup) => {
  const {
    handleSubmit,
    control,
    formState: { errors, isDirty, isValid, defaultValues },
  } = useForm<Lockup>({
    defaultValues: {
      deposit: String(deposit),
      lockUpDuration: String(lockUpDuration),
    },
  })
  const claim = useClaim()

  return (
    <Tr>
      <Td>
        <InputField name="deposit" control={control} />
      </Td>
      <Td>
        <InputField name="lockUpDuration" control={control} />
      </Td>
      <Td>
        <TxButton
          isDisabled={!isDirty || !isValid}
          borderRadius="md"
          py="3"
          w="full"
          minW="120px"
          size="lg"
          isLoading={claim.isPending}
          onClick={() => claim.mutate()}
        >
          {isDirty && !isNew ? 'Update' : 'Lock'}
        </TxButton>
      </Td>
    </Tr>
  )
}

const LoackdropPane = (props: Props) => {
  const { data: userInfo, isLoading } = useUserInfo()

  return (
    <Card>
      <Text variant="title" fontSize="24px">
        Lock your OSMO
      </Text>

      {isLoading ? (
        <Center verticalAlign="center" w="full" h="200px">
          <Spinner color="primary.500" size="xl" />
        </Center>
      ) : (
        <TableContainer>
          <Table variant="simple">
            <TableCaption>OSMO Deposits / MBRN Reward Locks</TableCaption>
            <Thead>
              <Tr>
                <Th>Amount</Th>
                <Th>Duration</Th>
                <Th></Th>
              </Tr>
            </Thead>
            <Tbody>
              {userInfo?.lockups?.map((lockup, i) => <LockItem key={'lock' + i} {...lockup} />)}
            </Tbody>
          </Table>
        </TableContainer>
      )}
    </Card>
  )
}

export default LoackdropPane
