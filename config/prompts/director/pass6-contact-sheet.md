---
pass: 5
name: generateImages
label: 图像生成
type: image-prompt
---

{{style_directive_section}}
{{style_anchor_section}}
{{reference_image_role_rules}}

Cinematic Contact Sheet, ONE single master image, {{grid_rows}} rows x {{grid_cols}} columns storyboard grid, {{panel_count}} panels total.

STRICT GRID GEOMETRY RULES:
- The entire image uses {{overall_ratio}} aspect ratio.
- The grid is divided into EXACTLY {{grid_rows}} equal rows and {{grid_cols}} equal columns.
- Every panel MUST be EXACTLY the same size — each panel is {{panel_ratio}} ({{panel_orientation}}).
- {{semantic_orientation_instruction}}
- Panels fill the ENTIRE image edge-to-edge with only thin 1-2px dark dividing lines between them.
- NO margins, NO padding, NO header/footer area outside the grid.
- NO text, NO labels, NO captions, NO annotations, NO panel numbers inside or outside the panels.
- Each panel is a distinct camera shot — NO blending between panels.

{{character_identity_section}}

REFERENCE IMAGE FIDELITY (BINDING):
- Characters MUST look identical to the reference images in EVERY panel.
- DO NOT reinterpret or stylize characters beyond what is shown in the reference.
- Face, hair, outfit, accessories are LOCKED to the reference — no creative deviation.

Panel descriptions:
{{enhanced_panel_descriptions}}
{{semantic_exclusions}}
