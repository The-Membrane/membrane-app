import { colors } from '@/config/defaults'
import { fontWeights } from '@/theme/fonts'
import { Select as ChakraSelect, ChakraStylesConfig, OptionProps } from 'chakra-react-select'

const chakraStyles: ChakraStylesConfig = {
  singleValue: (provided, state) => ({
    ...provided,
    border: 'none',
    fontSize: '16px',
    px: 2,
    cursor: 'pointer',
    justifySelf: 'center',
    color: colors.globalBG,
    fontWeight: "500",
  }),
  control: (provided, state) => ({
    ...provided,
    bg: 'transparent',
    border: 'none',
    boxShadow: 'none',
    borderRadius: 16,
    _focus: {
      boxShadow: 'none',
    },
  }),
  container: (provided, state) => ({
    ...provided,
    padding: 1,
    borderRadius: 16,
    bg: colors.globalBG,
    color: '#fff',
  }),
  option: (provided) => ({
    ...provided,
    bg: 'transparent',
    color: '#fff',
    cursor: 'pointer',
    width: 'full',
    _selected: {
      bg: colors.tabBG,
    },
    _hover: {
      bg: colors.tabBG,
    },
  }),
  menuList: (provided, state) => ({
    ...provided,
    padding: 0,
    minW: 'full',
    borderRadius: 16,
    width: 'max-content',
    minWidth: '200px',
    ml: '-50px',
    maxHeight: "200px", // Set max height for dropdown
    overflowY: "auto",  // Enables scrollbar when needed
  })
}

const transparentStyles: ChakraStylesConfig = {
  singleValue: (provided, state) => ({
    ...provided,
    border: 'none',
    fontSize: '16px',
    px: 2,
    cursor: 'pointer',
    justifySelf: 'center',
  }),
  control: (provided, state) => ({
    ...provided,
    bg: 'transparent',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    boxShadow: '0 4px 6px rgba(0, 0, 0, 0.2)',
    borderRadius: 16,
    _hover: {
      borderColor: 'rgba(255, 255, 255, 0.25)',
    },
    _focus: {
      boxShadow: '0 4px 8px rgba(0, 0, 0, 0.3)',
      borderColor: 'rgba(255, 255, 255, 0.3)',
    },
  }),
  container: (provided, state) => ({
    ...provided,
    padding: 1,
    borderRadius: 16,
    bg: 'transparent',
    color: '#fff',
  }),
  option: (provided) => ({
    ...provided,
    bg: 'transparent',
    color: '#fff',
    cursor: 'pointer',
    width: 'full',
    _selected: {
      bg: colors.tabBG,
    },
    _hover: {
      bg: colors.tabBG,
    },
  }),
  menuList: (provided, state) => ({
    ...provided,
    padding: 0,
    minW: 'full',
    borderRadius: 16,
    width: 'max-content',
    minWidth: '200px',
    ml: '-50px',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    boxShadow: '0 8px 16px rgba(0, 0, 0, 0.3)',
    backdropFilter: 'blur(4px)',
    bg: 'rgba(26, 32, 44, 0.9)',
    maxHeight: "100px", // Set max height for dropdown
    overflowY: "auto",  // Enables scrollbar when needed
  })
}

type Props = {
  options: OptionProps<any>[]
  onChange?: (value: any) => void
  value?: any,
  useTransparent?: boolean
}

const Select = ({ options, onChange, value, useTransparent }: Props) => {
  if (!options) return null
  return (
    <ChakraSelect
      isSearchable={false}
      variant="unstyled"
      chakraStyles={useTransparent ? transparentStyles : chakraStyles}
      defaultValue={options?.[0]}
      value={value}
      options={options}
      onChange={onChange}
    />
  )
}

export default Select
