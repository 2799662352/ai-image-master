import type { StylesConfig } from 'react-select'

export function darkSelectStyles<T>(): StylesConfig<T> {
  return {
    control: (base, state) => ({
      ...base,
      backgroundColor: '#18181b',
      borderColor: state.isFocused ? '#facc15' : '#3f3f46',
      boxShadow: state.isFocused ? '0 0 0 1px #facc15' : 'none',
      '&:hover': { borderColor: state.isFocused ? '#facc15' : '#52525b' },
      minHeight: '38px',
    }),
    menu: (base) => ({
      ...base,
      backgroundColor: '#18181b',
      border: '1px solid #3f3f46',
    }),
    option: (base, { isFocused, isSelected }) => ({
      ...base,
      backgroundColor: isSelected ? '#facc15' : isFocused ? '#27272a' : '#18181b',
      color: isSelected ? '#09090b' : '#fafafa',
      cursor: 'pointer',
    }),
    singleValue: (base) => ({ ...base, color: '#fafafa' }),
    input: (base) => ({ ...base, color: '#fafafa' }),
    placeholder: (base) => ({ ...base, color: '#71717a' }),
  }
}
