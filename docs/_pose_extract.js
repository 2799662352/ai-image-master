(async () => {
  const src = await (await fetch('/_nuxt/Dmnzwia4.js')).text();
  const re = (p, g = 'g') => new RegExp(p, g);
  let m;

  // 1) As map: "./assets/bot-pose-presets/NAME.json": IDENT
  const nameToFreeze = {};
  const asRe = re('\\./assets/bot-pose-presets/([^"]+)\\.json":([A-Za-z$_][\\w$]*)');
  while ((m = asRe.exec(src))) nameToFreeze[m[1]] = m[2];

  // 2) FZ=Object.freeze(Object.defineProperty({__proto__:null,...,default:OBJ
  const freezeToObj = {};
  const fzRe = re('([A-Za-z$_][\\w$]*)=Object\\.freeze\\(Object\\.defineProperty\\(\\{__proto__:null,(?:[^{}]*?,)?default:([A-Za-z$_][\\w$]*)');
  while ((m = fzRe.exec(src))) freezeToObj[m[1]] = m[2];

  // 4) POSEVAR=JSON.parse('...')  (the bone maps)
  const poseToJson = {};
  const jpRe = re("([A-Za-z$_][\\w$]*)=JSON\\.parse\\('((?:\\\\.|[^'\\\\])*)'\\)");
  while ((m = jpRe.exec(src))) poseToJson[m[1]] = m[2];

  // helper: find object literal "OBJ={" and return ref var (pose/parameters) that is a bonemap
  function findBoneVar(objVar) {
    const idx = src.indexOf(objVar + '={type:');
    let start = idx;
    if (start < 0) { start = src.indexOf(objVar + '={'); }
    if (start < 0) return null;
    const win = src.slice(start, start + 260);
    const cand = [];
    let mm;
    const fieldRe = /(?:pose|parameters|bones):([A-Za-z$_][\w$]*)/g;
    while ((mm = fieldRe.exec(win))) cand.push(mm[1]);
    for (const c of cand) if (poseToJson[c]) return c;
    return null;
  }

  const out = {};
  const diag = {};
  for (const [name, fz] of Object.entries(nameToFreeze)) {
    const obj = freezeToObj[fz];
    const bv = obj && findBoneVar(obj);
    const raw = bv && poseToJson[bv];
    if (raw) {
      try {
        const jsonStr = (0, eval)("'" + raw + "'");
        out[name] = JSON.parse(jsonStr);
      } catch (e) { diag[name] = 'PARSE_ERR:' + e.message; }
    } else {
      diag[name] = { fz, obj: obj || null, bv: bv || null };
    }
  }

  // Build compact runtime: poseKey -> { boneName: [qx,qy,qz,qw] }
  const runtime = {};
  for (const [name, bones] of Object.entries(out)) {
    const map = {};
    for (const entry of Object.values(bones)) {
      const bn = entry.boneName;
      const q = entry.quaternion;
      if (bn && q) map[bn] = [q.x, q.y, q.z, q.w];
    }
    runtime[name] = map;
  }

  // Schema from first pose (preserves file/UI order): [{label, boneName, group, euler:[x,y,z]}]
  const firstKey = Object.keys(out)[0];
  const schema = Object.values(out[firstKey]).map((e) => ({
    label: e.label,
    boneName: e.boneName,
    group: e.group
  }));

  // Ordered groups
  const groups = [];
  for (const s of schema) if (!groups.includes(s.group)) groups.push(s.group);

  const result = { count: Object.keys(out).length, names: Object.keys(out), runtime, schema, groups };
  return btoa(unescape(encodeURIComponent(JSON.stringify(result))));
})()
