// Browser-side 3D model viewer, bundled separately from the DSH client.
//
// This is the Locus `ModelViewer` path: raw `.fbx` / `.glb` bytes are parsed
// with three.js and drawn in WebGL, so Unity does not need an importer for the
// file and orbiting runs at the browser's frame rate. The main client bundle
// never imports this module; `src/sidebar/routes.js` serves the built file and
// `plugin.js` loads it with a dynamic import the first time a model is opened.
//
// The viewer deliberately mirrors Locus' behavior:
//   * a camera-following key light so every orbit angle stays lit;
//   * `RoomEnvironment` + PMREM for a neutral studio look;
//   * clay / wireframe / grid toggles, animation clips, and model statistics;
//   * external texture references are blocked (only embedded `blob:`/`data:`
//     images are loaded) because a bare ArrayBuffer has no directory context.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

const VIEW_DIRECTION = [1, 0.7, 1]
/** Poses sampled along the first clip to frame the model's whole range of motion. */
const CLIP_FRAMING_SAMPLES = 8
const CLIP_FRAMING_MAX_VERTICES = 400_000
/** Texture slots an FBX material can reference besides the base color map. */
const FBX_AUXILIARY_TEXTURE_SLOTS = [
  'normalMap', 'bumpMap', 'displacementMap', 'aoMap', 'lightMap', 'specularMap',
  'alphaMap', 'envMap', 'metalnessMap', 'roughnessMap', 'emissiveMap',
]

export class ModelPreviewError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ModelPreviewError'
    this.code = code
  }
}

function themeColor(token, fallback) {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return value || fallback
}

function whitePixelDataUrl() {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) return ''
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, 1, 1)
  return canvas.toDataURL('image/png')
}

