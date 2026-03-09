# Character Identity Lock 系统提示词强化

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 强化 `buildCharacterIdentityLock` 函数的输出文本，明确区分"不可变的人设要素"和"可变的演出要素"。

**Architecture:** 修改 `DirectorPipeline.ts` 中 `buildCharacterIdentityLock` 函数的返回字符串，从一句泛泛的"不要漂移"改为具体的 FIXED/FLEXIBLE 规则列表。纯字符串改动，不改逻辑。

**Tech Stack:** TypeScript

---

### Task 1: 强化 buildCharacterIdentityLock 输出

**文件:**
- 修改: `src/renderer/src/services/pipeline/DirectorPipeline.ts` — 行 124-128

**Step 1: 运行现有测试确认基线**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 2: 修改代码**

将行 124-128:

```typescript
  return [
    '## Character Identity Lock',
    ...lines,
    'Identity continuity is mandatory across all panels; do not drift core appearance traits.',
  ].join('\n')
```

替换为:

```typescript
  return [
    '## Character Identity Lock (BINDING)',
    ...lines,
    'FIXED (MUST NOT change across panels): face structure, hairstyle, hair color, outfit design, signature accessories, eye color.',
    'FLEXIBLE (MAY change for dramatic effect): pose, expression, action, lighting on character, camera angle, minor battle damage.',
    'Reference image is the SINGLE SOURCE OF TRUTH for character identity.',
    'Identity continuity is mandatory — viewers must recognize the same character in every panel.',
  ].join('\n')
```

**Step 3: 运行测试确认无回归**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat(director): 强化 Character Identity Lock 系统提示词

从泛泛的'不要漂移'改为具体的 FIXED/FLEXIBLE 规则:
- FIXED: 脸型、发型、发色、服装、配饰、瞳色
- FLEXIBLE: 姿势、表情、动作、光影、镜头角度、战斗损伤
- 参考图为人设唯一真相来源"
```

---

---

### Task 2: 提交 anime-quality-boost skill 文件

**文件:**
- 新增: `skills/director-anime-quality-boost/SKILL.md`（已存在，未提交）

**Step 1: 确认文件存在**

```bash
cat skills/director-anime-quality-boost/SKILL.md | head -5
```
预期: 看到 `name: director-anime-quality-boost`

**Step 2: 提交**

```bash
git add skills/director-anime-quality-boost/SKILL.md
git commit -m "feat(skills): 新增 director-anime-quality-boost skill

当 anime/anime-screencap/theatrical 模板被选中时激活。
通过 JSON 格式指令块强化 cel-shading 质量、去厚涂、色调融合、
角色身份锁定。在 designAndAssemble 阶段自动注入 system prompt。"
```

---

## 验证

```bash
npx vitest run src/renderer/src/services/pipeline/
npm run dev
# → 导演模式 → anime/theatrical 模板 → 生成
# → 控制台 selectSkills 日志中应出现 director-anime-quality-boost
# → prompt 中应包含 FIXED/FLEXIBLE 规则 + JSON 质量强化块
```
