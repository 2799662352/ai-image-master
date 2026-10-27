import Select, { type GroupBase, type SingleValue } from 'react-select'
import { useModelStore } from '../../stores'
import { groupModelsByVendor } from '../../services/api/modelVendors'
import { darkSelectStyles } from '../../styles/selectTheme'

interface ModelOption {
  value: string
  label: string
  isNew?: boolean
}

type ModelGroup = GroupBase<ModelOption>

const selectStyles = darkSelectStyles<ModelOption>()

/**
 * 顶栏模型选择器 —— 按厂商聚合(Seedream / 腾讯 / Google / 阿里 / OpenAI / Flux 各一组,
 * 组头带该厂商的模型数),组内顺序沿用 getAllModels() 的展示顺序。分组逻辑在
 * groupModelsByVendor 里,这里只负责把它喂给 react-select 的 grouped options。
 */
export function ModelSelector() {
  const { currentModelKey, models, switchModel } = useModelStore()

  const groups: ModelGroup[] = groupModelsByVendor(models).map((group) => ({
    label: `${group.meta.name} · ${group.models.length}`,
    options: group.models.map(({ key, model }) => ({ value: key, label: model.name })),
  }))

  const selected =
    groups.flatMap((g) => g.options).find((o) => o.value === currentModelKey) ?? null

  const handleChange = (opt: SingleValue<ModelOption>) => {
    if (opt) switchModel(opt.value)
  }

  return (
    <div className="w-56">
      <Select<ModelOption, false, ModelGroup>
        value={selected}
        onChange={handleChange}
        options={groups}
        styles={selectStyles}
        placeholder="Select model..."
        isSearchable
        menuPlacement="auto"
      />
    </div>
  )
}
