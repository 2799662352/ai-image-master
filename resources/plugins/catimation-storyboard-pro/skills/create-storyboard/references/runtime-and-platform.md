# Runtime And Platform

## Agent Runtime

The bundled scaffold script is deterministic. It does not require an AI model once Python is available.

Real storyboard production is different. A capable agent must understand the script, design continuity, create bibles, split scenes into shot cards, design shot handoffs and edit boundaries, write bilingual prompts, and review generated images or video when those assets exist.

Recommended production profile:

- Codex-style agent mode with local file read/write and command execution.
- Multimodal model when the task includes reference images, character sheets, keyframes, storyboard boards, or generated video/image review.
- Frontier reasoning model, such as GPT-5.5 or an equivalent model, for long-form drama, multi-scene continuity, or high-value production work.
- Reasoning effort: `high` for normal production work; `xhigh` when available for complex continuity and dense handoff/edit matrices.
- Enough context to inspect script briefs, bibles, shot cards, reference matrices, generated images, and edit notes together.

Known-good author setup: macOS, Codex-style local agent, GPT-5.5-class reasoning, and `xhigh` reasoning for complex packages.

## Platform Notes

The author validates primarily on macOS. The scaffold script uses only the Python standard library and is cross-platform.

macOS/Linux/WSL2:

```bash
python3 scripts/create_storyboard_package.py demo-storyboard \
  --root outputs \
  --title "Demo Storyboard" \
  --duration "30s" \
  --aspect "16:9"
```

Windows PowerShell:

```powershell
py scripts/create_storyboard_package.py demo-storyboard --root outputs --title "Demo Storyboard" --duration "30s" --aspect "16:9"
```

Use Python 3.10+.

Image generation, video generation, audio tools, and local editing applications are outside the deterministic scaffold path. Validate those tools separately on the target machine.
