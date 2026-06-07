import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js'
import { buildPanoramaPrompt, type PanoramaMode } from './prompts'
import { usePersistentState } from './usePersistentState'
import { FloatingPanel } from './director/directorFloatingPanel'
import {
  LIGHT_FX,
  LIGHT_FX_VALUE_DEFAULTS,
  resolveToneMapping,
  type LightFxValue,
  type ToneMappingMode,
} from './postfx/lightFxConstants'
import { GradeShader } from './postfx/createLightFx'
import LightFxPanel from './postfx/LightFxPanel'

/**
 * PanoramaEditor —— 360° 等距柱状全景查看器(逆向自 RunningHub 全景节点 + 全景图预览器.html)。
 *
 * - 内翻球 (SphereGeometry.scale(-1,1,1)) + MeshBasicMaterial(map),相机置于球心。
 * - OrbitControls 拖拽看向四周;滚轮调 FOV(而非 dolly)。
 * - 「透视曲度」走后处理:EffectComposer(离屏 SSAA 超采样)→ RenderPass → 桶形/枕形畸变 ShaderPass → OutputPass,最终降采样到 canvas,避免发虚。
 * - 工具栏:截图 / 4视角截图 / 12视角截图 / 重置 / 镜像 / 参考线 / 全景(沉浸⇄平面)。
 * - 截图:1920×1080 输出 → 下载 PNG + 复制到剪贴板 + 可选 onCapture 回流。
 * - 「进入全屏」走浏览器 Fullscreen API,ResizeObserver 跟随容器尺寸。
 */

const SHOT_W = 1920
const SHOT_H = 1080

/**
 * 像素比策略 —— 经实测对比参考站(canvas 2389×1344 @ ~1592×896 CSS ⇒ 像素比恰为
 * window.devicePixelRatio≈1.5,并未超采样)。结论:我们的背缓冲分辨率本就 ≥ 参考站,
 * 发虚不是分辨率不够,而是「曲度后处理」的全屏重采样(畸变 ShaderPass + OutputPass)。
 *
 * 因此改成标准 SSAA:
 * - 输出帧缓冲(canvas)= 显示物理像素(min(dpr, DISPLAY_PR_CAP)),与参考站一致、1:1 清晰。
 * - 离屏后处理 RT = 输出再 ×SUPERSAMPLE,最后一趟 blit 时缩小到 canvas ⇒ 畸变那一次采样
 *   取自更高分辨率源、再做降采样,既抗锯齿又不再发虚。
 * - 两者都受 MAX_BUFFER_EDGE 限幅,防大屏爆显存/超 GL 纹理上限。
 */
const SUPERSAMPLE = 2
const DISPLAY_PR_CAP = 2
const MAX_BUFFER_EDGE = 5120

function clampByEdge(want: number, w: number, h: number): number {
  const longest = Math.max(w, h)
  if (longest * want > MAX_BUFFER_EDGE) return Math.max(1, MAX_BUFFER_EDGE / longest)
  return want
}

/** 输出帧缓冲像素比:对齐显示物理像素即可(参考站做法)。 */
function outputPixelRatio(w: number, h: number): number {
  const dpr = window.devicePixelRatio || 1
  return clampByEdge(Math.min(dpr, DISPLAY_PR_CAP), w, h)
}

/** 离屏后处理像素比:输出 × 超采样,供最终 blit 降采样。 */
function postPixelRatio(w: number, h: number): number {
  const dpr = window.devicePixelRatio || 1
  return clampByEdge(Math.min(dpr, DISPLAY_PR_CAP) * SUPERSAMPLE, w, h)
}

