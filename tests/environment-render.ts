/** Manual real-GPU harness. Vite's production build has only index.html as an
 * entry, so this page and its isolated fixtures are not included in the app. */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { strToU8, zipSync } from 'fflate';
import { EnvironmentController, applyWaterAppearance, type EnvironmentMode } from '../src/renderer/engine/environment';
import { EnvironmentScene } from '../src/renderer/engine/environment-scene';
import type { AssetFetcher } from '../src/renderer/engine/assets';
import { createDemoWorld } from '../src/renderer/engine/demo';
import { originalEnvironmentPng } from './fixtures/environment/textures';
import skyRwx from './fixtures/environment/skybox.rwx?raw';
import groundRwx from './fixtures/environment/ground.rwx?raw';
import prelightRwx from './fixtures/environment/prelight.rwx?raw';
import { parseRwx } from '../src/renderer/engine/rwx';
import { createRwxGroup, disposeModelTree } from '../src/renderer/engine/rwx-mesh';

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id); if (!node) throw new Error(`Missing harness element: ${id}`); return node as T;
}

if (!import.meta.env.DEV) throw new Error('The environment graphics harness is development-only.');

const viewport = element('viewport'), shaderStatus = element('shader-state'), assetsStatus = element('asset-state');
const renderStatus = element('render-state'), errorOutput = element('errors');
const notes = new Set<string>();
let shaderErrors = 0, frames = 0, active = true, requested = 0, answered = 0, sceneUpdates = 0;
function note(message: string) { if (notes.size < 16) notes.add(message); errorOutput.textContent = [...notes].join('\n'); }
function failure(message: string) {
  shaderErrors++; shaderStatus.dataset.state = 'error'; shaderStatus.textContent = `Graphics errors: ${shaderErrors}`; note(message);
}
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 1, .1, 90);
camera.position.set(0, 4, -18); camera.lookAt(0, 3, 6);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.debug.checkShaderErrors = true;
renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
  failure(`Shader compilation/link failure: ${[gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].filter(Boolean).join('\n').slice(0, 4000)}`);
};
renderer.domElement.setAttribute('aria-label', 'Live WebGL environment'); viewport.prepend(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 3, 6); controls.enableDamping = true; controls.maxDistance = 65; controls.minDistance = 2; controls.update();
const ambient = new THREE.AmbientLight(), hemi = new THREE.HemisphereLight('#ffffff', '#3c4147');
const sun = new THREE.DirectionalLight(); sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = sun.shadow.camera.bottom = -45; sun.shadow.camera.right = sun.shadow.camera.top = 45;
scene.add(ambient, hemi, sun, sun.target);
const environment = new EnvironmentController({ scene, camera, ambient, hemi, sun, renderer });
const fixturePath = 'https://environment-fixtures.wayfarer.invalid/';
const fixtures = new Map<string, { bytes: Uint8Array; contentType: string }>([
  [`${fixturePath}models/skybox.zip`, { bytes: zipSync({ 'skybox.rwx': strToU8(skyRwx) }), contentType: 'application/zip' }],
  [`${fixturePath}models/ground.zip`, { bytes: zipSync({ 'ground.rwx': strToU8(groundRwx) }), contentType: 'application/zip' }],
  [`${fixturePath}textures/tint.png`, { bytes: originalEnvironmentPng(), contentType: 'image/png' }],
  [`${fixturePath}textures/stencil.png`, { bytes: originalEnvironmentPng(true), contentType: 'image/png' }],
]);
const asset: AssetFetcher = async url => {
  requested++;
  const fixture = fixtures.get(url);
  if (!fixture) { note('Refused a URL outside the four original fixture assets.'); throw new Error('Fixture asset is not allowlisted.'); }
  answered++;
  return { bytes: new Uint8Array(fixture.bytes), contentType: fixture.contentType };
};
const environmentScene = new EnvironmentScene(scene, asset, () => { sceneUpdates++; }, note);