function materialsOf(mesh) {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

/**
 * Mount one viewer into `container`.
 *
 * The returned API is intentionally small: the React half only needs to feed
 * bytes and flip the same toggles Locus exposes.
 */
export function mount(container, options = {}) {
  const compact = !!options.compact
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.domElement.style.display = 'block'
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(themeColor('--panel-bg', '#101116'))
  const pmrem = new THREE.PMREMGenerator(renderer)
  const environmentTarget = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = environmentTarget.texture
  scene.environmentIntensity = 0.75
  pmrem.dispose()

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000)
  // The key light travels with the camera so every orbit angle stays lit.
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4)
  keyLight.position.set(0.5, 1, 1)
  camera.add(keyLight)
  scene.add(camera)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3d46, 0.5))

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.1
  controls.enablePan = !compact
  controls.enableRotate = !compact
  controls.enableZoom = !compact
  controls.autoRotate = compact
  controls.autoRotateSpeed = 1.2

  const clayMaterial = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.85, metalness: 0 })
  const blockedTextureUrl = whitePixelDataUrl()
  const manager = new THREE.LoadingManager()
  // Textures referenced by file name cannot be resolved from a bare buffer;
  // only embedded (blob/data) images are loaded.
  manager.setURLModifier((url) => (/^(?:blob:|data:)/i.test(url) ? url : blockedTextureUrl))

  let model = null
  let skeletonHelper = null
  let grid = null
  let mixer = null
  let clips = []
  let currentAction = null
  let materialMode = 'original'
  let wireframe = false
  let gridVisible = !compact
  let playing = !compact
  let active = true
  let disposed = false
  let loadToken = 0
  let fitDistance = 1
  let fitTarget = new THREE.Vector3()
  let raf = 0
  let lastFrame = 0
  const originalMaterials = new WeakMap()

  function schedule() {
    if (raf || disposed || !active) return
    raf = requestAnimationFrame(frame)
  }

  function frame(now) {
    raf = 0
    if (disposed) return
    // A hidden tab collapses the container; the resize observer restarts the
    // loop once it is visible again.
    if (container.clientWidth < 1 || container.clientHeight < 1) {
      lastFrame = 0
      return
    }
    const delta = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0
    lastFrame = now
    let again = false
    if (mixer && playing && currentAction) {
      mixer.update(delta)
      again = true
    }
    if (controls.update(delta || null)) again = true
    renderer.render(scene, camera)
    if (again) schedule()
    else lastFrame = 0
  }

  controls.addEventListener('change', schedule)
  renderer.domElement.addEventListener('webglcontextlost', (event) => event.preventDefault())
  renderer.domElement.addEventListener('webglcontextrestored', schedule)
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null
  resizeObserver?.observe(container)
  window.addEventListener('resize', resize)

  function disposeMaterial(material) {
    for (const value of Object.values(material)) {
      if (value && value.isTexture) value.dispose()
    }
    material.dispose()
  }

  function disposeObject(root) {
    root.traverse((child) => {
      if (!child.isMesh) return
      child.geometry.dispose()
      // The clay swap hides the loaded materials, which still need releasing.
      const loaded = originalMaterials.get(child) ?? child.material
      for (const material of Array.isArray(loaded) ? loaded : [loaded]) {
        if (material !== clayMaterial) disposeMaterial(material)
      }
    })
  }

  function clearModel() {
    mixer?.stopAllAction()
    mixer = null
    currentAction = null
    clips = []
    if (skeletonHelper) {
      scene.remove(skeletonHelper)
      skeletonHelper.dispose()
      skeletonHelper = null
    }
    if (grid) {
      scene.remove(grid)
      grid.geometry.dispose()
      grid.material.dispose()
      grid = null
    }
    if (model) {
      scene.remove(model)
      disposeObject(model)
      model = null
    }
  }

  function applyMaterials() {
    model?.traverse((child) => {
      if (!child.isMesh) return
      const original = originalMaterials.get(child)
      if (!original) return
      child.material = materialMode === 'clay' ? clayMaterial : original
      for (const material of materialsOf(child)) {
        material.wireframe = wireframe
        material.needsUpdate = true
      }
    })
  }

  function sanitizeFbxMaterials(root) {
    root.traverse((child) => {
      if (!child.isMesh) return
      for (const material of materialsOf(child)) {
        // Unresolved external textures were replaced by a white pixel, which is
        // only meaningful as a base color; auxiliary maps would distort shading.
        for (const slot of FBX_AUXILIARY_TEXTURE_SLOTS) {
          if (material[slot]) material[slot] = null
        }
        material.needsUpdate = true
      }
    })
  }

  async function parse(buffer, format) {
    if (format === 'fbx') {
      const root = new FBXLoader(manager).parse(buffer, '')
      sanitizeFbxMaterials(root)
      return { root, clips: root.animations ?? [] }
    }
    const loader = new GLTFLoader(manager)
    loader.setMeshoptDecoder(MeshoptDecoder)
    const gltf = await loader.parseAsync(buffer, '')
    return { root: gltf.scene, clips: gltf.animations ?? [] }
  }

  function collectStats(root, box) {
    const materials = new Set()
    const textures = new Set()
    let meshes = 0
    let vertices = 0
    let triangles = 0
    let bones = 0
    root.traverse((child) => {
      if (child.isBone) bones += 1
      if (!child.isMesh) return
      meshes += 1
      const position = child.geometry.getAttribute('position')
      const index = child.geometry.getIndex()
      vertices += position?.count ?? 0
      triangles += Math.floor((index?.count ?? position?.count ?? 0) / 3)
      for (const material of materialsOf(child)) {
        materials.add(material)
        for (const value of Object.values(material)) {
          if (value && value.isTexture) textures.add(value)
        }
      }
    })
    const size = box.getSize(new THREE.Vector3())
    return {
      meshes,
      vertices,
      triangles,
      materials: materials.size,
      textures: textures.size,
      bones,
      size: [size.x, size.y, size.z],
    }
  }

  function frameModel(box) {
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    const radius = Math.max(sphere.radius, 1e-3)
    const verticalFov = THREE.MathUtils.degToRad(camera.fov)
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect)
    fitDistance = (radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * 1.1
    fitTarget = sphere.center.clone()
    camera.near = Math.max(radius / 1000, 1e-4)
    camera.far = fitDistance + radius * 200
    camera.updateProjectionMatrix()
    controls.minDistance = radius * 0.05
    controls.maxDistance = fitDistance * 20
    resetView()

    const maxDim = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1e-3)
    // Grid cells are a power of ten so one cell reads as a round unit (1 m, 10 cm).
    const cell = 10 ** Math.floor(Math.log10(maxDim / 2))
    const divisions = Math.min(60, Math.max(2, Math.round((maxDim * 3) / cell / 2) * 2))
    grid = new THREE.GridHelper(divisions * cell, divisions, 0x8a8f98, 0x8a8f98)
    grid.material.transparent = true
    grid.material.opacity = 0.3
    grid.position.set(sphere.center.x, box.min.y, sphere.center.z)
    grid.visible = gridVisible
    scene.add(grid)
  }

  function selectClipAt(index) {
    if (!mixer || clips.length === 0) return
    const clip = clips[Math.min(Math.max(index, 0), clips.length - 1)]
    currentAction?.stop()
    currentAction = mixer.clipAction(clip)
    currentAction.reset().play()
    mixer.update(0)
    schedule()
  }

  function resetView() {
    const direction = new THREE.Vector3(...VIEW_DIRECTION).normalize()
    camera.position.copy(fitTarget).addScaledVector(direction, fitDistance)
    controls.target.copy(fitTarget)
    camera.lookAt(fitTarget)
    controls.update()
    schedule()
  }

  function resize() {
    const width = container.clientWidth
    const height = container.clientHeight
    if (width < 1 || height < 1) return
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    schedule()
  }

  async function load(buffer, format) {
    const token = ++loadToken
    const superseded = () => disposed || token !== loadToken
    let parsed
    try {
      parsed = await parse(buffer, format)
    } catch (cause) {
      if (superseded()) return null
      const message = cause instanceof Error ? cause.message : String(cause)
      if (/DRACO|KTX2|BASISU|compressed/i.test(message)) {
        throw new ModelPreviewError('unsupportedCompression', message)
      }
      throw new ModelPreviewError('parse', message)
    }
    if (superseded()) {
      disposeObject(parsed.root)
      return null
    }

    clearModel()
    // Fit the camera against the real container size.
    resize()
    model = parsed.root
    model.traverse((child) => {
      if (child.isMesh) originalMaterials.set(child, child.material)
    })
    scene.add(model)

    let hasMesh = false
    model.traverse((child) => {
      if (child.isMesh) hasMesh = true
    })
    if (!hasMesh) {
      // Animation-only assets carry no geometry; show the rig instead.
      skeletonHelper = new THREE.SkeletonHelper(model)
      scene.add(skeletonHelper)
    }
    scene.updateMatrixWorld(true)

    clips = parsed.clips
    if (clips.length) {
      mixer = new THREE.AnimationMixer(model)
      selectClipAt(0)
      if (currentAction) currentAction.paused = !playing
    }
    const { pose, framing } = measureBounds(skeletonHelper ?? model)
    const stats = collectStats(model, pose)
    frameModel(framing)
    applyMaterials()
    resize()
    schedule()
    return { stats, clips: clips.map((clip) => ({ name: clip.name, duration: clip.duration })) }
  }

  /**
   * `pose` is the model at the start of the active clip. `framing` also covers
   * the rest of the clip, so root motion does not walk the model out of view.
   */
  function measureBounds(target) {
    let vertices = 0
    target.traverse((child) => {
      if (child.isMesh) vertices += child.geometry.getAttribute('position')?.count ?? 0
    })
    // Skinned bounds cost one pass over every vertex per sample.
    const sampleCount = mixer && currentAction && currentAction.getClip().duration > 0 && vertices <= CLIP_FRAMING_MAX_VERTICES
      ? CLIP_FRAMING_SAMPLES
      : 1
    const framing = new THREE.Box3()
    let pose = new THREE.Box3()
    for (let index = 0; index < sampleCount; index += 1) {
      if (sampleCount > 1) mixer.setTime((currentAction.getClip().duration * index) / (sampleCount - 1))
      scene.updateMatrixWorld(true)
      const sampled = new THREE.Box3().setFromObject(target, true)
      if (index === 0) pose = sampled.clone()
      framing.union(sampled)
    }
    if (sampleCount > 1) {
      mixer.setTime(0)
      scene.updateMatrixWorld(true)
    }
    for (const box of [pose, framing]) {
      if (box.isEmpty() || !Number.isFinite(box.min.x + box.max.x + box.min.y + box.max.y + box.min.z + box.max.z)) {
        box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5))
      }
    }
    return { pose, framing }
  }

  resize()

  return {
    load,
    setMaterialMode(mode) {
      materialMode = mode
      applyMaterials()
      schedule()
    },
    setWireframe(enabled) {
      wireframe = enabled
      applyMaterials()
      schedule()
    },
    setGridVisible(visible) {
      gridVisible = visible
      if (grid) grid.visible = visible
      schedule()
    },
    setPlaying(next) {
      playing = next
      if (currentAction) currentAction.paused = !next
      schedule()
    },
    selectClip: selectClipAt,
    resetView,
    setActive(next) {
      active = next
      if (!next) {
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        lastFrame = 0
        return
      }
      resize()
      schedule()
    },
    resize,
    dispose() {
      if (disposed) return
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      resizeObserver?.disconnect()
      window.removeEventListener('resize', resize)
      controls.removeEventListener('change', schedule)
      controls.dispose()
      clearModel()
      clayMaterial.dispose()
      environmentTarget.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    },
  }
}
