/**
 * 普通假人 (crowd / 路人) builder — a faithful port of RunningHub's `ed()` → `od()`
 * procedural mannequin and `addCrowdMannequinLayout()`. See docs §11.
 *
 * The figure is an articulated, blocky humanoid (pelvis pivot, capsule torso,
 * sphere head with eyes/nose/mouth, box limbs). The crowd variant is built with
 * `showControlBlock: false` (no waist ring / chest plate / shoulder caps / hands
 * / feet) and the neutral pose (all joint angles = 0).
 *
 * Three layouts match the toolbar popover:
 *   - single  → one figure
 *   - array   → grid of `count` figures over `columns`, spacing X/Z
 *   - random  → `count` figures scattered in a disc of `radius`
 * Figure colors cycle through CROWD_COLORS.
 */
import * as THREE from 'three';

/** 6-color passer-by palette (exact order from the live app). */
export const CROWD_COLORS = [
  '#4f7a9d',
  '#8c6a46',
  '#8a5f75',
  '#5c7a52',
  '#6f7d95',
  '#7a7252',
] as const;

export type CrowdLayout = 'single' | 'array' | 'random';

export interface CrowdOpts {
  layout: CrowdLayout;
  /** array & random: number of figures. */
  count?: number;
  /** array: columns per row. */
  columns?: number;
  /** array: horizontal (X) spacing. */
  spacingX?: number;
  /** array: depth (Z) spacing. */
  spacingZ?: number;
  /** random: scatter disc radius. */
  radius?: number;
}

/** Defaults mirrored from the live popover. */
export const CROWD_DEFAULTS = {
  array: { count: 8, columns: 4, spacingX: 1.35, spacingZ: 1.6 },
  random: { count: 10, radius: 4.2 },
} as const;

/** "balanced" body style (Xs.balanced). */
const STYLE = {
  torsoRadius: 0.24,
  torsoLength: 0.82,
  chestWidth: 0.48,
  hipWidth: 0.48,
  limbWidth: 0.12,
};

/** Neutral pose — every joint angle is 0 (Ys.neutral). */
interface Joints {
  pelvisHeight: number;
  pelvisPitch: number;
  torsoPitch: number;
  headPitch: number;
  leftArmLift: number;
  leftArmBend: number;
  rightArmLift: number;
  rightArmBend: number;
  leftLegStep: number;
  leftHipPitch: number;
  leftKneeBend: number;
  rightLegStep: number;
  rightHipPitch: number;
  rightKneeBend: number;
}
const NEUTRAL: Joints = {
  pelvisHeight: 0,
  pelvisPitch: 0,
  torsoPitch: 0,
  headPitch: 0,
  leftArmLift: 0,
  leftArmBend: 0,
  rightArmLift: 0,
  rightArmBend: 0,
  leftLegStep: 0,
  leftKneeBend: 0,
  leftHipPitch: 0,
  rightLegStep: 0,
  rightHipPitch: 0,
  rightKneeBend: 0,
};

/** Blend `color` toward `mix` by `amt` → "#rrggbb" (port of `td`). */
function blend(color: string, mix: string, amt: number): string {
  const c = new THREE.Color(color);
  c.lerp(new THREE.Color(mix), amt);
  return `#${c.getHexString()}`;
}

const round10 = (v: number): number => Math.round(10 * v) / 10;

/** A limb segment: a box hung from its top within a pivotable group (port of `id`). */
function limbSegment(
  mat: THREE.Material,
  w: number,
  h: number,
  d: number,
  yShift = 0,
  xShift = 0,
): THREE.Group {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.x = xShift;
  mesh.position.y = -h / 2 + yShift;
  g.add(mesh);
  return g;
}

/**
 * Build one articulated mannequin (port of `od`). `showControlBlock` adds the
 * decorative waist/chest/shoulder/hand/foot pieces; the crowd figure omits them.
 */