const ownedGeometry = new Set<THREE.BufferGeometry>(), ownedMaterials = new Set<THREE.Material>();
function mesh(geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial) {
  ownedGeometry.add(geometry); ownedMaterials.add(material);
  const value = new THREE.Mesh(geometry, material); value.castShadow = value.receiveShadow = true; scene.add(value); return value;
}
const base = mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#66716f', roughness: 1 }));
base.rotation.x = -Math.PI / 2; base.position.set(0, -.03, 10); base.castShadow = false;
const columnGeometry = new THREE.BoxGeometry(2.8, 4.5, 2.8);
for (const [x, z, tint] of [[-8, 0, '#d5b47f'], [8, 9, '#789ba4'], [-7, 24, '#c68772'], [6, 43, '#bbc3b9']] as const) {
  const column = mesh(columnGeometry, new THREE.MeshStandardMaterial({ color: tint, roughness: .6 }));
  column.position.set(x, 2.25, z);
}
const sphere = mesh(new THREE.SphereGeometry(2, 32, 20), new THREE.MeshStandardMaterial({ color: '#dfb675', metalness: .25, roughness: .3 })); sphere.position.set(0, 2, 8);
const water = mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#69aaaa', transparent: true, opacity: .55, roughness: .25, metalness: .35, side: THREE.DoubleSide }));
water.rotation.x = -Math.PI / 2; water.castShadow = false; water.receiveShadow = false;
const prelitModel = parseRwx(prelightRwx);
const prelitPanels = createRwxGroup(prelitModel);
const baselinePanels = createRwxGroup({ ...prelitModel, parts: prelitModel.parts.map(part => ({ ...part, prelight: undefined })) });
for (const panels of [prelitPanels, baselinePanels]) { panels.position.z = -2; panels.visible = false; scene.add(panels); }
let panelMode = 0, dark = false;

