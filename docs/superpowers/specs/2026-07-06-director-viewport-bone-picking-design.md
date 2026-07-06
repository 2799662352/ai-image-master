# 导演台:视口骨骼点选(K 动画/摆姿直选骨骼)设计

日期:2026-07-06 · 状态:已拍板(用户选 C 混合方案 + IK 下期 + 右栏全联动)

## 背景

摆姿/K 动画目前只能通过右栏「骨骼列表」按钮或分组滑杆间接选骨。用户希望
像 Blender/姿势编辑器那样直接在 3D 视口点选骨骼调整。

调研结论(three.js r184 文档 + 官方论坛/GitHub 实践):

- **皮肤权重反查**(gkjohnson 标准做法):raycast 命中 SkinnedMesh 后,取命中
  三角形三顶点的 `skinIndex`/`skinWeight` 做重心插值,总权重最高的骨骼即
  「点到的部位」。r151+ 的 `SkinnedMesh.getVertexPosition` 使 CPU raycast 已
  考虑蒙皮形变,摆过姿势的假人也能点准。
- **关节手柄**(CCDIKHelper/Blender 式):每个真实骨骼关节位置放小球
  (InstancedMesh),hover 高亮,点选精确。适合手指等权重难点中的小骨。
- IK 拖拽(CCDIKSolver 整链解算)列为下一期。

## 方案(C 混合)

1. **点身体选骨**:骨骼点选模式开启时(姿势 Tab 或 K 动画时间轴打开),左键
   点击当前选中的高级假人身体 → 权重反查 → 折叠嵌套孪生(沿用
   `hasSameNamedBoneAncestor` 语义)→ gizmo 旋转挂该骨骼。再点同部位在权重
   前列的骨骼间轮换(点胸口可在上/下脊柱间切换)。点其他模型 = 正常换选;
   点空白 = 先退回整体模型,再点才取消选择。
2. **关节手柄**:「显示骨架」开启时,叠加 ~52 个真实骨骼的关节小球
   (单个 InstancedMesh,depthTest 关闭,renderOrder 置顶)。hover 变色 +
   canvas title 显示骨名;点击直接选该骨。每帧同步关节世界位置。
3. **右栏全联动**:视口选骨 → 自动切到姿势 Tab、`activeBone` 高亮骨骼列表、
   展开该骨所在滑杆分组并滚动到卡片;gizmo 旋转骨骼时实时把
   base⁻¹·current 的 XYZ 欧拉角(度)回写对应滑杆(双向同步)。

## 接口

- 场景 handle 新增 `setBonePick(on: boolean)`。
- 场景 props 新增:
  - `onBonePick?: (pick: { uuid: string; name: string } | null) => void`
  - `onBoneRotate?: (boneName: string, deltaDeg: [number, number, number]) => void`
- 纯函数模块 `directorBonePick.ts`(可单测):
  - `accumulateBoneWeights(skinIndexAttr, skinWeightAttr, faceIdxs, bary)` →
    Map<boneIndex, weight>
  - `rankBoneIndices(weights)` → 按权重降序的骨骼索引数组

## 追加:IK 拖拽(同日拍板,提前到本期)

用户改主意:IK 这期做。拍板:直接拖末端小球触发(无 FK/IK 模式切换,单击
仍是选骨,4px 阈值区分);肘/膝铰链约束留下一轮。

调研补充:官方 `CCDIKSolver` 要求 IK target 是**同一副 skeleton 里的骨骼**
(iks 按 `skeleton.bones` 下标寻址),且对 Mixamo 带预旋转骨架约束失效
(three.js#29682、官方论坛均确认,社区绕法是重建"只有位置"的影子骨架)。
THREE.IK(FABRIK)2018 起未维护且铰链约束天然困难。结论:**自写轻量 CCD**
(`directorIk.ts` 纯函数,可单测)——我们全是二连杆短链,plain CCD 数轮收敛。

- 四条链:肩→肘(末端=手)、胯→膝(末端=脚)×左右,按 normBone 名解析,
  只用主骨(嵌套孪生已折叠)。
- `solveCcd(chain, effector, targetWorld, {iterations, tolerance})`:每轮从链尾
  到链根把「骨→末端」旋向「骨→目标」,世界增量经 `P⁻¹·Q·P` 折算到父空间
  premultiply;只改 quaternion 不动 position,末端骨自身不旋转。
- 交互:末端小球(玫红 `#fb7185` 区分,hover cursor=grab)按下即禁 orbit;
  拖动时目标点约束在「过末端、面向相机」的平面上,每 move 解算 8 轮 +
  `updateSkeletons` + 对链骨逐一 `emitBoneDelta` 回写滑杆;松手
  `commitPoseHistory`(一次拖拽 = 一步撤销);未达 4px = 单击,选中末端骨。
- 动画播放中开始拖拽 → 先 `stopAnimFor` 恢复姿势快照再解算。

## 追加:关节小球按骨长分级(同日)

用户反馈手指圆点太大。半径改为按「到父骨世界距离」比例分配:
`clamp(骨长×0.22, 身高×0.0035, 身高×0.013)`,手指骨极短自动落到最小档,
躯干/四肢保持大号;`JointHandles.radius` → `radii[]`。

## 不做(顺延下一期)

- 肘/膝铰链约束与关节角度限制;pole target(肘/膝朝向控制);
  普通假人/导入模型的点选(仅高级假人);GPU picking。
