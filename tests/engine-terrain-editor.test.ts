// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WorldEngine } from '../src/renderer/engine';
import { TerrainData, terrainKey, validTerrainRegion } from '../src/renderer/engine/terrain-data';
import { TerrainTools } from '../src/renderer/engine/terrain-tools';
import { createDemoWorld } from '../src/renderer/engine/demo';
import type { TerrainTile, WorldSettings } from '../src/shared/types';
import type { TerrainEditRow } from '../src/shared/terrain-edit';

vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    shadowMap = {}; capabilities = { getMaxAnisotropy: () => 1 }; info = { render: { calls: 0, triangles: 0 } };
    setPixelRatio() {} setSize() {} render() {} dispose() {}
  } };
});
const tile = (overrides: Partial<TerrainTile> = {}): TerrainTile => ({ pageX: 0, pageZ: 0, nodeX: 64, nodeZ: 64, size: 8, heights: [0], textures: [0], ...overrides });
const region = { cellX: 0, cellZ: 0, width: 1, depth: 1 };
const row = (overrides: Partial<TerrainEditRow> = {}): TerrainEditRow => ({ cellX: 0, cellZ: 0, heights: [4], textures: [2], ...overrides });
function loadedData(tiles = [tile()]) { const data = new TerrainData(); for (const value of tiles) expect(data.put(value)).toBe(true); for (const value of tiles) data.setComplete(value.pageX, value.pageZ, true); return data; }

describe('Authoritative loaded terrain samples and bounded edit data', () => {
  it('keeps unknown and incomplete cells null; completion cannot invent absent cells', () => {
    const data = new TerrainData();
    expect(data.sample(region)).toEqual([{ cellX: 0, cellZ: 0, height: null, texture: null }]);
    data.put(tile({ heights: [3], textures: [65] }));
    expect(data.heightAt(0, 0)).toBe(3); expect(data.sample(region)[0].height).toBeNull();
    data.setComplete(0, 0, true); expect(data.sample(region)[0]).toEqual({ cellX: 0, cellZ: 0, height: 3, texture: 65 });
    expect(data.sample({ ...region, cellX: 8 })[0].height).toBeNull();
    data.put(tile({ heights: [4] })); expect(data.sample(region)[0].height).toBeNull();
    data.setComplete(0, 0, true); data.deletePages([{ pageX: 0, pageZ: 0 }]);
    data.setComplete(0, 0, true); expect(data.sample(region)[0].height).toBeNull();
  });
  it('maps negative world coordinates and exact page boundaries without rounded ownership', () => {
    const data = loadedData([tile({ pageX: -1, nodeX: 120, heights: [7] }), tile({ nodeX: 0, heights: [8] })]);
    expect(data.sample({ ...region, cellX: -65 })[0].height).toBe(7);
    expect(data.sample({ ...region, cellX: -64 })[0].height).toBe(8);
    expect(data.sample({ ...region, cellX: -56 })[0].height).toBeNull();
  });
  it('expands flat nodes and reads independent exact detail grids in z-major order', () => {
    const source = tile({ heights: Array.from({ length: 64 }, (_, i) => i / 100), textures: [254] });
    const data = loadedData([source]);
    expect(data.sample({ cellX: 6, cellZ: 6, width: 2, depth: 2 }).map(value => [value.height, value.texture])).toEqual([[.54,254],[.55,254],[.62,254],[.63,254]]);
    source.heights[54] = 9; source.textures[0] = 3;
    expect(data.sample({ ...region, cellX: 6, cellZ: 6 })[0].height).toBe(.54);
  });
  it.each([
    { size: 0 }, { size: 129 }, { nodeX: -1 }, { nodeX: 124 }, { heights: [NaN] }, { heights: [.001] },
    { heights: [0,1] }, { textures: [] }, { textures: [-1] }, { textures: [65536] }, { size: 32, heights: Array(64).fill(1) },
  ])('rejects invalid/non-authoritative tile samples without replacing good data: %j', overrides => {
    const data = loadedData(); expect(data.put(tile(overrides))).toBe(false); expect(data.sample(region)[0].height).toBe(0);
  });
  it('rejects overlapping coarse/fine layers instead of z-fighting or shadowing known samples', () => {
    const data = loadedData([tile({ size: 32 })]);
    expect(data.put(tile({ nodeX: 72, size: 8, heights: [4] }))).toBe(false);
    expect(data.tiles.size).toBe(1); expect(data.sample({ ...region, cellX: 8 })[0].height).toBe(0);
  });
  it('patches only selected vertices and texture cells, snapshots arrays, and preserves everything else', () => {
    const data = loadedData(), original = data.tiles.get(terrainKey(tile()))!;
    const rows = [row({ cellX: 1, cellZ: 2, heights: [4,5], textures: [65,254] })];
    const changed = data.patchedTiles(rows, { cellX: 1, cellZ: 2, width: 2, depth: 1 })!;
    expect(changed[0].heights.slice(17,19)).toEqual([4,5]); expect(changed[0].textures.slice(17,19)).toEqual([65,254]);
    expect(changed[0].heights.filter(value => value === 0)).toHaveLength(62);
    rows[0].heights[0] = 22; expect(changed[0].heights[17]).toBe(4);
    expect(original.heights).toEqual([0]); expect(original.textures).toEqual([0]); expect(data.sample(region)[0].height).toBe(0);
  });
  it('supports a bounded rectangle crossing pages while each edited sample must be complete', () => {
    const data = loadedData([tile({ nodeX: 120 }), tile({ pageX: 1, nodeX: 0 })]);
    const selection = { ...region, cellX: 63, width: 2 }, rows = [row({ cellX: 63, heights: [2,3], textures: [1,2] })];
    expect(data.patchedTiles(rows, selection)).toHaveLength(2);
    data.setComplete(1,0,false); expect(data.patchedTiles(rows, selection)).toBeNull();
  });
  it('bounds regions, rows, duplicate cells, centimetres and texture integers before allocating a preview', () => {
    const data = loadedData();
    for (const selection of [{ ...region, width: 9 }, { ...region, depth: 0 }, { ...region, cellX: .5 }, { ...region, cellX: 2147484 }]) expect(validTerrainRegion(selection)).toBe(false);
    for (const rows of [[], [row({ heights: [1,2] })], [row({ heights: [.001] })], [row({ textures: [1.5] })], [row(),row()], [row({ cellX: 1 })], [row({ heights: Array(65).fill(1), textures: Array(65).fill(0) })]]) expect(data.patchedTiles(rows, region)).toBeNull();
    expect(data.tiles.get(terrainKey(tile()))!.heights).toEqual([0]);
  });
});

