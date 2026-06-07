/**
 * createLightFx —— 框架无关的光感/调色后处理管线(three.js,无 React)。
 *
 * 设计目标(见 docs/导演台-光感后处理-集成计划.md):
 * - 全景图编辑器与 3D 导演台**共用同一条管线**(导演台 extraPasses=[],
 *   全景 extraPasses=[畸变])。
 * - 「中性 = 零开销」:曝光≈1 且 辉光/调色全关 → 调用方直接 renderer.render,
 *   不进 composer(最清晰、与现状逐像素一致)。本工厂只在 needsComposer() 为真时
 *   被走 composer 路径。曝光本身在直出路径也生效(renderer.toneMapping)。
 * - 链:RenderPass → ...extra → [DoF] → Bloom → Grade(对比/饱和/色温/暗角/颗粒)→ Output。
 *   单个合并 Grade pass(threejs 最佳实践 postpro-merge-effects)。
 * - 资源释放:dispose() 释放 composer + 所有 pass(memory-dispose-render-targets)。
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js'
import type { Pass } from 'three/addons/postprocessing/Pass.js'
import { LIGHT_FX, resolveToneMapping, type ToneMappingMode } from './lightFxConstants'

export type { ToneMappingMode } from './lightFxConstants'

/** 调色 ShaderPass(线性空间;由后续 OutputPass 统一 tonemap+sRGB). 导出供全景复用同一着色器. */
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uContrast: { value: 1.0 },
    uSaturation: { value: 1.0 },
    uTemperature: { value: 0.0 },
    uVignette: { value: 0.0 },
    uGrain: { value: 0.0 },
    uSeed: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uTemperature;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uSeed;
    varying vec2 vUv;
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;
      // 色温:暖(+)抬 R 压 B,冷(-)反之。
      c.r *= 1.0 + uTemperature * 0.2;
      c.b *= 1.0 - uTemperature * 0.2;
      // 对比度:绕线性中灰 0.18 为支点。
      c = (c - 0.18) * uContrast + 0.18;
      // 饱和度:向亮度灰插值。
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      // 暗角:径向压暗。
      if (uVignette > 0.0) {
        float d = distance(vUv, vec2(0.5));
        c *= 1.0 - uVignette * smoothstep(0.35, 0.78, d);
      }
      // 颗粒:每帧抖动的高频噪声。
      if (uGrain > 0.0) {
        float n = hash(vUv * 1024.0 + uSeed) - 0.5;
        c += n * uGrain;
      }
      gl_FragColor = vec4(max(c, 0.0), tex.a);
    }
  `,
}

export interface LightFxOptions {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.Camera
  width: number
  height: number
  /** 额外 pass(插在 RenderPass 之后、DoF/Bloom 之前). 全景传 [畸变]. */
  extraPasses?: Pass[]
  /** 额外的「需要 composer」判定(全景:曲度≠0). */
  extraNeedsComposer?: () => boolean
}

export interface LightFx {
  readonly composer: EffectComposer
  readonly bloom: UnrealBloomPass
  // ── setters(中性默认;拨离中性才进 composer)──
  setExposure(v: number): void
  setBloom(v: number): void
  setContrast(v: number): void
  setSaturation(v: number): void
  setTemperature(v: number): void
  setVignette(v: number): void
  setGrain(v: number): void
  setToneMapping(mode: ToneMappingMode): void
  setDof(p: { enabled?: boolean; focus?: number; aperture?: number; maxBlur?: number }): void
  // ── 查询 ──
  /** 是否必须走 composer(辉光/调色/DoF/extra 任一启用). */
  needsComposer(): boolean
  /** 把 renderer.toneMapping/exposure 同步到当前参数(直出路径也需要). */
  syncToneMapping(): void
  /** 走 composer 渲染到屏幕(自动按 renderer 当前缓冲尺寸对齐). */
  renderToScreen(): void
  setSize(width: number, height: number): void
  dispose(): void
}

const _db = new THREE.Vector2()

export function createLightFx(opts: LightFxOptions): LightFx {
  const { renderer, scene, camera, width, height } = opts
  const exposure: { v: number } = { v: LIGHT_FX.DEFAULT_EXPOSURE }
  let toneMode: ToneMappingMode = 'auto'

  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(1) // 直接对齐 renderer 的绘制缓冲像素,避免重复缩放
  composer.setSize(width, height)
  // 走 composer 时给中转 RT 开 MSAA(renderer 的 AA 只作用于默认帧缓冲)。
  composer.renderTarget1.samples = 4
  composer.renderTarget2.samples = 4

  composer.addPass(new RenderPass(scene, camera))
  for (const p of opts.extraPasses ?? []) composer.addPass(p)

  // 景深(默认关闭). near=0.01/far=2000 的大场景下用保守参数。
  const bokeh = new BokehPass(scene, camera, {
    focus: 10,
    aperture: 0.0002,
    maxblur: 0.006,
  })
  bokeh.enabled = false
  composer.addPass(bokeh)

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    LIGHT_FX.DEFAULT_BLOOM,
    LIGHT_FX.BLOOM_RADIUS,
    LIGHT_FX.BLOOM_THRESHOLD,
  )
  composer.addPass(bloom)

  const grade = new ShaderPass(GradeShader)
  composer.addPass(grade)

  composer.addPass(new OutputPass())

  let curW = width
  let curH = height

  const gradeActive = () =>
    Math.abs(grade.uniforms.uContrast.value - 1) > LIGHT_FX.EPS ||
    Math.abs(grade.uniforms.uSaturation.value - 1) > LIGHT_FX.EPS ||
    Math.abs(grade.uniforms.uTemperature.value) > LIGHT_FX.EPS ||
    grade.uniforms.uVignette.value > LIGHT_FX.EPS ||
    grade.uniforms.uGrain.value > LIGHT_FX.EPS

  const needsComposer = () =>
    bloom.strength > LIGHT_FX.EPS ||
    gradeActive() ||
    bokeh.enabled ||
    (opts.extraNeedsComposer?.() ?? false)

  const syncToneMapping = () => {
    renderer.toneMappingExposure = exposure.v
    renderer.toneMapping = resolveToneMapping(
      toneMode,
      exposure.v,
      bloom.strength,
      gradeActive(),
    )
  }

  return {
    composer,
    bloom,
    setExposure(v) {
      exposure.v = v
    },
    setBloom(v) {
      bloom.strength = Math.max(0, v)
    },
    setContrast(v) {
      grade.uniforms.uContrast.value = v
    },
    setSaturation(v) {
      grade.uniforms.uSaturation.value = v
    },
    setTemperature(v) {
      grade.uniforms.uTemperature.value = v
    },
    setVignette(v) {
      grade.uniforms.uVignette.value = Math.max(0, v)
    },
    setGrain(v) {
      grade.uniforms.uGrain.value = Math.max(0, v)
    },
    setToneMapping(mode) {
      toneMode = mode
    },
    setDof(p) {
      if (p.enabled != null) bokeh.enabled = p.enabled
      const u = (bokeh as unknown as { uniforms: Record<string, { value: number }> })
        .uniforms
      if (u) {
        if (p.focus != null) u.focus.value = p.focus
        if (p.aperture != null) u.aperture.value = p.aperture
        if (p.maxBlur != null) u.maxblur.value = p.maxBlur
      }
    },
    needsComposer,
    syncToneMapping,
    renderToScreen() {
      syncToneMapping()
      const db = renderer.getDrawingBufferSize(_db)
      if (db.x !== curW || db.y !== curH) {
        composer.setSize(db.x, db.y)
        curW = db.x
        curH = db.y
      }
      if (grade.uniforms.uGrain.value > LIGHT_FX.EPS) {
        grade.uniforms.uSeed.value = (performance.now() % 1000) / 1000
      }
      composer.render()
    },
    setSize(w, h) {
      composer.setSize(w, h)
      curW = w
      curH = h
    },
    dispose() {
      composer.dispose()
      bloom.dispose()
      grade.material.dispose()
      ;(bokeh as unknown as { dispose?: () => void }).dispose?.()
    },
  }
}
