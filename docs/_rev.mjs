import fs from 'node:fs';
const s = fs.readFileSync('d:/tecx/text/temp-ai-image-master-source/docs/_Dmnzwia4.js', 'utf8');
const terms = [
  'PerspectiveCamera', 'GridHelper', 'maxDistance', 'minDistance', 'captureStream',
  'MediaRecorder', 'webm', 'requestVideoFrame', 'setPixelRatio', 'setSize(',
  '.far=', 'far:', 'near:', 'Fog(', 'OrbitControls', 'focal', 'fov:', 'fov=',
  '2160', '1440', '1920', '3840', '2048', 'PlaneGeometry', 'GridHelper(',
];
const out = {};
for (const t of terms) {
  const idxs = [];
  let i = s.indexOf(t);
  while (i >= 0 && idxs.length < 4) { idxs.push(i); i = s.indexOf(t, i + 1); }
  out[t] = { count: (s.split(t).length - 1), samples: idxs.map((p) => s.slice(p - 60, p + 120)) };
}
fs.writeFileSync('d:/tecx/text/temp-ai-image-master-source/docs/_rev_out.json', JSON.stringify(out, null, 1), 'utf8');
console.log('done');
