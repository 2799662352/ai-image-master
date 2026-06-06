import { useRef, useEffect, memo } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ORBIT_RADIUS, addOrbitGlobe, disposeScene } from "./orbitGlobeShared";

type LightDirection = "left" | "top" | "right" | "front" | "bottom" | "back";

export interface LightAngle {
  az: number;
  el: number;
}

export type LightTarget =
  | { type: "preset"; key: LightDirection }
  | { type: "custom"; az: number; el: number };

interface ThreeLightSceneProps {
  direction: LightDirection;
  customAngle?: LightAngle | null;
  brightness: number;
  color: string;
  viewMode: "perspective" | "front";
  width?: number;
  height?: number;
  imageUrl?: string;
  /** Called while dragging the bulb (continuous) and on magnetic snap release. */
  onLightChange?: (target: LightTarget) => void;
  /**
   * 松手时是否磁吸到最近预设(≤18° 内). 默认 false —— 自由角度不会被吃回预设标签.
   * 打开后: 松手若落在某预设附近, 自动跳回 preset 并更新提示词为该预设文案.
   */
  snapToPreset?: boolean;
  /**
   * 开启 OrbitControls:左键空白处=相机环绕(阻尼)+ 滚轮缩放;命中灯泡仍是拖灯.
   * 仅全屏台开启. 内联小窗保持原手动相机环绕(拖空白会带动灯光).
   */
  orbitControls?: boolean;
}

/**
 * Azimuth (around Y, 0 = +Z, 90 = +X) and elevation (above XZ plane) for each preset.
 * Matches the original plain-version layout.
 */
export const DIR_AZ_EL: Record<LightDirection, [number, number]> = {
  left: [180, 0],
  top: [0, 90],
  right: [0, 0],
  front: [90, 0],
  bottom: [0, -90],
  back: [270, 0],
};

const PRESET_KEYS: LightDirection[] = ["left", "top", "right", "front", "bottom", "back"];

function greatCircleDeg(a1: number, e1: number, a2: number, e2: number): number {
  const toRad = Math.PI / 180;
  const la1 = e1 * toRad;
  const la2 = e2 * toRad;
  const dAz = (a1 - a2) * toRad;
  const cosC = Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(dAz);
  return (Math.acos(Math.max(-1, Math.min(1, cosC))) * 180) / Math.PI;
}

