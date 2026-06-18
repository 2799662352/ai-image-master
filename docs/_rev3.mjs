import fs from 'node:fs';
const src = fs.readFileSync(new URL('./_Dmnzwia4.js', import.meta.url), 'utf8');
const grab = (needle, before = 40, after = 320) => {
  const out = [];
  let idx = 0;
  while ((idx = src.indexOf(needle, idx)) !== -1) {
    out.push(src.slice(Math.max(0, idx - before), idx + after));
    idx += needle.length;
    if (out.length >= 3) break;
  }
  return out;
};
const targets = ['ultraTele', 'bpp', 'background=new', 'ou=[', 'fps:', 'duration', 'this._projectionScale', '_lensKey='];
for (const t of targets) {
  console.log('\n===== ' + t + ' =====');
  const hits = grab(t);
  if (!hits.length) { console.log('(none)'); continue; }
  hits.forEach((h, i) => console.log('--- #' + i + '\n' + h));
}
