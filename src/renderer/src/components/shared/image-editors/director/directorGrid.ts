/**
 * 着色器无限网格地面 — 逆向自实站 `DirectorEngine._installGrid()`
 * (chunk `_Dmnzwia4.js`, three.js r180)。
 *
 * 取代之前的 `THREE.GridHelper(40)`:用一块 4000×4000 的水平面 + 自定义
 * ShaderMaterial 绘制次级/主级网格线,借助 `fwidth` 做屏幕空间抗锯齿,并
 * 按到视点的距离从 `fadeStart` 到 `fadeEnd` 平滑淡出。这正是原站「空间看起来
 * 大很多」的来源:地面铺满到极远处,而不是一块 40 单位的小网格。
 *
 * 片元着色器主体在原始 chunk 中被截断,这里按其结构(gridLine + 距离淡出 +
 * 全景球裁剪)忠实重建,uniform/颜色/步长/淡出半径均为逆向原值。
 */
import * as THREE from 'three';
import { GRID } from './directorConstants';

const VERT = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    // 平面顶点跟随相机 XZ 平移(Fyrestar InfiniteGridHelper 同款):镜头
    // 平移/拉远时地面永远铺在脚下,视觉上真·无限;网格线仍按绝对世界坐标
    // 计算(vWorldPos),不会跟着相机"漂"。
    vec3 pos = position;
    pos.xz += cameraPosition.xz;
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3  uMinorColor;
  uniform vec3  uMajorColor;
  uniform float uMinorStep;
  uniform float uMajorStep;
  uniform float uFadeStart;
  uniform float uFadeEnd;
  uniform float uOpacityMul;
  uniform float uSphereClip;
  uniform vec3  uSphereCenter;
  uniform float uSphereRadius;
  varying vec3  vWorldPos;

  // 抗锯齿网格线强度:返回 [0,1],1 = 在线上。
  float gridLine(vec2 p, float step) {
    vec2 coord = p / step;
    vec2 d = fwidth(coord);
    vec2 g = abs(fract(coord - 0.5) - 0.5) / max(d, vec2(1e-5));
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    vec2 p = vWorldPos.xz;

    // 全景球裁剪:网格平面与球的交截圆之外丢弃。
    if (uSphereClip > 0.5) {
      vec2 c = uSphereCenter.xz;
      float rr = uSphereRadius * uSphereRadius - uSphereCenter.y * uSphereCenter.y;
      float r = rr > 0.0 ? sqrt(rr) : 0.0;
      if (length(p - c) > r) discard;
    }

    float minor = gridLine(p, uMinorStep);
    float major = gridLine(p, uMajorStep);

    // 距相机(XZ 投影)淡出 —— 不再以世界原点为中心:镜头移到哪,网格就
    // 铺到哪(Fyrestar InfiniteGridHelper / drei Grid 同款 fadeFrom=camera)。
    float dist = distance(cameraPosition.xz, p);
    float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, dist);
    if (fade <= 0.0) discard;
    // 次级线提前淡出(半程):远处 1 单位细线密到亚像素会糊成噪点/摩尔纹,
    // 只留 10 单位主线撑远景(Blender 网格同款取舍)。
    float minorFade = 1.0 - smoothstep(uFadeStart * 0.5, uFadeEnd * 0.5, dist);

    vec3 color = mix(uMinorColor, uMajorColor, major);
    float alpha = max(minor * 0.5 * minorFade, major * fade) * uOpacityMul;
    if (alpha <= 0.001) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

export interface ShaderGrid {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  dispose(): void;
}

/** 构建着色器网格地面。`y` 默认 0(地面在世界原点)。 */
export function buildShaderGrid(): ShaderGrid {
  const geo = new THREE.PlaneGeometry(GRID.size, GRID.size, 1, 1);
  geo.rotateX(-Math.PI / 2);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // derivatives 在 WebGL2/three r180 默认可用;保留以兼容。
    extensions: { derivatives: true } as never,
    uniforms: {
      uMinorColor: { value: new THREE.Color(GRID.minorColor) },
      uMajorColor: { value: new THREE.Color(GRID.majorColor) },
      uMinorStep: { value: GRID.minorStep },
      uMajorStep: { value: GRID.majorStep },
      uFadeStart: { value: GRID.fadeStart },
      uFadeEnd: { value: GRID.fadeEnd },
      uOpacityMul: { value: 1 },
      uSphereClip: { value: 0 },
      uSphereCenter: { value: new THREE.Vector3(0, 0, 0) },
      uSphereRadius: { value: 25 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1; // 地面最先画,避免遮挡半透明模型边缘
  mesh.name = 'director-grid';

  return {
    mesh,
    material,
    dispose() {
      geo.dispose();
      material.dispose();
    },
  };
}
