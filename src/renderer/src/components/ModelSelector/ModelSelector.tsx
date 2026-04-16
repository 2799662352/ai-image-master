import Select, { type SingleValue, type StylesConfig } from 'react-select'
import { useModelStore } from '../../stores'

interface ModelOption {
  value: string
  label: string
  isNew?: boolean
}

const selectStyles: StylesConfig<ModelOption, false> = {
  control: (base) => ({
    ...base,
    backgroundColor: '#1a1a2e',
    borderColor: 'rgba(252, 227, 0, 0.3)',
    minHeight: 36,
    '&:hover': { borderColor: '#FCE300' },
  }),
  singleValue: (base) => ({ ...base, color: '#FCE300' }),
  menu: (base) => ({ ...base, backgroundColor: '#1a1a2e', border: '1px solid rgba(252, 227, 0, 0.3)' }),
  option: (base, state) => ({
    ...base,
    backgroundColor: state.isFocused ? 'rgba(252, 227, 0, 0.1)' : 'transparent',
    color: state.isSelected ? '#FCE300' : '#e5e7eb',
    '&:active': { backgroundColor: 'rgba(252, 227, 0, 0.2)' },
  }),
  input: (base) => ({ ...base, color: '#e5e7eb' }),
  placeholder: (base) => ({ ...base, color: '#6b7280' }),
}

export function ModelSelector() {
  const { currentModelKey, models, switchModel } = useModelStore()

  const options: ModelOption[] = Object.entries(models).map(([key, info]) => ({
    value: key,
    label: info.name,
  }))

  const selected = options.find((o) => o.value === currentModelKey) ?? null

  const handleChange = (opt: SingleValue<ModelOption>) => {
    if (opt) switchModel(opt.value)
  }

  return (
    <div className="w-56">
      <Select<ModelOption>
        value={selected}
        onChange={handleChange}
        options={options}
        styles={selectStyles}
        placeholder="Select model..."
        isSearchable
        menuPlacement="auto"
      />
    </div>
  )
}
