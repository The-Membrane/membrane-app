import {
  Button,
  FormControl,
  FormErrorMessage,
  FormLabel,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Stack,
  Text,
  useDisclosure,
} from '@chakra-ui/react'
import { useForm } from 'react-hook-form'

type Props = {}

export const TextField = ({ register, errors, name }: any) => {
  return (
    <FormControl isInvalid={!!errors?.[name]}>
      <FormLabel htmlFor={name} textTransform="capitalize">
        {name}
      </FormLabel>
      <Input
        id={name}
        placeholder={name}
        textAlign="left"
        {...register(name, {
          required: 'This is required',
          minLength: { value: 4, message: 'Minimum length should be 4' },
        })}
      />
      <FormErrorMessage>{errors?.[name] && errors?.[name]?.message}</FormErrorMessage>
    </FormControl>
  )
}

const BecomeDelegate = (props: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()

  const {
    handleSubmit,
    register,
    formState: { errors, isSubmitting, isValid },
    reset,
  } = useForm({
    defaultValues: {
      title: '',
      description: '',
      link: '',
      msgs: {},
    },
  })

  const onSubmit = (values: unknown) => {
    return new Promise((resolve) => {
      setTimeout(() => {
        alert(JSON.stringify(values, null, 2))
        resolve(true)
      }, 3000)
    })
  }

  const onModalClose = () => {
    reset()
    onClose()
  }

  return (
    <>
      <Button onClick={onOpen} w="fit-content" size="sm" fontSize="sm" px="5">
        Become a delegate
      </Button>

      <Modal isOpen={isOpen} onClose={onModalClose} size="xl" closeOnOverlayClick={false}>
        <ModalOverlay />
        <ModalContent>
          <form onSubmit={handleSubmit(onSubmit)} noValidate>
            <ModalHeader>
              <Text variant="title">Submit Proposal</Text>
            </ModalHeader>

            <ModalCloseButton />

            <ModalBody>
              <Stack gap="5">
                <TextField register={register} errors={errors} name="name" />
                <TextField register={register} errors={errors} name="address" />
                <TextField register={register} errors={errors} name="twiter" />
                <TextField register={register} errors={errors} name="discord" />
              </Stack>
            </ModalBody>

            <ModalFooter>
              <Button
                type="submit"
                w="fit-content"
                fontSize="sm"
                px="10"
                isDisabled={isSubmitting || !isValid}
                isLoading={isSubmitting}
              >
                Submit
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
    </>
  )
}

export default BecomeDelegate
