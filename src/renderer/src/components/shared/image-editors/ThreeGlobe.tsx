import { useRef, useEffect, memo } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ORBIT_RADIUS, addOrbitGlobe, disposeScene } from "./orbitGlobeShared";

interface ThreeGlobeProps {
  horizontal: number;
  vertical: number;
  onRotate?: (h: number, v: number) => void;
  width?: number;
  height?: number;
  imageUrl?: string;
  /** Enable right-drag camera orbit + wheel zoom (used by the fullscreen stage). */
  orbitControls?: boolean;
}

function ThreeGlobeInner({
  horizontal,
  vertical,
  onRotate,
  width = 240,
  height = 240,
  imageUrl,
  orbitControls = false,
}: ThreeGlobeProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    subject: THREE.Mesh;
    subjectMat: THREE.MeshBasicMaterial;
    cameraIndicator: THREE.Group;
    dragging: boolean;
    dragStart: { x: number; y: number };
  } | null>(null);

  const valuesRef = useRef({ h: horizontal, v: vertical });
  const onRotateRef = useRef(onRotate);
  // On-demand rendering: scene is static except when angles/image change,
  // so we render only when invalidated instead of every frame.
  const invalidateRef = useRef<() => void>(() => {});

  useEffect(() => {
    valuesRef.current = { h: horizontal, v: vertical };
    invalidateRef.current();
  }, [horizontal, vertical]);

  useEffect(() => {
    onRotateRef.current = onRotate;
  }, [onRotate]);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x1a1a1a, 1);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 200);
    camera.position.set(0, 0, 17);
    camera.lookAt(0, 0, 0);

    addOrbitGlobe(scene, ORBIT_RADIUS);

    const SUBJECT_SIZE = 3.6;
    const subjectGeo = new THREE.PlaneGeometry(SUBJECT_SIZE, SUBJECT_SIZE);
    const subjectMat = new THREE.MeshBasicMaterial({
      color: 0x333333,
      transparent: true,
    });
    const subject = new THREE.Mesh(subjectGeo, subjectMat);
    scene.add(subject);

    const edgesMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      opacity: 0.12,
      transparent: true,
    });
    const edgeGeo = new THREE.EdgesGeometry(subjectGeo);
    subject.add(new THREE.LineSegments(edgeGeo, edgesMat));

    const cameraIndicator = new THREE.Group();

    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x3d3d3d });
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 0.54, 0.46),
      bodyMat,
    );
    cameraIndicator.add(body);

    const hump = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.14, 0.28),
      bodyMat,
    );
    hump.position.y = 0.34;
    cameraIndicator.add(hump);

    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.32, 24),
      new THREE.MeshBasicMaterial({ color: 0x161616 }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.39;
    cameraIndicator.add(lens);

    const lensRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.2, 0.028, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x707070 }),
    );
    lensRing.position.z = -0.55;
    cameraIndicator.add(lensRing);

    const recordDot = new THREE.Mesh(
      new THREE.CircleGeometry(0.04, 16),
      new THREE.MeshBasicMaterial({ color: 0xff4d4d }),
    );
    recordDot.position.set(0.2, 0.12, 0.24);
    cameraIndicator.add(recordDot);

    const bodyEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(body.geometry),
      new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.28,
      }),
    );
    body.add(bodyEdges);

    cameraIndicator.scale.setScalar(1.6);
    scene.add(cameraIndicator);

    const state = {
      renderer,
      scene,
      camera,
      subject,
      subjectMat,
      cameraIndicator,
      dragging: false,
      dragStart: { x: 0, y: 0 },
    };

    function updateIndicator() {
      const { h, v } = valuesRef.current;
      const hRad = (h * Math.PI) / 180;
      const vRad = (v * Math.PI) / 180;
      const r = ORBIT_RADIUS;
      const camX = r * Math.cos(vRad) * Math.sin(hRad);
      const camY = r * Math.sin(vRad);
      const camZ = r * Math.cos(vRad) * Math.cos(hRad);

      state.cameraIndicator.position.set(camX, camY, camZ);
      state.cameraIndicator.lookAt(0, 0, 0);
      // Object3D.lookAt() points a (non-camera) object's local +Z at the target,
      // but the lens is modelled on the -Z side. Flip 180° so the lens faces the
      // subject instead of pointing away from it.
      state.cameraIndicator.rotateY(Math.PI);
    }

    // Optional camera orbit (used by the fullscreen stage): right-drag orbits,
    // wheel zooms, with inertial damping. Left-drag stays reserved for the
    // angle-setting interaction below.
    let controls: OrbitControls | null = null;
    if (orbitControls) {
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = false;
      controls.minDistance = 8;
      controls.maxDistance = 40;
      controls.target.set(0, 0, 0);
      // Keep the left button for angle-drag; orbit on the right button.
      controls.mouseButtons = {
        LEFT: null as unknown as THREE.MOUSE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE,
      };
      // One-finger touch keeps driving the angle; two fingers dolly/rotate.
      controls.touches = {
        ONE: undefined as unknown as THREE.TOUCH,
        TWO: THREE.TOUCH.DOLLY_ROTATE,
      };
      // Make the subject visible from any side while inspecting in 3D.
      subjectMat.side = THREE.DoubleSide;
      controls.update();
    }

    // On-demand render: paint once now, then only when invalidated.
    // requestAnimationFrame coalesces multiple invalidations into one frame.
    // While the camera is settling (damping) the loop re-arms itself until idle.
    let rafId = 0;
    function renderFrame() {
      rafId = 0;
      updateIndicator();
      const changed = controls ? controls.update() : false;
      renderer.render(scene, camera);
      if (changed) invalidate();
    }
    function invalidate() {
      if (rafId) return;
      rafId = requestAnimationFrame(renderFrame);
    }
    invalidateRef.current = invalidate;
    controls?.addEventListener("change", invalidate);
    renderFrame();

    sceneRef.current = state;

    const onDown = (e: PointerEvent) => {
      // Only the left button drives the angle; right button is camera orbit.
      if (e.button !== 0) return;
      state.dragging = true;
      state.dragStart = { x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!state.dragging || !onRotateRef.current) return;
      const dx = e.clientX - state.dragStart.x;
      const dy = e.clientY - state.dragStart.y;
      state.dragStart = { x: e.clientX, y: e.clientY };
      const { h, v } = valuesRef.current;
      const newH = ((h + dx * 0.8) % 360 + 360) % 360;
      const newV = Math.max(-30, Math.min(60, v - dy * 0.5));
      onRotateRef.current(Math.round(newH), Math.round(newV));
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
    canvas.style.cursor = "grab";
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onUp);

    // Recover gracefully from WebGL context loss (driver hiccups, tab switch,
    // or too many live contexts when several editors are open at once).
    const onContextLost = (e: Event) => {
      e.preventDefault();
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };
    const onContextRestored = () => {
      invalidate();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      invalidateRef.current = () => {};
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onUp);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      controls?.removeEventListener("change", invalidate);
      controls?.dispose();
      state.subjectMat.map?.dispose();
      disposeScene(state.scene);
      renderer.dispose();
      // Proactively free the GL context so the browser/Electron reclaims it
      // immediately instead of waiting for GC.
      renderer.forceContextLoss();
      if (canvas.parentNode === el) el.removeChild(canvas);
      sceneRef.current = null;
    };
  }, [width, height, orbitControls]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const mat = s.subjectMat;

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
        mat.color.set(0xffffff);
        mat.needsUpdate = true;
        const aspect = img.width / img.height;
        if (aspect > 1) s.subject.scale.set(1, 1 / aspect, 1);
        else s.subject.scale.set(aspect, 1, 1);
        invalidateRef.current();
      };
      img.src = imageUrl;
    } else {
      if (mat.map) {
        mat.map.dispose();
        mat.map = null;
      }
      const iconCanvas = document.createElement("canvas");
      iconCanvas.width = 128;
      iconCanvas.height = 128;
      const ctx = iconCanvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "rgba(51,51,51,0.95)";
        ctx.fillRect(0, 0, 128, 128);
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 3;
        ctx.strokeRect(20, 20, 88, 88);
        ctx.beginPath();
        ctx.arc(44, 44, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(108, 76);
        ctx.lineTo(76, 44);
        ctx.lineTo(20, 108);
        ctx.stroke();
      }
      mat.map = new THREE.CanvasTexture(iconCanvas);
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
      s.subject.scale.set(1, 1, 1);
      invalidateRef.current();
    }
  }, [imageUrl]);

  return (
    <div
      ref={mountRef}
      style={{
        width,
        height,
        borderRadius: 12,
        overflow: "hidden",
        cursor: "grab",
        backgroundColor: "#1a1a1a",
        userSelect: "none",
        touchAction: "none",
      }}
    />
  );
}

export const ThreeGlobe = memo(ThreeGlobeInner);
export default ThreeGlobe;
