/**
 * Shared 3D orbit-globe geometry used by both MultiAngleEditor (ThreeGlobe)
 * and LightEditor (ThreeLightScene). Provides the sphere shell shader,
 * grid (equator + latitudes + meridians), and snap dots at intersections.
 *
 * Keeping this in one place guarantees the two editors look identical —
 * tweak a color / opacity here and both update.
 */

import * as THREE from "three";

export const ORBIT_RADIUS = 6.06;

/* ── Shared shaders ─────────────────────────────────────────────── */

export const SHELL_VERT = `
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  vNormal = -normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const SHELL_FRAG = `
uniform vec3 baseColor;
uniform float shadowIntensity;
uniform float centerAlpha;
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  float nDotV = max(dot(vNormal, vViewDir), 0.0);
  float edge = pow(1.0 - nDotV, 2.0);
  vec3 col = mix(baseColor, vec3(0.0), edge * 0.5);
  float a = centerAlpha + edge * shadowIntensity;
  gl_FragColor = vec4(col, a);
}
`;

export const DOT_VERT = `
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const DOT_FRAG = `
uniform vec3 dotColor;
uniform float dotOpacity;
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
  float nDotV = max(dot(vNormal, vViewDir), 0.0);
  float a = dotOpacity * (0.5 + 0.5 * nDotV);
  gl_FragColor = vec4(dotColor, a);
}
`;

/* ── Snap points (azimuth / elevation pairs on the sphere) ──────── */

export const SNAP_POINTS: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let el = -60; el <= 90; el += 30) {
    const step = el === 90 || el === -90 ? 360 : 45;
    for (let az = 0; az < 360; az += step) {
      out.push([az, el]);
    }
  }
  return out;
})();

/** Convert (azimuth °, elevation °) on a sphere of radius `r` into a Vector3. */
export function azElToPos(az: number, el: number, r: number): THREE.Vector3 {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  return new THREE.Vector3(
    r * Math.cos(e) * Math.sin(a),
    r * Math.sin(e),
    r * Math.cos(e) * Math.cos(a),
  );
}

/* ── Scene builder ──────────────────────────────────────────────── */

export interface OrbitGlobeHandles {
  shell: THREE.Mesh;
  shellMat: THREE.ShaderMaterial;
  gridLines: THREE.Line[];
  dots: THREE.Mesh[];
}

/**
 * Add the shared orbit-globe geometry (shell + grid + snap dots) to the scene.
 * Matches the visual style previously only found in `ThreeLightScene`.
 */
export function addOrbitGlobe(
  scene: THREE.Scene,
  r: number = ORBIT_RADIUS,
): OrbitGlobeHandles {
  const shellMat = new THREE.ShaderMaterial({
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    uniforms: {
      baseColor: { value: new THREE.Color(0xcccccc) },
      shadowIntensity: { value: 0.85 },
      centerAlpha: { value: 0.08 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 64), shellMat);
  scene.add(shell);

  const gridMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    opacity: 0.06,
    transparent: true,
  });
  const gridLines: THREE.Line[] = [];

  // Equator
  const eqPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    eqPts.push(new THREE.Vector3(r * Math.sin(a), 0, r * Math.cos(a)));
  }
  const eq = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(eqPts),
    gridMat,
  );
  scene.add(eq);
  gridLines.push(eq);

  // Latitude circles at ±30°, ±60°
  for (let elev = -60; elev <= 60; elev += 30) {
    if (elev === 0) continue;
    const pts: THREE.Vector3[] = [];
    const r2 = r * Math.cos((elev * Math.PI) / 180);
    const y = r * Math.sin((elev * Math.PI) / 180);
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(r2 * Math.sin(a), y, r2 * Math.cos(a)));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      gridMat.clone(),
    );
    scene.add(line);
    gridLines.push(line);
  }

  // Meridians every 45°
  for (let az = 0; az < 360; az += 45) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const e = ((i / 64) * 180 - 90) * (Math.PI / 180);
      const a = (az * Math.PI) / 180;
      pts.push(
        new THREE.Vector3(
          r * Math.cos(e) * Math.sin(a),
          r * Math.sin(e),
          r * Math.cos(e) * Math.cos(a),
        ),
      );
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      gridMat.clone(),
    );
    scene.add(line);
    gridLines.push(line);
  }

  // Snap dots at intersections
  const dots: THREE.Mesh[] = [];
  SNAP_POINTS.forEach(([az, elv]) => {
    const dotMat = new THREE.ShaderMaterial({
      vertexShader: DOT_VERT,
      fragmentShader: DOT_FRAG,
      uniforms: {
        dotColor: { value: new THREE.Color(0xffffff) },
        dotOpacity: { value: 0.25 },
      },
      transparent: true,
      depthWrite: false,
    });
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), dotMat);
    dot.position.copy(azElToPos(az, elv, r));
    scene.add(dot);
    dots.push(dot);
  });

  return { shell, shellMat, gridLines, dots };
}

/**
 * Traverse the scene and dispose ALL GPU resources (geometries, materials, textures).
 * Three.js does NOT auto-clean GPU resources — this must be called on unmount.
 */
export function disposeScene(scene: THREE.Scene): void {
  scene.traverse((object) => {
    if ('geometry' in object && (object as any).geometry) {
      (object as any).geometry.dispose()
    }
    if ('material' in object) {
      const materials = Array.isArray((object as any).material)
        ? (object as any).material
        : [(object as any).material]
      for (const mat of materials) {
        if (!mat) continue
        mat.map?.dispose()
        mat.dispose()
      }
    }
  })
}
