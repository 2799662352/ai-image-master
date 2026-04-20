import { useRef, useEffect, memo } from "react";
import * as THREE from "three";
import { ORBIT_RADIUS, addOrbitGlobe, disposeScene } from "./orbitGlobeShared";

interface ThreeGlobeProps {
  horizontal: number;
  vertical: number;
  onRotate?: (h: number, v: number) => void;
  width?: number;
  height?: number;
  imageUrl?: string;
}

function ThreeGlobeInner({
  horizontal,
  vertical,
  onRotate,
  width = 240,
  height = 240,
  imageUrl,
}: ThreeGlobeProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    subject: THREE.Mesh;
    subjectMat: THREE.MeshBasicMaterial;
    cameraIndicator: THREE.Group;
    frameId: number;
    dragging: boolean;
    dragStart: { x: number; y: number };
  } | null>(null);

  const valuesRef = useRef({ h: horizontal, v: vertical });
  const onRotateRef = useRef(onRotate);

  useEffect(() => {
    valuesRef.current = { h: horizontal, v: vertical };
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

    scene.add(cameraIndicator);

    const state = {
      renderer,
      scene,
      camera,
      subject,
      subjectMat,
      cameraIndicator,
      frameId: 0,
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
    }

    updateIndicator();

    const animate = () => {
      state.frameId = requestAnimationFrame(animate);
      updateIndicator();
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

    return () => {
      cancelAnimationFrame(state.frameId);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onUp);
      state.subjectMat.map?.dispose();
      disposeScene(state.scene);
      renderer.dispose();
      if (canvas.parentNode === el) el.removeChild(canvas);
      sceneRef.current = null;
    };
  }, [width, height]);

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