function nearestPreset(az: number, el: number): { key: LightDirection; dist: number } {
  let best: LightDirection = "front";
  let bestD = Infinity;
  for (const k of PRESET_KEYS) {
    const [pa, pe] = DIR_AZ_EL[k];
    const d = greatCircleDeg(az, el, pa, pe);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return { key: best, dist: bestD };
}

function lerpAzShort(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

const CONE_VERT = `
varying vec2 vUv;
varying float vHeight;
void main() {
  vUv = uv;
  vHeight = (3.0 - position.y) / 6.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CONE_FRAG = `
uniform vec3 lightColor;
uniform float opacity;
uniform float time;
varying vec2 vUv;
varying float vHeight;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  float falloff = pow(vHeight, 2.5);
  float lat = abs(vUv.x - 0.5) * 2.0;
  float core = pow(1.0 - lat, 4.0);
  float fringe = pow(1.0 - lat, 0.8);
  float grain = hash(vUv + time * 0.05) * 0.12;
  vec3 base = mix(lightColor, vec3(1.0), pow(vHeight, 8.0) * 0.8);
  float a = (core * 2.0 + fringe * 2.0) * falloff * opacity;
  a *= (0.9 + grain);
  a *= smoothstep(0.0, 0.15, vHeight);
  gl_FragColor = vec4(base, a);
}
`;

function ndcFromEvent(canvas: HTMLCanvasElement, e: PointerEvent, out: THREE.Vector2): void {
  const rect = canvas.getBoundingClientRect();
  out.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  out.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function ThreeLightSceneInner({
  direction,
  customAngle,
  brightness,
  color,
  viewMode,
  width = 200,
  height = 200,
  imageUrl,
  onLightChange,
  snapToPreset = false,
  orbitControls = false,
}: ThreeLightSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const onLightChangeRef = useRef(onLightChange);
  // Ref 追最新的 snap 开关, 让 onUp 里读到实时值且不需要重建监听器.
  const snapToPresetRef = useRef(snapToPreset);

  useEffect(() => {
    onLightChangeRef.current = onLightChange;
  }, [onLightChange]);

  useEffect(() => {
    snapToPresetRef.current = snapToPreset;
  }, [snapToPreset]);

  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    bulb: THREE.Mesh;
    bulbMat: THREE.MeshBasicMaterial;
    cone: THREE.Mesh;
    coneMat: THREE.ShaderMaterial;
    pointLight: THREE.PointLight;
    pickSphere: THREE.Mesh;
    dragSphere: THREE.Mesh;
    target: THREE.Mesh;
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
    frameId: number;
    tAz: number;
    tEl: number;
    dispAz: number;
    dispEl: number;
    startTime: number;
    dragMode: "idle" | "light" | "camera";
    dragStart: { x: number; y: number };
    camAz: number;
    camEl: number;
  } | null>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    /* Plain renderer — no tone mapping, matches the original look */
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x1a1a1a, 1);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 200);
    camera.position.set(11, 8, 10);
    camera.lookAt(0, 0, 0);

    addOrbitGlobe(scene, ORBIT_RADIUS);

    const TARGET_SIZE = 3.6;
    const targetGeo = new THREE.PlaneGeometry(TARGET_SIZE, TARGET_SIZE);
    const targetMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
    const target = new THREE.Mesh(targetGeo, targetMat);
    scene.add(target);

    const edgesMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      opacity: 0.12,
      transparent: true,
    });
    target.add(new THREE.LineSegments(new THREE.EdgesGeometry(targetGeo), edgesMat));

    scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const pointLight = new THREE.PointLight(0xffffff, 3, 0);
    scene.add(pointLight);

    /* Plain bulb — single white MeshBasicMaterial sphere */
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 48, 48), bulbMat);
    scene.add(bulb);

    /* Volumetric cone — identical to the original plain version */
    const coneMat = new THREE.ShaderMaterial({
      vertexShader: CONE_VERT,
      fragmentShader: CONE_FRAG,
      uniforms: {
        lightColor: { value: new THREE.Color(0xffffff) },
        opacity: { value: 0.5 },
        time: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.5, 6, 128, 1, true), coneMat);
    scene.add(cone);

    /* Invisible pick sphere — a child of the bulb, moves with it.
       Slightly larger so it's easy to grab without being visually intrusive. */
    const pickSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 16, 16),
      new THREE.MeshBasicMaterial({ visible: false, depthWrite: false }),
    );
    bulb.add(pickSphere);

    /* Invisible world-space drag sphere at ORBIT_RADIUS for raycasting the free-drag target. */
    const dragSphere = new THREE.Mesh(
      new THREE.SphereGeometry(ORBIT_RADIUS, 48, 48),
      new THREE.MeshBasicMaterial({
        visible: false,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    scene.add(dragSphere);

    const initAngle = customAngle ?? (() => {
      const [a, e] = DIR_AZ_EL[direction];
      return { az: a, el: e };
    })();

    const startTime = performance.now();
    const state: NonNullable<typeof sceneRef.current> = {
      renderer,
      scene,
      camera,
      bulb,
      bulbMat,
      cone,
      coneMat,
      pointLight,
      pickSphere,
      dragSphere,
      target,
      raycaster: new THREE.Raycaster(),
      pointer: new THREE.Vector2(),
      frameId: 0,
      tAz: initAngle.az,
      tEl: initAngle.el,
      dispAz: initAngle.az,
      dispEl: initAngle.el,
      startTime,
      dragMode: "idle",
      dragStart: { x: 0, y: 0 },
      camAz: 45,
      camEl: 30,
    };

    /** Identical math to the original plain version. */
    function updateLightPosition() {
      const az = (state.dispAz * Math.PI) / 180;
      const el = (state.dispEl * Math.PI) / 180;
      const dist = ORBIT_RADIUS;
      const x = dist * Math.cos(el) * Math.sin(az);
      const y = dist * Math.sin(el);
      const z = dist * Math.cos(el) * Math.cos(az);

      state.pointLight.position.set(x, y, z);
      state.bulb.position.set(x, y, z);

      state.cone.position.set(x / 2, y / 2, z / 2);
      state.cone.lookAt(0, 0, 0);
      state.cone.rotateX(-Math.PI / 2);
    }

    function updateCameraFromOrbit() {
      const az = (state.camAz * Math.PI) / 180;
      const el = (state.camEl * Math.PI) / 180;
      const camDist = 17;
      state.camera.position.set(
        camDist * Math.cos(el) * Math.sin(az),
        camDist * Math.sin(el),
        camDist * Math.cos(el) * Math.cos(az),
      );
      state.camera.lookAt(0, 0, 0);
    }

    updateLightPosition();
    updateCameraFromOrbit();

    // Optional OrbitControls for the fullscreen stage: left-drag on empty space
    // orbits the camera with inertial damping, wheel zooms. Grabbing the bulb
    // (handled below) temporarily disables it so dragging the light still works.
    let controls: OrbitControls | null = null;
    if (orbitControls) {
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = false;
      controls.minDistance = 8;
      controls.maxDistance = 40;
      controls.target.set(0, 0, 0);
      controls.update();
    }

    const animate = () => {
      state.frameId = requestAnimationFrame(animate);
      const t = (performance.now() - state.startTime) / 1000;
      state.coneMat.uniforms.time.value = t;

      // Snappier while dragging the light, smoother otherwise.
      const lerp = state.dragMode === "light" ? 0.45 : 0.12;
      state.dispAz = lerpAzShort(state.dispAz, state.tAz, lerp);
      state.dispEl += (state.tEl - state.dispEl) * lerp;
      updateLightPosition();

      controls?.update();
      state.target.lookAt(state.camera.position);

      renderer.render(scene, camera);
    };
    animate();

    sceneRef.current = state;

    /* Interaction: raycast bulb first, otherwise rotate camera */
    const canvas = renderer.domElement;
    canvas.style.touchAction = "none";

    const hitBulb = (e: PointerEvent): boolean => {
      ndcFromEvent(canvas, e, state.pointer);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      const hits = state.raycaster.intersectObject(state.pickSphere, false);
      return hits.length > 0;
    };

    const worldPointToAzEl = (e: PointerEvent): { az: number; el: number } | null => {
      ndcFromEvent(canvas, e, state.pointer);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      const hits = state.raycaster.intersectObject(state.dragSphere, false);
      if (hits.length === 0) return null;
      const p = hits[0].point;
      const r = ORBIT_RADIUS;
      const el = Math.asin(Math.max(-1, Math.min(1, p.y / r))) * (180 / Math.PI);
      const az = Math.atan2(p.x, p.z) * (180 / Math.PI);
      return { az: ((az % 360) + 360) % 360, el };
    };

    const onDown = (e: PointerEvent) => {
      const onBulb = hitBulb(e);
      if (controls) {
        // Pause orbit while grabbing the bulb so the light drag wins; otherwise
        // let OrbitControls drive the camera (don't capture the pointer).
        controls.enabled = !onBulb;
        if (!onBulb) {
          state.dragMode = "idle";
          return;
        }
      }
      state.dragStart = { x: e.clientX, y: e.clientY };
      state.dragMode = onBulb ? "light" : "camera";
      canvas.style.cursor = "grabbing";
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (state.dragMode === "idle") {
        const overBulb = hitBulb(e);
        // Disable orbit while hovering the bulb so the next press grabs the
        // light instead of starting a camera rotate (capture-phase ordering
        // can't beat OrbitControls' own listener, so we gate it on hover).
        if (controls) controls.enabled = !overBulb;
        canvas.style.cursor = overBulb ? "grab" : "default";
        return;
      }
      if (state.dragMode === "light") {
        const angle = worldPointToAzEl(e);
        if (!angle) return;
        state.tAz = angle.az;
        state.tEl = Math.max(-89, Math.min(89, angle.el));
        onLightChangeRef.current?.({ type: "custom", az: state.tAz, el: state.tEl });
      } else if (state.dragMode === "camera") {
        const dx = e.clientX - state.dragStart.x;
        const dy = e.clientY - state.dragStart.y;
        state.dragStart = { x: e.clientX, y: e.clientY };

        // Pure camera orbit — fully independent of the light. Dragging empty
        // space only moves the viewpoint; the light only changes when you drag
        // the bulb. (Matches the fullscreen OrbitControls behaviour.)
        state.camAz += -dx * 0.5;
        state.camEl = Math.max(-89, Math.min(89, state.camEl + dy * 0.5));
        updateCameraFromOrbit();
      }
    };

    const onUp = (e: PointerEvent) => {
      // Only the bulb drag moves the light, so only it triggers magnetic snap.
      // Camera drag is a pure viewpoint change and never touches the light.
      const wasMovingLight = state.dragMode === "light";
      state.dragMode = "idle";
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const overBulb = hitBulb(e);
      // Resume orbit unless the pointer is still resting on the bulb.
      if (controls) controls.enabled = !overBulb;
      canvas.style.cursor = overBulb ? "grab" : "default";

      // 仅当开关打开时才做磁吸. 默认关: 用户拖到的任何自由角度都原样保留.
      if (wasMovingLight && snapToPresetRef.current) {
        const snap = nearestPreset(state.tAz, state.tEl);
        if (snap.dist <= 18) {
          onLightChangeRef.current?.({ type: "preset", key: snap.key });
        }
      }
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onUp);

    // Recover gracefully from WebGL context loss (driver hiccups, tab switch,
    // or too many live contexts when several editors are open at once).
    const onContextLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(state.frameId);
    };
    const onContextRestored = () => {
      // Reset the clock origin so the cone animation doesn't jump, then resume.
      state.startTime = performance.now();
      animate();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    return () => {
      cancelAnimationFrame(state.frameId);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onUp);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      controls?.dispose();
      (state.target.material as THREE.MeshBasicMaterial).map?.dispose();
      disposeScene(state.scene);
      renderer.dispose();
      // Proactively free the GL context so the browser/Electron reclaims it
      // immediately instead of waiting for GC.
      renderer.forceContextLoss();
      if (canvas.parentNode === el) el.removeChild(canvas);
      sceneRef.current = null;
    };
  }, [width, height, orbitControls]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Imperative texture update when imageUrl changes */
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const mat = s.target.material as THREE.MeshBasicMaterial;

    if (imageUrl) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (!sceneRef.current) return;
        if (mat.map) mat.map.dispose();
        const tex = new THREE.Texture(img);
        tex.needsUpdate = true;
        tex.colorSpace = THREE.SRGBColorSpace;
        mat.map = tex;
        mat.needsUpdate = true;
        const aspect = img.width / img.height;
        if (aspect > 1) s.target.scale.set(1, 1 / aspect, 1);
        else s.target.scale.set(aspect, 1, 1);
      };
      img.src = imageUrl;
    } else {
      if (mat.map) {
        mat.map.dispose();
        mat.map = null;
      }
      mat.needsUpdate = true;
    }
  }, [imageUrl]);

  /* Target angle: preset OR custom free-drag */
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    if (customAngle) {
      s.tAz = customAngle.az;
      s.tEl = customAngle.el;
    } else {
      const [az, el] = DIR_AZ_EL[direction];
      s.tAz = az;
      s.tEl = el;
    }
  }, [direction, customAngle?.az, customAngle?.el]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const intensity = 0.5 + (brightness / 4) * 4;
    s.pointLight.intensity = intensity;
    s.coneMat.uniforms.opacity.value = 0.3 + (brightness / 4) * 0.3;
  }, [brightness]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const c = new THREE.Color(color);
    s.pointLight.color.copy(c);
    s.bulbMat.color.copy(c);
    s.coneMat.uniforms.lightColor.value.copy(c);
  }, [color]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    if (viewMode === "front") {
      s.camAz = 90;
      s.camEl = 0;
    } else {
      s.camAz = 45;
      s.camEl = 30;
    }
    const az = (s.camAz * Math.PI) / 180;
    const el = (s.camEl * Math.PI) / 180;
    const camDist = 17;
    s.camera.position.set(
      camDist * Math.cos(el) * Math.sin(az),
      camDist * Math.sin(el),
      camDist * Math.cos(el) * Math.cos(az),
    );
    s.camera.lookAt(0, 0, 0);
  }, [viewMode]);

  return (
    <div
      ref={mountRef}
      style={{ width, height, borderRadius: 12, overflow: "hidden", cursor: "grab" }}
    />
  );
}

export const ThreeLightScene = memo(ThreeLightSceneInner);
export default ThreeLightScene;
