import { useRef, useEffect, memo } from "react";
import * as THREE from "three";
import { ORBIT_RADIUS, addOrbitGlobe, disposeScene } from "./orbitGlobeShared";

type LightDirection = "left" | "top" | "right" | "front" | "bottom" | "back";

interface ThreeLightSceneProps {
  direction: LightDirection;
  brightness: number;
  color: string;
  viewMode: "perspective" | "front";
  width?: number;
  height?: number;
  imageUrl?: string;
}

const DIR_AZ_EL: Record<LightDirection, [number, number]> = {
  left: [180, 0],
  top: [0, 90],
  right: [0, 0],
  front: [90, 0],
  bottom: [0, -90],
  back: [270, 0],
};

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

function ThreeLightSceneInner({
  direction,
  brightness,
  color,
  viewMode,
  width = 200,
  height = 200,
  imageUrl,
}: ThreeLightSceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    lightGroup: THREE.Group;
    bulb: THREE.Mesh;
    cone: THREE.Mesh;
    pointLight: THREE.PointLight;
    coneMat: THREE.ShaderMaterial;
    target: THREE.Mesh;
    frameId: number;
    tAz: number;
    tEl: number;
    dispAz: number;
    dispEl: number;
    startTime: number;
    dragging: boolean;
    dragStart: { x: number; y: number };
    camAz: number;
    camEl: number;
  } | null>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

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
    const targetMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
    });
    const target = new THREE.Mesh(targetGeo, targetMat);
    scene.add(target);

    const edgesMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.12, transparent: true });
    const edgeGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(TARGET_SIZE, TARGET_SIZE));
    target.add(new THREE.LineSegments(edgeGeo, edgesMat));

    scene.add(new THREE.AmbientLight(0xffffff, 0.15));

    const pointLight = new THREE.PointLight(0xffffff, 3, 0);
    scene.add(pointLight);

    const lightGroup = new THREE.Group();
    scene.add(lightGroup);

    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 48, 48), bulbMat);
    lightGroup.add(bulb);

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
    lightGroup.add(cone);

    const [initAz, initEl] = DIR_AZ_EL[direction];

    const startTime = performance.now();
    const state = {
      renderer,
      scene,
      camera,
      lightGroup,
      bulb,
      cone,
      pointLight,
      coneMat,
      target,
      frameId: 0,
      tAz: initAz,
      tEl: initEl,
      dispAz: initAz,
      dispEl: initEl,
      startTime,
      dragging: false,
      dragStart: { x: 0, y: 0 },
      camAz: 45,
      camEl: 30,
    };

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

    const animate = () => {
      state.frameId = requestAnimationFrame(animate);
      const t = (performance.now() - state.startTime) / 1000;
      state.coneMat.uniforms.time.value = t;

      const lerp = 0.12;
      state.dispAz += (state.tAz - state.dispAz) * lerp;
      state.dispEl += (state.tEl - state.dispEl) * lerp;
      updateLightPosition();

      state.target.lookAt(state.camera.position);

      renderer.render(scene, camera);
    };
    animate();

    sceneRef.current = state;

    const onDown = (e: PointerEvent) => {
      state.dragging = true;
      state.dragStart = { x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!state.dragging) return;
      const dx = e.clientX - state.dragStart.x;
      const dy = e.clientY - state.dragStart.y;
      state.dragStart = { x: e.clientX, y: e.clientY };
      state.camAz -= dx * 0.5;
      state.camEl = Math.max(-89, Math.min(89, state.camEl + dy * 0.5));
      updateCameraFromOrbit();
    };
    const onUp = (e: PointerEvent) => {
      state.dragging = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    };

    const canvas = renderer.domElement;
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onUp);

    return () => {
      cancelAnimationFrame(state.frameId);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onUp);
      (state.target.material as THREE.MeshBasicMaterial).map?.dispose();
      disposeScene(state.scene);
      renderer.dispose();
      if (canvas.parentNode === el) el.removeChild(canvas);
      sceneRef.current = null;
    };
  }, [width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  // Imperative texture update when imageUrl changes (avoids remounting WebGL)
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
      if (mat.map) { mat.map.dispose(); mat.map = null; }
      mat.needsUpdate = true;
    }
  }, [imageUrl]);

  useEffect(() => {
    if (!sceneRef.current) return;
    const s = sceneRef.current;
    const [az, el] = DIR_AZ_EL[direction];
    s.tAz = az;
    s.tEl = el;
  }, [direction]);

  useEffect(() => {
    if (!sceneRef.current) return;
    const s = sceneRef.current;
    const intensity = 0.5 + (brightness / 4) * 4;
    s.pointLight.intensity = intensity;
    s.coneMat.uniforms.opacity.value = 0.3 + (brightness / 4) * 0.3;
  }, [brightness]);

  useEffect(() => {
    if (!sceneRef.current) return;
    const s = sceneRef.current;
    const c = new THREE.Color(color);
    s.pointLight.color.copy(c);
    (s.bulb.material as THREE.MeshBasicMaterial).color.copy(c);
    s.coneMat.uniforms.lightColor.value.copy(c);
  }, [color]);

  useEffect(() => {
    if (!sceneRef.current) return;
    const s = sceneRef.current;
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