function buildMannequin(color: string, showControlBlock: boolean): THREE.Group {
  const j = NEUTRAL;
  const f = THREE.MathUtils.degToRad;
  const r = showControlBlock;

  const mk = (c: string): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.04 });
  const body = mk(color);
  const accent = mk(blend(color, '#ffffff', 0.74));
  const trim = mk(blend(color, '#ffffff', 0.44));
  const limb = mk(blend(color, '#223142', 0.34));
  const detail = mk(blend(color, '#101924', 0.5));
  const soft = mk(blend(color, '#ffffff', 0.22));

  const m = STYLE;
  const x = m.chestWidth / 2 + m.limbWidth / 2 - 0.01;
  const baseY = 0.96; // neutral pose is not a lying pose
  const torsoY = 0.14;
  const hipY = -0.1;

  const root = new THREE.Group();
  root.name = 'crowd-mannequin';

  const pelvisPivot = new THREE.Group();
  pelvisPivot.name = 'pelvisPivot';
  pelvisPivot.position.y = baseY + j.pelvisHeight;
  pelvisPivot.rotation.x = f(j.pelvisPitch);
  root.add(pelvisPivot);

  pelvisPivot.add(new THREE.Mesh(new THREE.BoxGeometry(m.hipWidth, 0.28, 0.26), body));
  const belt = new THREE.Mesh(new THREE.BoxGeometry(m.hipWidth + 0.06, 0.08, 0.3), detail);
  belt.position.y = 0.07;
  pelvisPivot.add(belt);
  if (r) {
    const waist = new THREE.Mesh(
      new THREE.CylinderGeometry(0.82 * m.torsoRadius, m.torsoRadius, 0.12, 12),
      trim,
    );
    waist.position.y = 0.14;
    pelvisPivot.add(waist);
  }

  const torsoPivot = new THREE.Group();
  torsoPivot.name = 'torsoPivot';
  torsoPivot.position.y = torsoY;
  torsoPivot.rotation.x = f(j.torsoPitch);
  pelvisPivot.add(torsoPivot);

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(m.torsoRadius, m.torsoLength, 4, 8),
    body,
  );
  torso.position.y = 0.42;
  torsoPivot.add(torso);

  const chestBand = new THREE.Mesh(new THREE.BoxGeometry(0.92 * m.chestWidth, 0.08, 0.26), soft);
  chestBand.position.set(0, 0.55, 0.03);
  torsoPivot.add(chestBand);

  const spinePlate = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.46, 0.04), detail);
  spinePlate.position.set(0, 0.42, -0.14);
  torsoPivot.add(spinePlate);

  if (r) {
    const chest = new THREE.Mesh(new THREE.BoxGeometry(m.chestWidth, 0.34, 0.24), trim);
    chest.position.set(0, 0.52, 0.02);
    torsoPivot.add(chest);
  }

  const neck = new THREE.Group();
  neck.name = 'neck';
  neck.position.y = 0.96;
  torsoPivot.add(neck);

  const headPivot = new THREE.Group();
  headPivot.name = 'headPivot';
  headPivot.position.y = 0.24;
  headPivot.rotation.x = f(j.headPitch);
  neck.add(headPivot);

  headPivot.add(new THREE.Mesh(new THREE.SphereGeometry(0.19, 18, 14), accent));
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 8), detail);
  eyeL.position.set(-0.062, 0.03, 0.172);
  eyeL.scale.set(1, 0.82, 0.58);
  headPivot.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 8), detail);
  eyeR.position.set(0.062, 0.03, 0.172);
  eyeR.scale.set(1, 0.82, 0.58);
  headPivot.add(eyeR);
  const nose = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.04, 4, 6), trim);
  nose.position.set(0, -0.025, 0.182);
  nose.rotation.x = f(-6);
  headPivot.add(nose);
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.018, 0.022), detail);
  mouth.position.set(0, -0.085, 0.176);
  headPivot.add(mouth);

  // Arms
  const addArm = (side: -1 | 1, lift: number, bend: number, tag: string): void => {
    const shoulder = new THREE.Group();
    shoulder.name = `${tag}Shoulder`;
    shoulder.position.set(side * x, 0.72, 0);
    shoulder.rotation.x = f(-lift);
    shoulder.rotation.z = f(side * 8);
    torsoPivot.add(shoulder);
    if (r) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), trim);
      cap.position.y = 0.02;
      shoulder.add(cap);
    }
    shoulder.add(limbSegment(limb, m.limbWidth, 0.56, m.limbWidth, -0.02));

    const elbow = new THREE.Group();
    elbow.name = `${tag}Elbow`;
    elbow.position.y = -0.58;
    elbow.rotation.x = f(-bend);
    shoulder.add(elbow);
    elbow.add(limbSegment(r ? accent : limb, m.limbWidth - 0.01, 0.48, m.limbWidth - 0.01, -0.02));

    const wrist = new THREE.Mesh(
      new THREE.BoxGeometry(m.limbWidth + 0.05, 0.06, m.limbWidth + 0.05),
      detail,
    );
    wrist.position.y = -0.42;
    elbow.add(wrist);
    if (r) {
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), trim);
      hand.position.y = -0.47;
      elbow.add(hand);
    }
  };
  addArm(-1, j.leftArmLift, j.leftArmBend, 'left');
  addArm(1, j.rightArmLift, j.rightArmBend, 'right');

  // Legs
  const addLeg = (side: -1 | 1, step: number, hipPitch: number, kneeBend: number, tag: string): void => {
    const hip = new THREE.Group();
    hip.name = `${tag}Hip`;
    hip.position.set(side * 0.16, hipY, 0);
    hip.rotation.x = f(step + hipPitch);
    pelvisPivot.add(hip);
    hip.add(limbSegment(limb, m.limbWidth + 0.04, 0.74, m.limbWidth + 0.04, 0.02));

    const knee = new THREE.Group();
    knee.name = `${tag}Knee`;
    knee.position.y = -0.72;
    knee.rotation.x = f(kneeBend);
    hip.add(knee);
    knee.add(limbSegment(r ? accent : limb, m.limbWidth + 0.03, 0.68, m.limbWidth + 0.03, 0));

    const kneeBand = new THREE.Mesh(new THREE.BoxGeometry(m.limbWidth + 0.11, 0.08, 0.12), trim);
    kneeBand.position.set(0, -0.03, 0.06);
    knee.add(kneeBand);
    if (r) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.28), trim);
      foot.position.set(0, -0.67, 0.06);
      knee.add(foot);
    }
  };
  addLeg(-1, j.leftLegStep, j.leftHipPitch, j.leftKneeBend, 'left');
  addLeg(1, j.rightLegStep, j.rightHipPitch, j.rightKneeBend, 'right');

  return root;
}

