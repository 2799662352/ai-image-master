import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { readFileSync } from 'node:fs';

function toAB(path) {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function analyze(label, path) {
  const loader = new FBXLoader();
  let root;
  try {
    root = loader.parse(toAB(path), './');
  } catch (e) {
    console.log(`[${label}] parse error:`, e.message);
    return null;
  }
  const bones = [];
  const skins = [];
  root.traverse((o) => {
    if (o.isBone) bones.push(o);
    if (o.isSkinnedMesh) skins.push(o);
  });
  console.log(`\n===== ${label} =====`);
  console.log(`bones=${bones.length}  skinnedMeshes=${skins.length}`);

  // per-skin: skeleton bone count, max skinIndex, bindMode, geometry verts
  skins.forEach((sm, i) => {
    const g = sm.geometry;
    const sk = sm.skeleton;
    const idxAttr = g.getAttribute('skinIndex');
    let maxIdx = -1;
    if (idxAttr) {
      for (let k = 0; k < idxAttr.count * idxAttr.itemSize; k++) {
        const v = idxAttr.array[k];
        if (v > maxIdx) maxIdx = v;
      }
    }
    console.log(
      `  skin[${i}] name=${sm.name} verts=${g.attributes.position.count} ` +
        `skeleton.bones=${sk ? sk.bones.length : 'none'} maxSkinIndex=${maxIdx} ` +
        `bindMode=${sm.bindMode} boneInverses=${sk ? sk.boneInverses.length : 'n/a'}`,
    );
    // does every skinIndex have a corresponding bone?
    if (sk && maxIdx >= sk.bones.length) {
      console.log(
        `    !! OUT-OF-RANGE skinIndex ${maxIdx} >= bones ${sk.bones.length} (would explode when posed)`,
      );
    }
    // any bind matrix non-identity-translation?
  });

  // rest local quaternions for key bones
  const key = ['Hips', 'Spine', 'Spine1', 'LeftUpLeg', 'LeftArm', 'RightArm', 'Head'];
  const map = {};
  for (const b of bones) {
    const n = b.name.replace(/^mixamorig\d*[:_]?/i, '');
    if (key.includes(n)) {
      const q = b.quaternion;
      map[n] = [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(4));
    }
  }
  console.log('  rest quats:', JSON.stringify(map));
  return { bones: bones.length, skins: skins.length, restQuats: map };
}

const x = analyze('x_bot (red)', './src/renderer/src/components/shared/image-editors/director/rig/x_bot.fbx');
const y = analyze('y_bot (blue)', './src/renderer/src/components/shared/image-editors/director/rig/y_bot.fbx');

if (x && y) {
  console.log('\n===== REST QUAT DIFF (x vs y) =====');
  for (const k of Object.keys(x.restQuats)) {
    const a = x.restQuats[k];
    const b = y.restQuats[k];
    const same = b && a.every((v, i) => Math.abs(v - b[i]) < 0.01);
    console.log(`  ${k}: x=${JSON.stringify(a)} y=${JSON.stringify(b)} ${same ? 'SAME' : '*** DIFFERENT ***'}`);
  }
}
