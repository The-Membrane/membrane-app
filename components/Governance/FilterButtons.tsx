import React, { Dispatch, SetStateAction } from 'react'
import { Box, HStack, UseRadioProps, useRadio, useRadioGroup } from '@chakra-ui/react'
import { Filter } from './ProposalsTable'

export type FilterButtonsProps = {
  setFilter: Dispatch<SetStateAction<Filter>>
}

type CardProps = UseRadioProps & {
  isFirst: boolean
  isLast: boolean
  children: React.ReactNode
}

const RadioCard = (props: CardProps) => {
  const { getInputProps, getRadioProps } = useRadio(props)

  const input = getInputProps()
  const checkbox = getRadioProps()
  const { isFirst, isLast } = props

  return (
    <Box as="label">
      <input {...input} />
      <Box
        {...checkbox}
        cursor="pointer"
        borderLeftRadius={isFirst ? 'md' : 'none'}
        borderRightRadius={isLast ? 'md' : 'none'}
        borderRight={isLast ? 'none' : '1px'}
        borderColor="whiteAlpha.200"
        boxShadow="md"
        bg="whiteAlpha.300"
        color="whiteAlpha.700"
        _checked={{
          bg: 'primary.200',
          color: 'white',
        }}
        px={3}
        py={1}
        textTransform="capitalize"
        fontSize="xs"
      >
        {props.children}
      </Box>
    </Box>
  )
}

export const FilterButtons = ({ setFilter }: FilterButtonsProps) => {
  const options = ['active', 'pending', 'completed', 'executed']

  const { getRootProps, getRadioProps } = useRadioGroup({
    name: 'filter',
    defaultValue: 'active',
    onChange: (value) => setFilter({ status: value }),
  })

  const group = getRootProps()
  return (
    <HStack {...group} gap="0">
      {options.map((value) => {
        const radio = getRadioProps({ value })
        const isFirst = value === options[0]
        const isLast = value === options[options.length - 1]
        return (
          <RadioCard key={value} {...radio} isFirst={isFirst} isLast={isLast}>
            {value}
          </RadioCard>
        )
      })}
    </HStack>
  )
}
