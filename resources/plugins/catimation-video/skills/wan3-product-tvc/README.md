# productwan3.0

`productwan3.0` 是一个普通、可安装的 Codex Skill，用于生成 Wan3.0 可直接粘贴的 30 秒产品 TVC 中文成品提示词。

It helps turn product references or pure text briefs into complete Wan3.0-ready 30-second product commercial prompts with product continuity locks, TVC cinematography, one readable creative twist, synchronized sound, and strict negative constraints.

## 能做什么

- 生成完整 30 秒、16:9、4K、24fps 的 Wan3.0 产品 TVC 成品提示词。
- 支持产品参考图、纯文生视频、影棚实拍、纯 CG、户外生活方式和家居置景。
- 支持 ARRI Alexa 电影写实、反转创意、零 Logo 模式和批量多版本。
- 把产品几何、比例、材料、颜色、部件、数量、朝向、液位、开合状态和干湿状态写成硬锁。
- 把“好看广告词”变成可执行的镜头时间轴、置景、光线、动作、声音和负面约束。

## 安装

克隆到个人 Codex Skills 目录：

```bash
git clone https://github.com/petezbuilds/productwan3.0.git ~/.codex/skills/productwan3.0
```

或者复制整个目录：

```bash
cp -R productwan3.0 ~/.codex/skills/productwan3.0
```

重新打开 Codex 后，可用 `$productwan3.0` 调用。

## 调用示例

```text
$productwan3.0 根据这张护肤品参考图，写一条30秒、16:9、4K、24fps、影棚实拍、零Logo的 Wan3.0 产品TVC成品提示词，结尾有反转。
```

```text
$productwan3.0 纯文生视频，生成三条无标啤酒TVC，每条30秒，产品是透明杯里的金色啤酒和泡沫，多版本必须是不同戏剧机制，不只是换形容词。
```

```text
$productwan3.0 优化这条 Wan3.0 产品提示词，保留家居置景和演员动作，只修复产品颜色漂移、Logo误生成和最后5秒落版不稳定。
```

## 文件结构

- `SKILL.md`：Skill 主工作流和交付规则
- `references/prompt-architecture.md`：30 秒产品 TVC 提示词架构
- `references/product-locks.md`：产品、人物与零 Logo 硬锁
- `references/creative-mechanisms.md`：产品反转机制与场景策略
- `references/qa-scorecard.md`：质量检查与评分
- `examples/sample-prompts.md`：原创示例方向
- `scripts/lint_prompt.py`：无额外依赖的提示词轻量检查
- `agents/openai.yaml`：Codex 展示信息

## 快速检查

```bash
python3 scripts/lint_prompt.py examples/sample-prompts.md
```

脚本会检查 30 秒时间码、16:9、4K、24fps、产品连续性锁、零 Logo 覆盖、产品英雄镜头等基础门槛。它不是创意评分器，只负责发现明显的发布级结构缺口。

## License

MIT

