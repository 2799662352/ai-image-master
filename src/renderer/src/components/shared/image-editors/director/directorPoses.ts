/**
 * 高级假人姿态预设 — 逆向自实站导演块 Dmnzwia4.js 的
 * `./assets/bot-pose-presets/*.json`(35 个静态姿势,每个 52 根骨骼的本地四元数)。
 *
 * - bot-pose-presets.json: { poseKey: { mixamorigBoneName: [qx,qy,qz,qw] } }
 * - bot-bone-schema.json : 骨骼分组/顺序(供「姿势调节」分组滑杆使用)
 */
import presetsJson from './bot-pose-presets.json';
import schemaJson from './bot-bone-schema.json';

export type BoneQuat = [number, number, number, number];
export type PoseMap = Record<string, BoneQuat>;

// JSON 推断为 number[],而 PoseMap 需要四元数元组;先经 unknown 再断言。
const PRESETS = presetsJson as unknown as Record<string, PoseMap>;

export interface BoneSchemaEntry {
  label: string;
  boneName: string;
  group: string;
}
interface SchemaShape {
  groups: string[];
  bones: BoneSchemaEntry[];
  order: string[];
}
const SCHEMA = schemaJson as SchemaShape;

/** rest / T-pose（实站首项）放在最前,其余按实站顺序。 */
export const POSE_KEYS: string[] = ['默认', ...SCHEMA.order];

export const BONE_GROUPS: string[] = SCHEMA.groups;
export const BONE_SCHEMA: BoneSchemaEntry[] = SCHEMA.bones;

/** 骨骼按分组聚合(保持 schema 顺序)。 */
export const BONES_BY_GROUP: { group: string; bones: BoneSchemaEntry[] }[] =
  BONE_GROUPS.map((group) => ({
    group,
    bones: BONE_SCHEMA.filter((b) => b.group === group),
  }));

/** 取某姿势的骨骼四元数表;「默认」返回 null(=回到 rest)。 */
export function getPose(key: string): PoseMap | null {
  if (key === '默认') return null;
  return PRESETS[key] ?? null;
}