/** One crowd figure (showControlBlock=false), colored by `color`. */
export function buildCrowdFigure(color: string): THREE.Group {
  return buildMannequin(color, false);
}

/**
 * Build a crowd layout wrapper Group containing all figures. The wrapper is
 * centered at the origin; the caller grounds it (min.y → 0).
 */
export function buildCrowdLayout(opts: CrowdOpts): THREE.Group {
  const wrapper = new THREE.Group();
  const colors = CROWD_COLORS;

  if (opts.layout === 'random') {
    const count = Math.max(1, opts.count ?? CROWD_DEFAULTS.random.count);
    const radius = opts.radius ?? CROWD_DEFAULTS.random.radius;
    wrapper.name = '路人(随机)';
    for (let i = 0; i < count; i += 1) {
      const ang = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * radius;
      const fig = buildCrowdFigure(colors[i % colors.length]);
      fig.position.set(round10(Math.cos(ang) * rr), 0, round10(Math.sin(ang) * rr));
      fig.rotation.y = Math.random() * Math.PI * 2;
      wrapper.add(fig);
    }
    return wrapper;
  }

  if (opts.layout === 'array') {
    const count = Math.max(1, opts.count ?? CROWD_DEFAULTS.array.count);
    const columns = Math.max(1, opts.columns ?? CROWD_DEFAULTS.array.columns);
    const spacingX = opts.spacingX ?? CROWD_DEFAULTS.array.spacingX;
    const spacingZ = opts.spacingZ ?? CROWD_DEFAULTS.array.spacingZ;
    const rows = Math.ceil(count / columns);
    const offX = (-(columns - 1) * spacingX) / 2;
    const offZ = (-(rows - 1) * spacingZ) / 2;
    wrapper.name = '路人队列';
    for (let i = 0; i < count; i += 1) {
      const row = Math.floor(i / columns);
      const col = i % columns;
      const fig = buildCrowdFigure(colors[i % colors.length]);
      fig.position.set(round10(offX + col * spacingX), 0, round10(offZ + row * spacingZ));
      fig.rotation.y = Math.PI;
      wrapper.add(fig);
    }
    return wrapper;
  }

  // single
  wrapper.name = '普通假人';
  const fig = buildCrowdFigure(colors[0]);
  fig.rotation.y = Math.PI;
  wrapper.add(fig);
  return wrapper;
}
