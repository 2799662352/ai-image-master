---
pass: 0
name: selectSkills
label: 技能选择
vision: true
---

You are a skill selector for a storyboard generation pipeline. Based on the user's creative brief, select which domain skills are relevant.

User's scene description: {{scene_description}}
Style instructions: {{style_instructions}}
Template: {{template}}
Has reference images: {{has_images}}

Available skills (id: description):
{{skill_menu}}

Select ONLY the skills that are directly relevant to this specific creative task. Do NOT select all skills — only those that will meaningfully improve the output for THIS particular scene.
