# 景别代码 / Plan Types

分镜表 Plan 列用的景别分类。可见徽章文字和 `data-plan` 属性(筛选 JS 用)都用同一
套英文代码。

## 映射

| 代码 | 全称 | 徽章类名 | 用于 |
|---|---|---|---|
| `WS` | Wide shot | `p-ws` | 建立镜、全身、以环境为主 |
| `MS` | Medium shot | `p-ms` | 腰部以上、对白、双人镜 |
| `CU` | Close-up | `p-cu` | 头肩、反应 |
| `ECU` | Extreme close-up | `p-ecu` | 眼、手、道具、屏幕的大特写 |
| `MACRO` | Macro | `p-macro` | 毛孔、水珠、织物纹理 |
| `PAN` | Pan | `p-pan` | 缓慢横摇 / 纵摇 |
| `OS` | Off-screen sound | `p-os` | 音频提示,画面无变化 |
| `VO` | Voice-over | `p-vo` | 叠在前一画面上的旁白 |
| `VO+MS` | VO · medium shot | `p-vo` | 中景上的旁白 |
| `DISSOLVE` | Dissolve | `p-dis` | 场间转场 |

## 用法

表格行用代码填 `data-plan`,徽章类名给颜色,徽章文字显示全称:

```html
<tr data-scene="21" data-plan="ECU">
  <td class="c-num">21.4</td>
  <td class="c-plan"><span class="badge p-ecu">Extreme close-up</span></td>
  ...
</tr>
```

筛选下拉框用代码作 `<option value>`,全称作可见文字:

```html
<option value="ECU">Extreme close-up</option>
```

## 要不要自创新代码

不要。镜头对不上就挑最接近的现有代码。这套分类**有意做粗**——细分留给 Camera 列
(`Push-in`、`Slow pan`、`Handheld dolly` 等),不进 Plan 列。

## Camera 列的写法

自由英文。常见项:

- `Static`
- `Handheld`
- `Wide / static`
- `Push-in`
- `Pull-out`
- `Dolly L→R` / `Dolly R→L`
- `Slow pan`
- `Crane up` / `Crane down`
- `Top-shot freeze`
- `One-er, 50mm`
- `Handheld, from inside`
- 转场类(如 dissolve)写 `—`