/** 桶形/枕形畸变:curvature 1.0 = 中性(strength 0)。>1 桶形外凸、<1 枕形内凹。 */
const DistortionShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uStrength: { value: 0.0 },
    uAspect: { value: 1.0 },
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
    uniform float uStrength;
    uniform float uAspect;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      c.x *= uAspect;
      float r2 = dot(c, c);
      vec2 d = c * (1.0 + uStrength * r2);
      d.x /= uAspect;
      vec2 uv = clamp(d + 0.5, 0.0, 1.0);
      gl_FragColor = texture2D(tDiffuse, uv);
    }
  `,
}

/** 浮层 UI 样式(glass 按钮 + 滑杆)。色板/圆角取自 DESIGN.md:Cursor Orange #f54e00、md=8px。 */
const PANO_STYLES = /* css */ `
.pano-glass{
  background: rgba(16,16,18,0.55);
  border: 1px solid rgba(255,255,255,0.10);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  backdrop-filter: blur(14px) saturate(1.2);
}
.pano-btn{
  appearance: none;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(30,30,34,0.66);
  color: #e7e7ea;
  border-radius: 8px;
  padding: 8px 13px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
.pano-btn:hover{ background: rgba(46,46,52,0.85); border-color: rgba(255,255,255,0.3); }
.pano-btn:active{ transform: translateY(1px); }
.pano-btn:disabled{ opacity: 0.4; cursor: not-allowed; }
.pano-btn--active{ background: #f54e00; border-color: #f54e00; color: #fff; box-shadow: 0 2px 12px rgba(245,78,0,0.45); }
.pano-btn--active:hover{ background: #d04200; border-color: #d04200; }
.pano-slider{
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 9999px;
  background: rgba(255,255,255,0.18);
  outline: none;
  cursor: pointer;
}
.pano-slider::-webkit-slider-thumb{
  -webkit-appearance: none;
  appearance: none;
  width: 14px; height: 14px;
  border-radius: 9999px;
  background: #f54e00;
  border: 2px solid rgba(255,255,255,0.85);
  box-shadow: 0 1px 4px rgba(0,0,0,0.45);
}
.pano-slider::-webkit-slider-thumb:hover{ background: #d04200; }
`

interface Props {
  imageUrl: string
  theme: 'punk' | 'default'
  /** 截图回流:拿到 PNG dataURL(单帧截图时触发),宿主可存回画布/相册。 */
  onCapture?: (dataUrl: string, meta: { index: number; total: number }) => void
  /** 生成全景:把 360 提示词回填到生成框。缺省则隐藏「生成」Tab。 */
  onInjectPrompt?: (prompt: string) => void
  /** 进入 3D 导演台:把当前全景图作为背景导入。缺省则隐藏入口按钮。 */
  onEnterDirector?: () => void
  /** 是否存在参考图上下文(决定图生图是否可用 / 默认)。 */
  canRef?: boolean
  /** 初始 Tab,默认预览。 */
  initialTab?: 'preview' | 'generate'
  onClose: () => void
}

type SceneRefs = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  composer: EffectComposer
  distortion: ShaderPass
  bokeh: BokehPass
  bloom: UnrealBloomPass
  grade: ShaderPass
  toneMode: ToneMappingMode
  texture: THREE.Texture | null
  sphereMat: THREE.MeshBasicMaterial
  raf: number
}

// 默认值对齐参考站(进入画布初始:FOV 65 / 透视曲度 1.30)。
const DEFAULT_FOV = 65
// 默认中性 = 1.0:直接走 renderer.render(零全屏重采样),与参考站「全景图预览器.html」
// 同构、最清晰。曲度是 opt-in 透视(>1 桶形 / <1 枕形),拨动才接 composer。
const DEFAULT_CURVATURE = 1.0
const MIN_FOV = 30
const MAX_FOV = 110
// 光感(opt-in,默认中性=对齐 HTML 的干净直出):曝光=1 + 辉光=0 时不启用任何后处理调色。
// 用户把曝光/辉光拨离中性,才接 AgX 色调映射 + 高光辉光。
// 阈值/默认值与 3D 导演台共用同一「真源」(postfx/lightFxConstants),保证两端一致。
const DEFAULT_EXPOSURE = LIGHT_FX.DEFAULT_EXPOSURE
const DEFAULT_BLOOM = LIGHT_FX.DEFAULT_BLOOM
const BLOOM_RADIUS = LIGHT_FX.BLOOM_RADIUS
const BLOOM_THRESHOLD = LIGHT_FX.BLOOM_THRESHOLD // 只有接近高光(天空/灯/反光)才起辉,避免整体发灰

export default function PanoramaEditor({
  imageUrl,
  theme,
  onCapture,
  onInjectPrompt,
  onEnterDirector,
  canRef = false,
  initialTab = 'preview',
  onClose,
}: Props) {
  const isPunk = theme === 'punk'
  const containerRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const refs = useRef<SceneRefs | null>(null)

  const canGenerate = !!onInjectPrompt
  const [tab, setTab] = useState<'preview' | 'generate'>(
    canGenerate ? initialTab : 'preview',
  )
  const [genMode, setGenMode] = useState<PanoramaMode>(canRef ? 'img' : 'txt')
  const [style, setStyle] = useState('')
  const [desc, setDesc] = useState('')
  const [supplement, setSupplement] = useState('')

  // 持久化:用户调过的视图参数退出后再进仍保留(各编辑器共用 usePersistentState)。
  const [fov, setFov] = usePersistentState('pano.fov', DEFAULT_FOV)
  const [curvature, setCurvature] = usePersistentState('pano.curvature', DEFAULT_CURVATURE)
  const [guides, setGuides] = usePersistentState('pano.guides', false)
  const [mirror, setMirror] = usePersistentState('pano.mirror', false)
  const [immersive, setImmersive] = usePersistentState('pano.immersive', true)
  // 光感 / 调色:与 3D 导演台共用同一份参数形状(LightFxValue)+ 同一 UI 组件(LightFxPanel)。
  // 全景内壁球为 MeshBasic,IBL 无效 → 面板隐藏 IBL;景深表现为整帧柔焦。
  const [fx, setFx] = usePersistentState<LightFxValue>('pano.fx', { ...LIGHT_FX_VALUE_DEFAULTS })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [textureReady, setTextureReady] = useState(false)
  // 画布有效区域(全屏时按 16:9 letterbox 居中,留黑边;非全屏铺满容器)。
  const [box, setBox] = useState<{ w: number; h: number; left: number; top: number } | null>(null)

  const submitGenerate = useCallback(() => {
    if (!onInjectPrompt) return
    onInjectPrompt(buildPanoramaPrompt(genMode, { style, desc, supplement }))
    onClose()
  }, [onInjectPrompt, genMode, style, desc, supplement, onClose])

  /* ---------------- three init ---------------- */
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const width = mount.clientWidth || 960
    const height = mount.clientHeight || 540

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true, // 截图必需:渲染后仍可 toBlob
      powerPreference: 'high-performance', // 优先独显,撑得起高像素比
    })
    renderer.setPixelRatio(outputPixelRatio(width, height)) // 必须在 setSize 之前(three #2553)
    renderer.setSize(width, height)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    // 默认中性、与参考 HTML 一致(NoToneMapping)。renderFrame 会按光感是否启用动态切到 AgX。
    renderer.toneMapping = THREE.NoToneMapping
    renderer.toneMappingExposure = DEFAULT_EXPOSURE
    renderer.setClearColor(0x000000, 1)
    mount.appendChild(renderer.domElement)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, width / height, 0.1, 1100)
    camera.position.set(0, 0, 0.01)

    const geo = new THREE.SphereGeometry(500, 64, 48)
    geo.scale(-1, 1, 1) // 内翻,纹理映到球内壁
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x222222 })
    const sphere = new THREE.Mesh(geo, sphereMat)
    scene.add(sphere)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.enablePan = false
    controls.enableZoom = false // 缩放交给 FOV 滑杆/滚轮
    controls.rotateSpeed = -0.45 // 负号:拖拽方向 = 视线方向(站在球心内)
    controls.target.set(0, 0, 0)

    // 后处理:render → 畸变 → 输出(色彩管理)。仅在「透视曲度≠1」时启用,
    // 中性时直接 renderer.render(见 renderFrame),避免全屏重采样导致的发虚。
    const composer = new EffectComposer(renderer)
    composer.setPixelRatio(postPixelRatio(width, height)) // 离屏超采样,> 输出像素比 ⇒ 最终降采样
    composer.setSize(width, height)
    // 给 composer 的中转 RT 开 MSAA,曲度生效时也保留抗锯齿(renderer 的 AA 只作用于默认帧缓冲)
    composer.renderTarget1.samples = 4
    composer.renderTarget2.samples = 4
    composer.addPass(new RenderPass(scene, camera))
    const distortion = new ShaderPass(DistortionShader)
    distortion.uniforms.uAspect.value = width / height
    composer.addPass(distortion)
    // 景深(默认关):基于场景深度做 Bokeh 虚化,放在畸变之后、辉光之前。
    // 内壁球深度近似恒定 ⇒ 表现为整帧柔焦(创意软焦),与导演台共用同一 DoF 控件。
    const bokehPass = new BokehPass(scene, camera, { focus: 10, aperture: 0.0002, maxblur: 0.006 })
    bokehPass.enabled = false
    composer.addPass(bokehPass)
    // 高光辉光:在畸变之后、输出之前,线性空间内对高光做泛光,最后由 OutputPass 统一 tonemap+sRGB。
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      DEFAULT_BLOOM,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    )
    composer.addPass(bloomPass)
    // 调色(对比/饱和/色温/暗角/颗粒):与 3D 导演台共用同一 GradeShader。中性时为恒等。
    const gradePass = new ShaderPass(GradeShader)
    gradePass.enabled = false
    composer.addPass(gradePass)
    composer.addPass(new OutputPass())

    refs.current = {
      renderer,
      scene,
      camera,
      controls,
      composer,
      distortion,
      bokeh: bokehPass,
      bloom: bloomPass,
      grade: gradePass,
      toneMode: 'auto',
      texture: null,
      sphereMat,
      raf: 0,
    }

    const animate = () => {
      const s = refs.current
      if (!s) return
      s.raf = requestAnimationFrame(animate)
      s.controls.update()
      renderFrame(s)
    }
    animate()

    // 滚轮 → FOV(代替 dolly)
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setFov((f) => {
        const next = f + (e.deltaY > 0 ? 3 : -3)
        return Math.min(MAX_FOV, Math.max(MIN_FOV, next))
      })
    }
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false })

    // WebGL context 丢失恢复
    const canvas = renderer.domElement
    const onLost = (e: Event) => {
      e.preventDefault()
      const s = refs.current
      if (s) cancelAnimationFrame(s.raf)
    }
    const onRestored = () => animate()
    canvas.addEventListener('webglcontextlost', onLost as EventListener)
    canvas.addEventListener('webglcontextrestored', onRestored)

    return () => {
      const s = refs.current
      renderer.domElement.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('webglcontextlost', onLost as EventListener)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (s) {
        cancelAnimationFrame(s.raf)
        s.controls.dispose()
        s.grade.material.dispose()
        ;(s.bokeh as unknown as { dispose?: () => void }).dispose?.()
        s.composer.dispose()
        s.texture?.dispose()
        sphereMat.dispose()
        geo.dispose()
        s.renderer.forceContextLoss()
        s.renderer.dispose()
      }
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement)
      }
      refs.current = null
    }
  }, [])

  /* ---------------- 纹理加载 / 镜像 ---------------- */
  useEffect(() => {
    const s = refs.current
    if (!s || !imageUrl) return
    setTextureReady(false)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const cur = refs.current
      if (!cur) return
      cur.texture?.dispose()
      const tex = new THREE.Texture(img)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.RepeatWrapping // 镜像靠 repeat.x = -1
      // 成像清晰度对齐参考站「全景图预览器.html」:纯双线性、关 mipmap。
      // 经实测 + three.js #15892:等距柱状贴到球内壁时,mipmap 会让 GPU 选到更糊的
      // mip 级 → 整体发虚;LinearFilter(无 mip)恒采基准级,最锐。
      // (注:无 mipmap 时各向异性无效,故不再设置 anisotropy。)
      tex.generateMipmaps = false
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.needsUpdate = true
      cur.texture = tex
      cur.sphereMat.map = tex
      cur.sphereMat.color.set(0xffffff)
      cur.sphereMat.needsUpdate = true
      setTextureReady(true)
    }
    img.onerror = () => setStatus('图片加载失败')
    img.src = imageUrl
  }, [imageUrl])

  // 镜像:水平翻转纹理
  useEffect(() => {
    const s = refs.current
    if (!s?.texture) return
    s.texture.repeat.x = mirror ? -1 : 1
    s.texture.offset.x = mirror ? 1 : 0
    s.texture.needsUpdate = true
  }, [mirror, textureReady])

  /* ---------------- FOV / 曲度 同步 ---------------- */
  useEffect(() => {
    const s = refs.current
    if (!s) return
    s.camera.fov = fov
    s.camera.updateProjectionMatrix()
  }, [fov])

  useEffect(() => {
    const s = refs.current
    if (!s) return
    s.distortion.uniforms.uStrength.value = (curvature - 1.0) * 1.2
  }, [curvature])

  /* ---------------- 光感 / 调色:把 fx 应用到管线 ---------------- */
  useEffect(() => {
    const s = refs.current
    if (!s) return
    applyPanoFx(s, fx)
  }, [fx])

  // 浅合并补丁(持久化 + 实时应用走同一条 effect)。
  const patchFx = useCallback(
    (p: Partial<LightFxValue>) => setFx((prev) => ({ ...prev, ...p })),
    [setFx],
  )

  /* ---------------- 布局 / letterbox / resize ---------------- */
  // 全屏不再铺满整屏:按 16:9 居中、四周留黑边(对齐参考站,避免超宽视口浪费像素预算)。
  const layout = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const cw = container.clientWidth || 1
    const ch = container.clientHeight || 1
    const fs = document.fullscreenElement === container
    let w = cw
    let h = ch
    let left = 0
    let top = 0
    if (fs) {
      const target = 16 / 9
      if (cw / ch > target) {
        h = ch
        w = Math.round(ch * target)
      } else {
        w = cw
        h = Math.round(cw / target)
      }
      left = Math.round((cw - w) / 2)
      top = Math.round((ch - h) / 2)
    }
    setBox({ w, h, left, top })

    const s = refs.current
    if (s) {
      s.renderer.setPixelRatio(outputPixelRatio(w, h))
      s.composer.setPixelRatio(postPixelRatio(w, h)) // 离屏超采样
      s.renderer.setSize(w, h, false) // false:不改 canvas 内联样式(canvas 100% 填满 mount 盒)
      s.composer.setSize(w, h)
      s.bloom.setSize(w, h)
      s.bokeh.setSize(w, h)
      s.camera.aspect = w / h
      s.camera.updateProjectionMatrix()
      s.distortion.uniforms.uAspect.value = w / h
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    layout()
    const ro = new ResizeObserver(() => layout())
    ro.observe(container)
    return () => ro.disconnect()
  }, [layout])

  /* ---------------- 全屏 ---------------- */
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current)
      layout() // 进/出全屏后重算 letterbox
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [layout])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void el.requestFullscreen?.()
    }
  }, [])

  // ESC 关闭(全屏时让浏览器先吃掉 ESC)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /* ---------------- 截图 ---------------- */
  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [])

  const renderToBlob = useCallback((): Promise<Blob | null> => {
    const s = refs.current
    if (!s) return Promise.resolve(null)
    return new Promise((resolve) => {
      renderFrame(s)
      s.renderer.domElement.toBlob((b) => resolve(b), 'image/png')
    })
  }, [])

  /** 截图核心。total=1 当前视角;否则环绕均分。 */
  const capture = useCallback(
    async (total: number) => {
      const s = refs.current
      if (!s || !textureReady) return
      setStatus(total === 1 ? '截图中…' : `${total} 视角截图中…`)

      // 保存现场
      const prevPR = s.renderer.getPixelRatio()
      const prevSize = new THREE.Vector2()
      s.renderer.getSize(prevSize)
      const prevAspect = s.camera.aspect
      const prevQuat = s.camera.quaternion.clone()
      const prevPos = s.camera.position.clone()
      const prevAutoUpdate = s.controls.enabled

      s.controls.enabled = false
      s.renderer.setPixelRatio(1) // 输出恰为 SHOT_W×SHOT_H
      s.renderer.setSize(SHOT_W, SHOT_H, false)
      s.composer.setPixelRatio(clampByEdge(SUPERSAMPLE, SHOT_W, SHOT_H)) // 截图同样 SSAA 超采样后降采样
      s.composer.setSize(SHOT_W, SHOT_H)
      s.bloom.setSize(SHOT_W, SHOT_H)
      s.bokeh.setSize(SHOT_W, SHOT_H)
      s.camera.aspect = SHOT_W / SHOT_H
      s.distortion.uniforms.uAspect.value = SHOT_W / SHOT_H

      try {
        if (total === 1) {
          s.camera.updateProjectionMatrix()
          const blob = await renderToBlob()
          if (blob) {
            const stamp = Date.now()
            downloadBlob(blob, `panorama-${stamp}.png`)
            try {
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
            } catch {
              /* 剪贴板不可用时静默 */
            }
            if (onCapture) {
              const dataUrl = await blobToDataUrl(blob)
              onCapture(dataUrl, { index: 0, total: 1 })
            }
          }
        } else {
          // 以当前朝向为基准,水平均分环绕
          const dir = new THREE.Vector3()
          s.camera.getWorldDirection(dir)
          const baseYaw = Math.atan2(dir.x, dir.z)
          const step = (Math.PI * 2) / total
          const stamp = Date.now()
          for (let i = 0; i < total; i++) {
            const yaw = baseYaw + step * i
            s.camera.position.set(0, 0, 0)
            s.camera.lookAt(Math.sin(yaw), 0, Math.cos(yaw))
            s.camera.updateProjectionMatrix()
            const blob = await renderToBlob()
            if (blob) {
              const deg = Math.round(((step * i) * 180) / Math.PI)
              downloadBlob(blob, `panorama-${stamp}-${String(i + 1).padStart(2, '0')}-${deg}deg.png`)
              if (onCapture) {
                const dataUrl = await blobToDataUrl(blob)
                onCapture(dataUrl, { index: i, total })
              }
            }
            // 让浏览器有机会落盘,避免一次性触发过多下载
            await new Promise((r) => setTimeout(r, 120))
          }
        }
      } finally {
        // 还原现场
        s.camera.position.copy(prevPos)
        s.camera.quaternion.copy(prevQuat)
        s.camera.aspect = prevAspect
        s.camera.updateProjectionMatrix()
        s.renderer.setPixelRatio(prevPR)
        s.renderer.setSize(prevSize.x, prevSize.y, false)
        // composer 用独立的离屏像素比(超采样),不能跟随 renderer 的 prevPR
        s.composer.setPixelRatio(postPixelRatio(prevSize.x, prevSize.y))
        s.composer.setSize(prevSize.x, prevSize.y)
        s.bloom.setSize(prevSize.x, prevSize.y)
        s.bokeh.setSize(prevSize.x, prevSize.y)
        s.distortion.uniforms.uAspect.value = prevAspect
        s.controls.enabled = prevAutoUpdate
        setStatus('已保存')
        setTimeout(() => setStatus(null), 1500)
      }
    },
    [textureReady, renderToBlob, downloadBlob, onCapture],
  )

  /* ---------------- 重置 ---------------- */
  const reset = useCallback(() => {
    const s = refs.current
    setFov(DEFAULT_FOV)
    setCurvature(DEFAULT_CURVATURE)
    setMirror(false)
    setGuides(false)
    setImmersive(true)
    setFx({ ...LIGHT_FX_VALUE_DEFAULTS })
    if (s) {
      s.camera.position.set(0, 0, 0.01)
      s.camera.lookAt(0, 0, -1)
      s.controls.target.set(0, 0, 0)
      s.controls.update()
    }
  }, [])

  /* ---------------- 样式 ---------------- */
  const accent = '#f54e00' // DESIGN.md primary (Cursor Orange)
  const ink = '#26251e'

  const stageW = isFullscreen ? '100vw' : 'min(92vw, 1280px)'
  const stageH = isFullscreen ? '100vh' : 'min(82vh, 760px)'

  // glass 按钮:基础样式 + hover/active 走 CSS class(内联样式无法表达 :hover)。
  const btnCls = (active: boolean): string => `pano-btn${active ? ' pano-btn--active' : ''}`

  const divider: React.CSSProperties = {
    width: 1,
    alignSelf: 'stretch',
    margin: '2px 2px',
    background: 'rgba(255,255,255,0.12)',
  }

  // 画布/叠层的有效区域:全屏 letterbox 时三者(canvas / 平面图 / 参考线)对齐同一盒子。
  const stageBox: React.CSSProperties = box
    ? { position: 'absolute', left: box.left, top: box.top, width: box.w, height: box.h }
    : { position: 'absolute', inset: 0 }

  // 数值 = 代码面(DESIGN.md:JetBrains Mono),Cursor Orange 高亮。
  const valueChip: React.CSSProperties = {
    minWidth: 46,
    textAlign: 'center',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 500,
    fontSize: 12,
    color: accent,
    background: 'rgba(245,78,0,0.12)',
    border: '1px solid rgba(245,78,0,0.3)',
    borderRadius: 6,
    padding: '3px 7px',
  }

  // 小标签 = caption-uppercase(DESIGN.md:11px / 600 / 0.88px tracking)。
  const capLabel: React.CSSProperties = {
    width: 48,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.88px',
    textTransform: 'uppercase',
    color: '#a09c92',
  }

  const fieldStyle: React.CSSProperties = {
    background: '#0c0c0e',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 8,
    color: '#e7e7ea',
    padding: '8px 10px',
    fontSize: 13,
    outline: 'none',
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: stageW,
        height: stageH,
        background: '#0c0c0e',
        borderRadius: isFullscreen ? 0 : 12,
        overflow: 'hidden',
        border: isPunk ? `3px solid ${ink}` : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <style>{PANO_STYLES}</style>

      {/* 3D 挂载点(全屏 letterbox 居中) */}
      <div ref={mountRef} style={stageBox} />

      {/* Tab 切换:生成 / 预览 */}
      {canGenerate && (
        <div
          className="pano-glass"
          style={{
            position: 'absolute',
            top: 16,
            left: 16,
            display: 'flex',
            gap: 6,
            padding: 4,
            borderRadius: 10,
            zIndex: 13,
          }}
        >
          <button type="button" className={btnCls(tab === 'generate')} onClick={() => setTab('generate')}>
            生成全景
          </button>
          <button type="button" className={btnCls(tab === 'preview')} onClick={() => setTab('preview')}>
            预览
          </button>
        </div>
      )}

      {/* 平面预览(全景关闭时) */}
      {tab === 'preview' && !immersive && (
        <img
          src={imageUrl}
          alt="panorama-flat"
          style={{
            ...stageBox,
            objectFit: 'contain',
            background: '#0c0c0e',
            transform: mirror ? 'scaleX(-1)' : undefined,
            zIndex: 5,
          }}
        />
      )}

      {/* 参考线叠层 */}
      {tab === 'preview' && guides && immersive && (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ ...stageBox, pointerEvents: 'none', zIndex: 6 }}
        >
          <line x1="0" y1="50" x2="100" y2="50" stroke="rgba(245,78,0,0.6)" strokeWidth="0.25" />
          <line x1="33.33" y1="0" x2="33.33" y2="100" stroke="rgba(255,255,255,0.28)" strokeWidth="0.18" />
          <line x1="66.66" y1="0" x2="66.66" y2="100" stroke="rgba(255,255,255,0.28)" strokeWidth="0.18" />
          <line x1="0" y1="33.33" x2="100" y2="33.33" stroke="rgba(255,255,255,0.28)" strokeWidth="0.18" />
          <line x1="0" y1="66.66" x2="100" y2="66.66" stroke="rgba(255,255,255,0.28)" strokeWidth="0.18" />
          <line x1="50" y1="47" x2="50" y2="53" stroke="rgba(245,78,0,0.9)" strokeWidth="0.3" />
          <line x1="47" y1="50" x2="53" y2="50" stroke="rgba(245,78,0,0.9)" strokeWidth="0.3" />
        </svg>
      )}

      {/* 顶部工具栏(预览页) */}
      {tab === 'preview' && (
      <div
        className="pano-glass"
        style={{
          position: 'absolute',
          top: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderRadius: 12,
          zIndex: 10,
          flexWrap: 'wrap',
          maxWidth: '94%',
          justifyContent: 'center',
        }}
        role="toolbar"
      >
        <button type="button" className={btnCls(false)} onClick={() => void capture(1)} disabled={!textureReady}>
          截图
        </button>
        <button type="button" className={btnCls(false)} onClick={() => void capture(4)} disabled={!textureReady}>
          4视角截图
        </button>
        <button type="button" className={btnCls(false)} onClick={() => void capture(12)} disabled={!textureReady}>
          12视角截图
        </button>
        <div style={divider} />
        <button type="button" className={btnCls(false)} onClick={reset}>
          重置
        </button>
        <button type="button" className={btnCls(mirror)} onClick={() => setMirror((v) => !v)}>
          镜像
        </button>
        <button type="button" className={btnCls(guides)} onClick={() => setGuides((v) => !v)}>
          参考线
        </button>
        <button type="button" className={btnCls(immersive)} onClick={() => setImmersive((v) => !v)}>
          全景
        </button>
      </div>
      )}

      {/* 右上:导演台 + 全屏 + 关闭 */}
      <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 8, zIndex: 10 }}>
        {onEnterDirector && (
          <button
            type="button"
            className={btnCls(false)}
            onClick={onEnterDirector}
            title="把当前全景图作为背景,进入 3D 导演台"
          >
            进入导演台
          </button>
        )}
        <button type="button" className={btnCls(isFullscreen)} onClick={toggleFullscreen}>
          {isFullscreen ? '退出全屏' : '进入全屏'}
        </button>
        <button type="button" className={btnCls(false)} onClick={onClose}>
          关闭
        </button>
      </div>

      {/* 底部:视图设置面板(预览页)—— 可拖动 / 可收起浮窗,按 DESIGN.md */}
      {tab === 'preview' && (
      <FloatingPanel
        id="pano-view"
        title="视图设置 // VIEW"
        variant="glass"
        anchor={{ bottom: 16, left: 16 }}
        width={268}
        zIndex={10}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, color: '#e7e7ea' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={capLabel}>FOV</span>
          <input
            type="range"
            className="pano-slider"
            min={MIN_FOV}
            max={MAX_FOV}
            step={1}
            value={fov}
            onChange={(e) => setFov(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={valueChip}>{fov}°</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={capLabel}>曲度</span>
          <input
            type="range"
            className="pano-slider"
            min={0.5}
            max={1.6}
            step={0.01}
            value={curvature}
            onChange={(e) => setCurvature(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={valueChip}>{curvature.toFixed(2)}</span>
        </label>
        {/* 光感 / 调色:与 3D 导演台共用同一组件。全景内壁球为 MeshBasic → 隐藏 IBL。 */}
        <LightFxPanel value={fx} onChange={patchFx} accent="#f54e00" showIbl={false} showDof />
        </div>
      </FloatingPanel>
      )}

      {/* 生成全景表单(生成页) */}
      {tab === 'generate' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(8,8,10,0.72)',
            backdropFilter: 'blur(6px)',
            zIndex: 12,
            padding: 16,
          }}
        >
          <div
            style={{
              width: 'min(520px, 92%)',
              maxHeight: '88%',
              overflow: 'auto',
              background: '#141417',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 14,
              padding: 20,
              color: '#e7e7ea',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.02em' }}>
              生成 360° 全景图
            </div>
            <div style={{ fontSize: 12, color: '#9a9aa0', lineHeight: 1.5 }}>
              注入「等距柱状全景」提示词到生成框,生成后再回到本查看器环视 / 截图。
            </div>

            {/* 模式切换 */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className={btnCls(genMode === 'img')}
                style={{ flex: 1 }}
                disabled={!canRef}
                onClick={() => canRef && setGenMode('img')}
                title={canRef ? '基于当前参考图生成,保持元素不变' : '无参考图,仅可文生图'}
              >
                图生图
              </button>
              <button
                type="button"
                className={btnCls(genMode === 'txt')}
                style={{ flex: 1 }}
                onClick={() => setGenMode('txt')}
              >
                文生图
              </button>
            </div>

            {genMode === 'txt' ? (
              <>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                  <span style={{ color: '#9a9aa0' }}>艺术风格</span>
                  <input
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    placeholder="如:写实风格 / 日式动画 / 赛博朋克"
                    style={fieldStyle}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                  <span style={{ color: '#9a9aa0' }}>场景描述</span>
                  <textarea
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    placeholder="如:现代客厅,落地窗,温馨暖光,木地板…"
                    rows={4}
                    style={{ ...fieldStyle, resize: 'vertical' }}
                  />
                </label>
              </>
            ) : (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                <span style={{ color: '#9a9aa0' }}>补充描述(可空)</span>
                <textarea
                  value={supplement}
                  onChange={(e) => setSupplement(e.target.value)}
                  placeholder="基于当前参考图扩成 360° 全景;可补充氛围/光线/材质要求…"
                  rows={4}
                  style={{ ...fieldStyle, resize: 'vertical' }}
                />
              </label>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" className={btnCls(false)} onClick={() => setTab('preview')}>
                取消
              </button>
              <button type="button" className={btnCls(true)} onClick={submitGenerate}>
                生成全景图
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 状态 toast */}
      {status && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            right: 16,
            padding: '8px 14px',
            borderRadius: 10,
            background: 'rgba(12,12,14,0.7)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: '#fff',
            fontSize: 12,
            zIndex: 10,
            backdropFilter: 'blur(10px)',
          }}
        >
          {status}
        </div>
      )}

      {tab === 'preview' && !textureReady && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#9a9aa0',
            fontSize: 13,
            zIndex: 7,
            pointerEvents: 'none',
          }}
        >
          全景加载中…
        </div>
      )}
    </div>
  )
}

/** 调色是否启用(任一参数偏离中性). 与 createLightFx.gradeActive 同构. */
function panoGradeActive(s: SceneRefs): boolean {
  const g = s.grade.uniforms
  return (
    Math.abs(g.uContrast.value - 1) > LIGHT_FX.EPS ||
    Math.abs(g.uSaturation.value - 1) > LIGHT_FX.EPS ||
    Math.abs(g.uTemperature.value) > LIGHT_FX.EPS ||
    g.uVignette.value > LIGHT_FX.EPS ||
    g.uGrain.value > LIGHT_FX.EPS
  )
}

/** 把统一参数 fx 应用到全景管线(曝光/辉光/调色/景深 + tonemap 模式). */
function applyPanoFx(s: SceneRefs, fx: LightFxValue): void {
  s.renderer.toneMappingExposure = fx.exposure
  s.bloom.strength = Math.max(0, fx.bloom)
  const g = s.grade.uniforms
  g.uContrast.value = fx.contrast
  g.uSaturation.value = fx.saturation
  g.uTemperature.value = fx.temperature
  g.uVignette.value = Math.max(0, fx.vignette)
  g.uGrain.value = Math.max(0, fx.grain)
  s.grade.enabled = panoGradeActive(s)
  s.toneMode = fx.toneMapping
  // 景深:内壁球深度近似恒定 → 整帧柔焦。
  s.bokeh.enabled = fx.dofEnabled
  const u = (s.bokeh as unknown as { uniforms?: Record<string, { value: number }> }).uniforms
  if (u) {
    u.focus.value = fx.dofFocus
    u.aperture.value = fx.dofAperture
    u.maxblur.value = fx.dofMaxBlur
  }
}

/**
 * 成像策略(对齐参考站「全景图预览器.html」):
 * - 中性(曲度≈1 且 辉光≈0 且 无调色 且 无景深)→ 直接 renderer.render,零全屏重采样,最清晰。
 * - 一旦启用曲度/辉光/调色/景深 → 走 composer(SSAA 超采样后降采样,既上特效又不发虚)。
 * - 色调映射:由 fx.toneMapping 决定;'auto' 时复刻全景中性/AgX 自动切换。
 */
function renderFrame(s: SceneRefs) {
  const hasCurvature = Math.abs(s.distortion.uniforms.uStrength.value) > 0.0008
  const hasBloom = s.bloom.strength > LIGHT_FX.EPS
  const gradeActive = panoGradeActive(s)
  const hasDof = s.bokeh.enabled

  // 色调映射决策与导演台共用同一函数。
  const wantTM = resolveToneMapping(s.toneMode, s.renderer.toneMappingExposure, s.bloom.strength, gradeActive)
  if (s.renderer.toneMapping !== wantTM) s.renderer.toneMapping = wantTM

  // 颗粒:每帧抖动种子。
  if (gradeActive && s.grade.uniforms.uGrain.value > LIGHT_FX.EPS) {
    s.grade.uniforms.uSeed.value = (performance.now() % 1000) / 1000
  }

  if (hasCurvature || hasBloom || gradeActive || hasDof) s.composer.render()
  else s.renderer.render(s.scene, s.camera)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = reject
    fr.readAsDataURL(blob)
  })
}