interface State { terrain: Map<string, THREE.Mesh>; terrainTools: TerrainTools; scene: THREE.Scene; camera: THREE.PerspectiveCamera; collisionMeshes: THREE.Mesh[]; refreshCollisions():void; objects: Map<number,{root:THREE.Group}>; }
const engines: WorldEngine[] = [];
function make(settings: WorldSettings = { ...createDemoWorld().settings, demo: false, objectPath: '', terrainEnabled: true, canEditTerrain: true, terrainOffset: .5 }) {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  Object.defineProperties(canvas, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  canvas.getBoundingClientRect = () => ({ x:0,y:0,left:0,top:0,right:800,bottom:600,width:800,height:600,toJSON(){} });
  const captures = new Set<number>(); canvas.setPointerCapture = id => { captures.add(id); }; canvas.hasPointerCapture = id => captures.has(id);
  canvas.releasePointerCapture = id => { captures.delete(id); };
  canvas.requestPointerLock = vi.fn(async () => {});
  const onTerrainSelect = vi.fn(), onTerrainPreviewCancelled = vi.fn(), onSelect = vi.fn(), asset = vi.fn();
  const engine = new WorldEngine(canvas, { asset, onTerrainSelect, onTerrainPreviewCancelled, onSelect, onTransform: vi.fn(async()=>false), onPosition:vi.fn(),onStats:vi.fn() });
  engines.push(engine); engine.setWorld(settings); engine.setBuildMode(true); engine.setTerrainEditMode(true); canvas.focus();
  return { engine, state: engine as unknown as State, canvas, captures, onTerrainSelect, onTerrainPreviewCancelled, onSelect, asset, settings };
}
function ready(f:ReturnType<typeof make>, tiles = [tile()]) { tiles.forEach(value=>f.engine.setTerrain(value)); tiles.forEach(value=>f.engine.setTerrainPageComplete(value.pageX,value.pageZ,true)); f.engine.setTerrainSelection(region); }
function click(f:ReturnType<typeof make>, extra: Record<string,unknown> = {}) {
  for(const type of ['pointerdown','pointerup']) f.canvas.dispatchEvent(Object.assign(new Event(type), { clientX:400, clientY:300, button:0, pointerId:1, ...extra }));
}
function aim(f:ReturnType<typeof make>, x=5,z=5) { f.state.camera.position.set(x,30,z+25);f.state.camera.lookAt(x,.5,z);f.state.camera.updateMatrixWorld(true); }
function previews(f:ReturnType<typeof make>) { return f.state.scene.children.filter(child=>child.userData.terrainPreview) as THREE.Mesh[]; }
function ysAt(mesh:THREE.Mesh,x:number,z:number) { const p=mesh.geometry.attributes.position;return Array.from({length:p.count},(_,i)=>i).filter(i=>Math.abs(p.getX(i)-x)<.001&&Math.abs(p.getZ(i)-z)<.001).map(i=>p.getY(i)); }
beforeEach(()=>{vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});vi.stubGlobal('requestAnimationFrame',vi.fn(()=>1));vi.stubGlobal('cancelAnimationFrame',vi.fn());Object.defineProperty(document,'pointerLockElement',{configurable:true,value:null,writable:true});});
afterEach(()=>{engines.splice(0).forEach(engine=>engine.dispose());document.body.replaceChildren();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('Real Three terrain editing and resource lifecycle',()=>{
  it('picks a 10m terrain cell through object scenery without object selection, gizmo capture, or pointer lock',()=>{
    const f=make();ready(f);aim(f);f.engine.setObjects([{id:1,owner:1,model:'wayfarer:cube',description:'',action:'',x:5,y:1,z:5,yaw:0,pitch:0,roll:0}]);f.engine.setSelected(1);f.engine.setTransformEnabled(true);f.engine.setTransformMode('translate');
    click(f);expect(f.onTerrainSelect).toHaveBeenCalledExactlyOnceWith({cellX:0,cellZ:0});expect(f.onSelect).not.toHaveBeenCalled();expect(f.captures.size).toBe(0);
    f.canvas.dispatchEvent(new Event('dblclick'));expect(f.canvas.requestPointerLock).not.toHaveBeenCalled();
    expect(f.state.terrainTools.overlay.visible).toBe(true);expect((f.state.terrainTools.overlay.children[1] as THREE.LineSegments).geometry.attributes.position.count).toBe(8);
  });
  it('can select holes but cannot pick the unknown fallback ground',()=>{
    const f=make();ready(f,[tile({textures:[254]})]);aim(f);click(f);expect(f.onTerrainSelect).toHaveBeenCalledTimes(1);
    expect([...f.state.terrain.values()][0].geometry.attributes.position.count).toBe(0);
    aim(f,95,95);click(f);expect(f.onTerrainSelect).toHaveBeenCalledTimes(1);
  });
  it('keeps right-drag camera controls and ignores drag-as-click selection',()=>{
    const f=make();ready(f);aim(f);const before=f.engine.getPosition();
    f.canvas.dispatchEvent(Object.assign(new Event('pointerdown'),{button:2,pointerId:1,clientX:400,clientY:300}));
    f.canvas.dispatchEvent(Object.assign(new Event('pointermove'),{button:-1,buttons:2,pointerId:1,clientX:430,clientY:300,movementX:30,movementY:0}));
    expect(f.engine.getPosition().yaw).not.toBe(before.yaw);expect(f.captures.size).toBe(1);
    f.canvas.dispatchEvent(Object.assign(new Event('pointerup'),{button:2,pointerId:1,clientX:430,clientY:300}));expect(f.captures.size).toBe(0);expect(f.onTerrainSelect).not.toHaveBeenCalled();
    f.canvas.dispatchEvent(Object.assign(new Event('pointerdown'),{button:0,pointerId:1,clientX:400,clientY:300}));
    f.canvas.dispatchEvent(Object.assign(new Event('pointerup'),{button:0,pointerId:1,clientX:430,clientY:300}));expect(f.onTerrainSelect).not.toHaveBeenCalled();
  });
  it('previews owned geometry while preserving canonical samples, arrays, geometry, texture references and collision',()=>{
    const f=make();ready(f);const canonical=[...f.state.terrain.values()][0],geometry=canonical.geometry,material=(canonical.material as THREE.Material[])[0],source=canonical.userData.terrainTile;
    expect(f.engine.previewTerrainRows([row()])).toBe(true);const [preview]=previews(f);
    expect(preview).toBeTruthy();expect(preview.geometry).not.toBe(geometry);expect(ysAt(preview,0,0)).toContain(4);
    expect(canonical.geometry).toBe(geometry);expect(canonical.material).toContain(material);expect(canonical.visible).toBe(false);
    expect(source.heights).toEqual([0]);expect(f.engine.sampleTerrain(region)[0].height).toBe(0);
    f.state.refreshCollisions();expect(f.state.collisionMeshes).toContain(canonical);expect(f.state.collisionMeshes).not.toContain(preview);
    const disposeGeometry=vi.spyOn(preview.geometry,'dispose'),disposeMaterial=vi.spyOn((preview.material as THREE.Material[])[0],'dispose');
    f.engine.cancelTerrainPreview();f.engine.cancelTerrainPreview();expect(disposeGeometry).toHaveBeenCalledTimes(1);expect(disposeMaterial).toHaveBeenCalledTimes(1);
    expect(canonical.visible).toBe(true);expect(canonical.geometry).toBe(geometry);expect(previews(f)).toHaveLength(0);
  });
  it('refuses unknown/incomplete/disabled/out-of-region preview data without destroying a valid current preview',()=>{
    const f=make();f.engine.setTerrain(tile());f.engine.setTerrainSelection(region);expect(f.engine.previewTerrainRows([row()])).toBe(false);
    f.engine.setTerrainPageComplete(0,0,true);expect(f.engine.previewTerrainRows([row()])).toBe(true);const first=previews(f)[0];
    expect(f.engine.previewTerrainRows([row({cellX:8})])).toBe(false);expect(previews(f)[0]).toBe(first);
    f.engine.setTerrainEditMode(false);expect(previews(f)).toHaveLength(0);expect(f.engine.previewTerrainRows([row()])).toBe(false);
  });
  it('does not attach a late texture to disposed preview materials or dispose a cache-owned canonical texture',async()=>{
    const f=make({...createDemoWorld().settings,demo:false,objectPath:'https://assets.invalid/',canEditTerrain:true});
    const canonicalTexture=new THREE.Texture();canonicalTexture.userData.sharedAsset=true;
    const lateTexture=new THREE.Texture();lateTexture.userData.sharedAsset=true;
    let finish!:(texture:THREE.Texture)=>void;
    vi.spyOn(f.engine as unknown as {loadTexture(name:string):Promise<THREE.Texture>},'loadTexture').mockImplementation(name=>name==='terrain0'?Promise.resolve(canonicalTexture):new Promise(resolve=>{finish=resolve;}));
    ready(f);await Promise.resolve();const canonical=[...f.state.terrain.values()][0],canonicalMaterial=(canonical.material as THREE.MeshStandardMaterial[])[0];
    expect(canonicalMaterial.map).toBe(canonicalTexture);const disposeTexture=vi.spyOn(canonicalTexture,'dispose');
    expect(f.engine.previewTerrainRows([row()])).toBe(true);const preview=previews(f)[0],materials=preview.material as THREE.MeshStandardMaterial[];
    f.engine.cancelTerrainPreview();finish(lateTexture);await Promise.resolve();await Promise.resolve();
    expect(materials.every(material=>material.userData.disposed)).toBe(true);expect(materials.every(material=>material.map!==lateTexture)).toBe(true);
    expect(canonicalMaterial.map).toBe(canonicalTexture);expect(disposeTexture).not.toHaveBeenCalled();canonicalTexture.dispose();lateTexture.dispose();
  });
  it('meets neighbouring authored vertices across node borders and refreshes an already-loaded flat edge',()=>{
    const f=make(),left=tile({size:2}),right=tile({nodeX:66,size:2,heights:[5]});f.engine.setTerrain(left);
    const original=f.state.terrain.get(terrainKey(left))!,disposed=vi.spyOn(original.geometry,'dispose');f.engine.setTerrain(right);
    expect(disposed).toHaveBeenCalledTimes(1);expect(ysAt(original,20,0)).toEqual(expect.arrayContaining([5]));
    expect(ysAt(f.state.terrain.get(terrainKey(right))!,20,0)).toEqual(expect.arrayContaining([5]));
    expect(ysAt(original,0,0)).toEqual(expect.arrayContaining([0]));expect(ysAt(original,10,0)).toEqual(expect.arrayContaining([0]));
  });
  it('updates both sides of a preview seam, then restores exact canonical meshes on cancel',()=>{
    const f=make(),left=tile({size:2}),right=tile({nodeX:66,size:2,heights:[5]});ready(f,[left,right]);f.engine.setTerrainSelection({...region,cellX:2});
    const original=f.state.terrain.get(terrainKey(left))!,geometry=original.geometry;
    expect(f.engine.previewTerrainRows([row({cellX:2,heights:[9]})])).toBe(true);
    expect(previews(f)).toHaveLength(2);for(const mesh of previews(f))expect(ysAt(mesh,20,0)).toEqual(expect.arrayContaining([9]));
    f.engine.cancelTerrainPreview();expect(original.geometry).toBe(geometry);expect(ysAt(original,20,0)).toEqual(expect.arrayContaining([5]));
  });
  it.each(['selection','refresh','unload','world','disabled','disposed'])('cancels and disposes a draft on %s without restoring stale state over canonical data',reason=>{
    const f=make();ready(f);f.engine.previewTerrainRows([row()]);const draft=previews(f)[0],dispose=vi.spyOn(draft.geometry,'dispose');
    if(reason==='selection')f.engine.setTerrainSelection({...region,cellX:1});
    if(reason==='refresh')f.engine.setTerrain(tile({heights:[8]}));
    if(reason==='unload')f.engine.unloadSceneData([],[{pageX:0,pageZ:0}]);
    if(reason==='world')f.engine.setWorld({...f.settings,name:'Other'});
    if(reason==='disabled')f.engine.setTerrainEditMode(false);
    if(reason==='disposed')f.engine.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);expect(previews(f)).toHaveLength(0);expect(f.onTerrainPreviewCancelled).toHaveBeenCalledTimes(1);
    if(reason==='refresh'){f.engine.setTerrainPageComplete(0,0,true);expect(f.engine.sampleTerrain(region)[0].height).toBe(8);}
  });
  it('cancels when an adjacent page containing a preview seam unloads, not when a distant page unloads',()=>{
    const f=make(),left=tile({nodeX:120}),right=tile({pageX:1,nodeX:0});ready(f,[left,right]);f.engine.setTerrainSelection({...region,cellX:64});
    expect(f.engine.previewTerrainRows([row({cellX:64})])).toBe(true);expect(previews(f)).toHaveLength(2);
    f.engine.unloadSceneData([],[{pageX:4,pageZ:4}]);expect(previews(f)).toHaveLength(2);
    f.engine.unloadSceneData([],[{pageX:0,pageZ:0}]);expect(previews(f)).toHaveLength(0);expect(f.onTerrainPreviewCancelled).toHaveBeenCalledWith('unloaded');
  });
  it('applies terrainOffset to render/selection only and cancels drafts on environment or permission revocation',()=>{
    const f=make();ready(f);f.engine.previewTerrainRows([row()]);
    expect(previews(f)[0].position.y).toBe(.5);expect(f.engine.sampleTerrain(region)[0].height).toBe(0);
    f.engine.updateWorld({...f.settings,terrainOffset:3});expect(previews(f)).toHaveLength(0);
    expect((f.state.terrainTools.overlay.children[0] as THREE.Mesh).geometry.attributes.position.getY(0)).toBeCloseTo(3.06);
    f.engine.updateWorld({...f.settings,canEditTerrain:false});expect(f.state.terrainTools.active).toBe(false);expect(f.engine.previewTerrainRows([row()])).toBe(false);
  });
  it('keeps canonical surfaces hidden across unrelated world attributes while a visual draft remains active',()=>{
    const f=make();ready(f);f.engine.previewTerrainRows([row()]);const draft=previews(f)[0],canonical=[...f.state.terrain.values()][0];
    f.engine.updateWorld({...f.settings,title:'A new title',fogEnabled:false});
    expect(previews(f)).toEqual([draft]);expect(canonical.visible).toBe(false);expect(f.onTerrainPreviewCancelled).not.toHaveBeenCalled();
    f.engine.cancelTerrainPreview();expect(canonical.visible).toBe(true);
  });
  it('replaces only the tagged Commons flat base after a complete seeded page, keeping hills/pond/object identity',()=>{
    const settings={...createDemoWorld().settings,canEditTerrain:true},f=make(settings),landscape=createDemoWorld().objects[0];f.engine.setObjects([landscape]);
    const root=f.state.objects.get(landscape.id)!.root,model=root.children[0],ground=model.children.find(child=>child.userData.studioTerrainBase)!;
    const siblings=model.children.filter(child=>child!==ground);expect(ground.visible).toBe(true);expect(siblings).toHaveLength(19);
    f.engine.setTerrain(tile({nodeX:0,nodeZ:0,size:128,heights:[-.07]}));expect(ground.visible).toBe(true);
    f.engine.setTerrainPageComplete(0,0,true);expect(ground.visible).toBe(false);expect(siblings.every(child=>child.visible)).toBe(true);expect(f.state.objects.get(landscape.id)!.root).toBe(root);expect(f.asset).not.toHaveBeenCalled();
    f.engine.unloadSceneData([],[{pageX:0,pageZ:0}]);expect(ground.visible).toBe(true);
  });
  it('uses original local studio swatches without recoloring missing network texture fallbacks',()=>{
    const studio=make({...createDemoWorld().settings,canEditTerrain:true});ready(studio);studio.engine.setTerrainSelection({...region,width:4});
    expect(studio.engine.previewTerrainRows([row({heights:[0,0,0,0],textures:[0,1,2,3]})])).toBe(true);
    expect((previews(studio)[0].material as THREE.MeshStandardMaterial[]).map(material=>material.color.getHexString())).toEqual(['688c65','c6b182','8d9693','826b52']);
    const network=make();ready(network);network.engine.setTerrainSelection({...region,width:4});network.engine.previewTerrainRows([row({heights:[0,0,0,0],textures:[0,1,2,3]})]);
    expect((previews(network)[0].material as THREE.MeshStandardMaterial[]).map(material=>material.color.getHexString())).toEqual(['7d936a','7d936a','7d936a','7d936a']);
  });
  it('disposes overlay geometry/material ownership exactly once and keeps input inert after disposal',()=>{
    const f=make();ready(f);const overlay=f.state.terrainTools.overlay,lines=overlay.children[1] as THREE.LineSegments,geometry=lines.geometry,material=lines.material as THREE.LineBasicMaterial;
    const disposeGeometry=vi.spyOn(geometry,'dispose'),disposeMaterial=vi.spyOn(material,'dispose');
    f.engine.dispose();f.engine.dispose();expect(disposeGeometry).toHaveBeenCalledTimes(1);expect(disposeMaterial).toHaveBeenCalledTimes(1);expect(overlay.parent).toBeNull();
    expect(f.engine.previewTerrainRows([row()])).toBe(false);expect(f.engine.sampleTerrain(region)).toEqual([]);click(f);expect(f.onTerrainSelect).not.toHaveBeenCalled();
  });
});
