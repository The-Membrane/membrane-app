import { FormControl, FormLabel, Input, FormErrorMessage, Textarea } from '@chakra-ui/react'

type FieldProps = {
  register: any
  errors: any
}

export const LinkField = ({ register, errors }: FieldProps) => {
  return (
    <FormControl isInvalid={!!errors?.link}>
      <FormLabel htmlFor="link" color="gray">
        Link
      </FormLabel>
      <Input
        type="url"
        id="link"
        fontSize="md"
        placeholder="link"
        textAlign="left"
        {...register('link', {
          required: 'This is required',
          pattern: {
            value: /^(http|https):\/\/[^ "]+$/,
            message: 'Invalid url',
          },
        })}
      />
      <FormErrorMessage>{errors?.link && errors?.link?.message}</FormErrorMessage>
    </FormControl>
  )
}

export const TitleField = ({ register, errors }: FieldProps) => {
  return (
    <FormControl isInvalid={!!errors?.title}>
      <FormLabel htmlFor="title" color="gray">
        Title
      </FormLabel>
      <Input
        id="title"
        placeholder="title"
        textAlign="left"
        {...register('title', {
          required: 'This is required',
          minLength: { value: 4, message: 'Minimum length should be 4' },
        })}
      />
      <FormErrorMessage>{errors?.title && errors?.title?.message}</FormErrorMessage>
    </FormControl>
  )
}

export const DescriptionField = ({ register, errors }: FieldProps) => {
  return (
    <FormControl isInvalid={!!errors?.description}>
      <FormLabel htmlFor="description" color="gray">
        Description
      </FormLabel>
      <Textarea
        id="description"
        placeholder="description"
        textAlign="left"
        border="1px solid"
        borderColor="#824784"
        borderRadius="16px"
        boxShadow="0px 6px 24px 0px rgba(26, 26, 26, 0.04)"
        color="primary.200"
        background="#0C0410"
        _focusVisible={{
          borderColor: 'primary.200',
        }}
        _hover={{
          borderColor: 'primary.200',
        }}
        {...register('description', {
          required: 'This is required',
          minLength: { value: 4, message: 'Minimum length should be 4' },
        })}
      />

      <FormErrorMessage>{errors?.description && errors?.description?.message}</FormErrorMessage>
    </FormControl>
  )
}
