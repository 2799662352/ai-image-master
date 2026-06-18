// Headless diagnostic: parse x_bot.fbx vs y_bot.fbx and compare skeleton binding
// + bind/rest local rotations, to explain why posing shatters the blue (y) bot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Stub browser-only globals FBXLoader may touch for embedded textures ──
globalThis.self = globalThis;
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob://stub';
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
globalThis.document = globalThis.document || {
  createElementNS: () => ({ getContext: () => null, style: {} }),
  createElement: () => ({ getContext: () => null, style: {}, setAttribute() {} }),
};

const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

// Silence texture loading (embedded videos) — we only care about skeleton.
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture(); };
if (THREE.ImageLoader) THREE.ImageLoader.prototype.load = function () { return {}; };

const here = path.dirname(fileURLToPath(import.meta.url));
const rigDir = path.join(here, '..', 'src', 'renderer', 'src', 'components', 'shared', 'image-editors', 'director', 'rig');

function analyze(file) {
  const buf = fs.readFileSync(path.join(rigDir, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new FBXLoader();
  let obj;
  try {
    obj = loader.parse(ab, rigDir + path.sep);
  } catch (e) {
    return { file, error: String(e && e.message || e) };
  }
  const skinned = [];
  const bones = [];
  obj.traverse((o) => {
    if (o.isSkinnedMesh) skinned.push(o);
    if (o.isBone) bones.push(o);
  });
  // unique bone objects
  const boneByName = new Map();
  for (const b of bones) {
    if (!boneByName.has(b.name)) boneByName.set(b.name, b);
  }
  // skeleton binding sanity per skinned mesh
  const meshReport = skinned.map((sm) => {
    const geo = sm.geometry;
    const skinIndex = geo.getAttribute('skinIndex');
    let maxIdx = -1;
    if (skinIndex) {
      for (let i = 0; i < skinIndex.array.length; i++) maxIdx = Math.max(maxIdx, skinIndex.array[i]);
    }
    const skelBones = sm.skeleton ? sm.skeleton.bones.length : 0;
    // Are all skeleton bones actually descendants reachable / non-null?
    const nullBones = sm.skeleton ? sm.skeleton.bones.filter((b) => !b).length : 0;
    // bind matrix identity?
    const bm = sm.bindMatrix ? sm.bindMatrix.elements : null;
    const bindIsIdentity = bm
      ? bm.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6)
      : null;
    return {
      name: sm.name,
      skelBones,
      maxSkinIndex: maxIdx,
      indexOutOfRange: maxIdx >= skelBones,
      nullBones,
      bindIsIdentity,
      bindMode: sm.bindMode,
    };
  });
  // key bone rest local quats
  const keyBones = ['mixamorigHips', 'mixamorigSpine', 'mixamorigLeftArm', 'mixamorigRightUpLeg', 'mixamorigLeftLeg'];
  const restQuats = {};
  for (const kb of keyBones) {
    const b = boneByName.get(kb);
    if (b) restQuats[kb] = [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w].map((n) => +n.toFixed(4));
  }
  return {
    file,
    skinnedMeshes: skinned.length,
    totalBones: bones.length,
    uniqueBones: boneByName.size,
    meshReport,
    restQuats,
  };
}

const rx = analyze('x_bot.fbx');
const ry = analyze('y_bot.fbx');
console.log('=== X BOT (red) ===');
console.log(JSON.stringify(rx, null, 2));
console.log('=== Y BOT (blue) ===');
console.log(JSON.stringify(ry, null, 2));

// Diff rest quats
if (rx.restQuats && ry.restQuats) {
  console.log('=== REST QUAT DIFF (x vs y) ===');
  for (const k of Object.keys(rx.restQuats)) {
    const a = rx.restQuats[k];
    const b = ry.restQuats[k];
    const same = a && b && a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
    console.log(k, 'x=', JSON.stringify(a), 'y=', JSON.stringify(b), same ? 'SAME' : '*** DIFF ***');
  }
}
