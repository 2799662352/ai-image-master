// Compare preset bone set vs each rig's actual skinning skeleton bones.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.self = globalThis;
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => 'blob://stub';
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
globalThis.document = globalThis.document || {
  createElementNS: () => ({ getContext: () => null, style: {} }),
  createElement: () => ({ getContext: () => null, style: {}, setAttribute() {} }),
};
const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture(); };
if (THREE.ImageLoader) THREE.ImageLoader.prototype.load = function () { return {}; };

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'src', 'renderer', 'src', 'components', 'shared', 'image-editors', 'director');
const rigDir = path.join(dir, 'rig');
const presets = JSON.parse(fs.readFileSync(path.join(dir, 'bot-pose-presets.json'), 'utf8'));

const normBone = (n) => String(n || '')
  .replace(/^mixamorig\d*[:_]?/i, '').replace(/^armature[_:]?/i, '')
  .replace(/[.:_\-\s]/g, '').toLowerCase();

function load(file) {
  const buf = fs.readFileSync(path.join(rigDir, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new FBXLoader().parse(ab, rigDir + path.sep);
}

// preset bone set (normalized), from first non-default preset
const firstPose = Object.values(presets)[0];
const presetBones = new Set(Object.keys(firstPose).map(normBone));
console.log('preset bone count:', presetBones.size);

for (const file of ['x_bot.fbx', 'y_bot.fbx']) {
  const obj = load(file);
  const skins = [];
  obj.traverse((o) => { if (o.isSkinnedMesh) skins.push(o); });
  console.log(`\n=== ${file} ===`);
  for (const sm of skins) {
    const skelNames = new Set(sm.skeleton.bones.map((b) => normBone(b.name)));
    const presetNotInSkel = [...presetBones].filter((b) => !skelNames.has(b));
    const skelNotInPreset = [...skelNames].filter((b) => !presetBones.has(b));
    console.log(`  mesh ${sm.name}: skelBones=${skelNames.size}`);
    console.log(`    preset bones NOT in this skin skeleton (${presetNotInSkel.length}): ${presetNotInSkel.join(', ')}`);
    console.log(`    skin bones NOT in preset (${skelNotInPreset.length}): ${skelNotInPreset.join(', ')}`);
  }
  // also: are the skeleton bones actually descendants of obj (posable via traverse)?
  const allBoneSet = new Set();
  obj.traverse((o) => { if (o.isBone) allBoneSet.add(o); });
  for (const sm of skins) {
    const missing = sm.skeleton.bones.filter((b) => !allBoneSet.has(b));
    console.log(`    skin '${sm.name}': skeleton bones NOT in obj graph: ${missing.length}`);
  }
}