const settings = {
  ...createDemoWorld().settings, demo: false, name: 'Original graphics fixtures', objectPath: fixturePath,
  skyColor: '#5aa3ae', skyColors: { top: '#407ce0', bottom: '#633582', north: '#36a9a0', south: '#e87e43', east: '#d14a69', west: '#dab853' },
  ambientColor: '#bfbfbf', lightColor: '#fff1d2', lightDirection: { x: .5, y: -1, z: .7 },
  fogEnabled: false, fogColor: '#b8c7c9', fogMin: 8, fogMax: 70,
  ground: '', skybox: '', backdrop: '', repeatingGround: false,
  waterEnabled: false, waterColor: '#69aaaa', waterOpacity: .55, waterLevel: .75,
};
let mode: EnvironmentMode = 'world', view = 0;
function apply() {
  const position = { x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: 0 };
  environment.apply(settings, mode, position); environmentScene.update(settings); applyWaterAppearance(water, settings);
  if (dark) { ambient.intensity = hemi.intensity = sun.intensity = 0; }
  prelitPanels.visible = panelMode === 1; baselinePanels.visible = panelMode === 2;
  element('prelight').textContent = `PRELIGHT panels: ${['off', 'enabled', 'disabled baseline'][panelMode]}`;
  element('prelight').setAttribute('aria-pressed', String(panelMode !== 0));
  element('dark-lighting').textContent = `World lights: ${dark ? 'zero (dark comparison)' : 'authored'}`;
  element('dark-lighting').setAttribute('aria-pressed', String(dark));
  element('six-color').setAttribute('aria-pressed', String(!settings.skybox));
  element('rwx-sky').setAttribute('aria-pressed', String(!!settings.skybox));
  for (const [id, on, label] of [['ground', !!settings.ground, 'RWX ground'], ['fog', settings.fogEnabled, 'Fog'], ['water', settings.waterEnabled, 'Water']] as const) {
    element(id).setAttribute('aria-pressed', String(on)); element(id).textContent = `${label}: ${on ? 'on' : 'off'}`;
  }
  element('preset').setAttribute('aria-pressed', String(mode !== 'world'));
  element('preset').textContent = `Lighting: ${mode === 'world' ? 'follow world' : mode}`;
  element('caption').textContent = `${settings.skybox ? 'Original inward-facing RWX skybox' : 'Six authored cardinal sky colors'} · ${mode === 'world' ? 'world lighting' : `${mode} local lighting`} · fog ${settings.fogEnabled ? 'on' : 'off'}`;
}
element('six-color').onclick = () => { settings.skybox = ''; mode = 'world'; apply(); };
element('rwx-sky').onclick = () => { settings.skybox = 'skybox.rwx'; apply(); };
element('ground').onclick = () => { settings.ground = settings.ground ? '' : 'ground.rwx'; apply(); };
element('fog').onclick = () => { settings.fogEnabled = !settings.fogEnabled; apply(); };
element('water').onclick = () => { settings.waterEnabled = !settings.waterEnabled; apply(); };
element('preset').onclick = () => { const modes: EnvironmentMode[] = ['world', 'day', 'sunset', 'night']; mode = modes[(modes.indexOf(mode) + 1) % modes.length]; apply(); };
element('prelight').onclick = () => { panelMode = (panelMode + 1) % 3; apply(); };
element('dark-lighting').onclick = () => { dark = !dark; apply(); };
element('camera').onclick = () => {
  view = (view + 1) % 4;
  const offsets = [new THREE.Vector3(0, 4, -24), new THREE.Vector3(24, 4, 0), new THREE.Vector3(0, 4, 24), new THREE.Vector3(-24, 4, 0)];
  controls.target.set(0, 3, 6); camera.position.copy(controls.target).add(offsets[view]); camera.lookAt(controls.target); controls.update();
  element('camera').textContent = `View: ${['north (+Z)', 'east (−X)', 'south (−Z)', 'west (+X)'][view]}`; apply();
};
function resize() { const { width, height } = viewport.getBoundingClientRect(); renderer.setSize(Math.max(1, width), Math.max(1, height)); camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix(); }
const observer = new ResizeObserver(resize); observer.observe(viewport); resize(); apply();
const onContextLost = (event: Event) => { event.preventDefault(); failure('WebGL context lost. Reload this isolated page to retry.'); };
renderer.domElement.addEventListener('webglcontextlost', onContextLost);
let animation = 0;
function frame() {
  if (!active) return;
  try {
    controls.update(); environment.follow({ x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: 0 });
    environmentScene.render(renderer, camera, { ambient, hemi, sun }); frames++;
    if (frames % 15 === 1) {
      if (!shaderErrors) { shaderStatus.dataset.state = 'ready'; shaderStatus.textContent = `WebGL rendering · ${frames} frames · 0 shader errors`; }
      assetsStatus.textContent = `Fixture requests: ${answered}/${requested}\nGround meshes: ${environmentScene.collisionMeshes().length}\nScene updates: ${sceneUpdates}`;
      renderStatus.textContent = `Mode: ${mode} · fog: ${!!scene.fog}\nFar plane: ${camera.far} m · water: ${water.visible}\nPRELIGHT panels: ${['off', 'enabled', 'disabled baseline'][panelMode]} · ambient/sun: ${dark ? '0 / 0' : 'authored'}\nGPU geometries: ${renderer.info.memory.geometries}\nGPU textures: ${renderer.info.memory.textures}`;
    }
  } catch (cause) { failure(cause instanceof Error ? cause.message : 'Renderer failure'); return; }
  animation = requestAnimationFrame(frame);
}
animation = requestAnimationFrame(frame);
function dispose() {
  if (!active) return; active = false; cancelAnimationFrame(animation); observer.disconnect(); controls.dispose(); environmentScene.dispose();
  disposeModelTree(prelitPanels); disposeModelTree(baselinePanels);
  ownedGeometry.forEach(value => value.dispose()); ownedMaterials.forEach(value => value.dispose()); scene.clear();
  renderer.domElement.removeEventListener('webglcontextlost', onContextLost); renderer.dispose();
}
window.addEventListener('pagehide', dispose, { once: true });
if (import.meta.hot) import.meta.hot.dispose(dispose);
