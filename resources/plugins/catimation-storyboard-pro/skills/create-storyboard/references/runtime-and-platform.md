# Runtime And Platform

## 零运行时依赖(重要)

本 skill **不依赖 Python,也不依赖任何外部脚本或特定语言运行时**。制片包的目录树与所有文件都由 agent 用自带的文件读写工具,按 `assets/production_package_spec.md` 确定性创建。因此:

- 用户**没装 Python 也完全不影响**:agent 直接用文件工具把 `storyboard_projects/<slug>/` 整棵树和每个 `.md` 建好即可。
- 不要因为"没有运行时/没装 Python"就跳过搭骨架或降级交付。骨架创建是确定性的文件操作,与运行时无关(harness-agnostic)。
- 唯一真正需要外部能力的是**图像/视频/音频生成与本地剪辑**——那部分依赖 app 内的生成工具或用户本机软件,需在目标机器上单独验证;它们不在确定性骨架路径内。

## 确定性搭骨架步骤(无脚本)

1. 读 `assets/production_package_spec.md` 取目录树、命名规则、必填文件职责。
2. 用文件工具创建 `storyboard_projects/<project-slug>/` 下的全部目录(`01_script_brief/` … `final_image_package/`)。
3. 按规范逐个创建文件,以 `assets/storyboard_template.md` 作可填模板,以 `assets/img2_seedance_prompt_template.md` 作提示词结构。
4. 按 `references/storyboard_workflow.md` 的连续性/剪辑规则填充内容。

## Agent Runtime

骨架创建是确定性的,不需要 AI 模型即可完成文件结构;但**真实制片**需要一个有能力的 agent:理解剧本、设计连续性、建圣经、拆 shot cards、设计镜头接力与剪辑边界、写双语提示词,并在素材存在时审查生成的图像/视频。

Recommended production profile:

- Codex-style agent mode,具备本地文件读写与命令执行能力。
- 任务含参考图、角色表、关键帧、分镜板或需审查生成视频/图像时,用多模态模型。
- 长片、多场景连续性或高价值制片用强推理模型(如 GPT-5.5 或同级),复杂连续性与密集 handoff/edit 矩阵时尽量用更高推理档。
- 足够上下文,能同时检视项目简报、圣经、shot cards、参考矩阵、生成图像与剪辑备注。

## Platform Notes

确定性骨架是纯文件操作,跨平台一致(macOS / Linux / WSL2 / Windows 均可),无需任何命令行运行时。

图像生成、视频生成、音频工具与本地剪辑应用不在确定性骨架路径内,需在目标机器上单独验证。
