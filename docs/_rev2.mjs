import fs from 'node:fs';
const s = fs.readFileSync('d:/tecx/text/temp-ai-image-master-source/docs/_Dmnzwia4.js', 'utf8');
function dump(anchor, before, after) {
  const i = s.indexOf(anchor);
  if (i < 0) return `@@ NOT FOUND: ${anchor}`;
  return `@@ ${anchor} @ ${i}\n` + s.slice(i - before, i + after);
}
const parts = [
  dump('_installGrid()', 0, 2600),
  dump('applyCameraState(', 0, 700),
  dump('_setCameraOrbit(', 0, 500),
  dump('_buildSlotCamera(', 0, 700),
  dump('getRendererSize(', 0, 300),
  dump('getCanvas(', 0, 200),
  dump('function lu(t,e)', 0, 500),
  dump('canvas.captureStream 不可用', -400, 1400),
];
fs.writeFileSync('d:/tecx/text/temp-ai-image-master-source/docs/_rev2_out.txt', parts.join('\n\n========\n\n'), 'utf8');
console.log('done');
