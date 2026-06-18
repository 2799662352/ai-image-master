(async function () {
  var re = /https?:\/\/[^"'\s\\]+\.(?:glb|gltf|fbx|obj|bin)(?:\?[^"'\s\\]*)?/gi;
  var srcs = performance
    .getEntriesByType('resource')
    .map(function (r) { return r.name; })
    .filter(function (u) { return /_nuxt\/.*\.js(\?|$)/.test(u); });
  srcs = Array.from(new Set(srcs));
  var found = new Set();
  var q = srcs.slice();
  async function one(u) {
    try {
      var t = await fetch(u).then(function (r) { return r.text(); });
      var m;
      while ((m = re.exec(t))) found.add(m[0]);
    } catch (e) {}
  }
  async function w() { while (q.length) await one(q.shift()); }
  await Promise.all([w(), w(), w(), w(), w(), w()]);
  window.__urls = Array.from(found);
  return 'js=' + srcs.length + ' urls=' + found.size;
})();
