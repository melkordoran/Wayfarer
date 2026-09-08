import * as THREE from 'three';
import type { Avatar, TerrainTile, WorldObject, WorldSettings } from '../../shared/types';

export function createDemoWorld(): { settings: WorldSettings; objects: WorldObject[]; avatars: Avatar[]; tiles: TerrainTile[] } {
  let id = 1;
  const objects: WorldObject[] = [];
  const add = (model: string, x: number, z: number, yaw = 0, description = '', action = '', data?: object) => objects.push({ id: id++, owner: 1, model: `wayfarer:${model}`, x, y: 0, z, yaw, pitch: 0, roll: 0, description, action, data: data ? JSON.stringify(data) : undefined });
  add('landscape', 0, 0, 0, 'The Commons landscape', 'create solid off');
  add('plaza', 0, 0, 0, 'Limestone plaza', 'create solid off');
  add('fountain', 0, 8, 0, 'The Meridian Fountain — an original Wayfarer sculpture');
  add('pavilion', -16, 18, 0.15, 'The Commons Pavilion');
  add('gallery', 20, 25, -0.22, 'The Atelier · make something here');
  add('arch', 0, 31, 0, 'The North Gate', 'activate teleport 5N 0W');
  add('obelisk', 0, 53, 0, 'A marker for new beginnings');
  add('sign', -8, -19, 0.1, 'Welcome to The Commons', 'activate url https://gitlab.pp16.org/axis');
  add('sign', 12, 12, -0.25, 'ATELIER →', '', { text: 'ATELIER', subtitle: 'A place to begin' });
  for (const [x, z, yaw] of [[-9, -4, Math.PI / 2], [9, -4, -Math.PI / 2], [-9, 9, Math.PI / 2], [9, 9, -Math.PI / 2], [-10, 26, Math.PI / 2], [10, 26, -Math.PI / 2]]) add('bench', x, z, yaw, 'Oak and limestone bench');
  for (const [x, z] of [[-12, -15], [12, -15], [-12, 3], [12, 3], [-12, 24], [12, 24], [-6, 39], [6, 39]]) add('lamp', x, z, 0, 'Commons lantern', 'create solid off');
  for (const [x, z] of [[-13, -8], [13, -8], [-13, 12], [13, 12], [-8, 32], [8, 32]]) add('planter', x, z, 0, 'Garden planter');
  const trees = [[-24, -11], [-21, -3], [-26, 9], [-32, 23], [-25, 34], [-17, 40], [-10, 51], [9, 50], [20, 42], [33, 34], [34, 15], [28, -4], [23, -15], [-28, -28], [29, -29], [-39, 2], [43, 5], [-43, 36], [38, 49], [-30, 57], [25, 66], [-47, 65], [47, 72]];
  trees.forEach(([x, z], i) => add('tree', x, z, i * 1.33, 'A tree in the Commons', '', { variant: i % 4, scale: 0.75 + (i % 5) * 0.12 }));
  for (const [x, z] of [[-35, -9], [34, -17], [42, 29], [-42, 43], [-18, 57]]) add('rock', x, z, x, 'Garden stone');
  const avatars: Avatar[] = [
    { session: -1, citizen: 1, name: 'Juniper', type: 0, gesture: 0, state: 0, x: -4.5, y: 0, z: 7, yaw: 1.3 },
    { session: -2, citizen: 2, name: 'Atlas', type: 1, gesture: 0, state: 0, x: 4, y: 0, z: 17, yaw: -1.2 },
    { session: -3, citizen: 3, name: 'Mira', type: 2, gesture: 0, state: 0, x: -15, y: 0, z: 16, yaw: 2.2 },
  ];
  return {
    settings: { name: 'Commons', title: 'The Commons', welcome: 'A place to meet. A world to make.', objectPath: '', skyColor: '#c8d6d1', fogColor: '#c8d6d1', fogMin: 65, fogMax: 230, ambientColor: '#d5e7ef', lightColor: '#fff0cf', terrainEnabled: true, waterEnabled: false, waterLevel: -1, entry: { x: 0, y: 0, z: -22, yaw: 0, pitch: -0.035 }, canBuild: true, demo: true },
    objects, avatars, tiles: [],
  };
}

function mat(color: string, options: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...options });
}
function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m;
}
function box(w: number, h: number, d: number, material: THREE.Material, x = 0, y = h / 2, z = 0) { return mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z); }
function label(text: string, subtitle: string, width = 3.8, height = 1.5) {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 384;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#234f45'; ctx.fillRect(0, 0, 1024, 384);
  ctx.strokeStyle = '#c6c9ad'; ctx.lineWidth = 3; ctx.strokeRect(22, 22, 980, 340);
  ctx.textAlign = 'center'; ctx.fillStyle = '#f4efdc'; ctx.font = '54px Georgia'; ctx.fillText(text, 512, 172);
  ctx.fillStyle = '#c5d3bf'; ctx.font = '25px sans-serif'; ctx.fillText(subtitle, 512, 246);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ map: texture, roughness: 1, side: THREE.DoubleSide }));
}

/** All showcase geometry and textures are generated here and are original project assets. */
export function makeDemoModel(kind: string, data?: string): THREE.Group {
  const group = new THREE.Group();
  let params: { variant?: number; scale?: number; text?: string; subtitle?: string } = {};
  try { params = data ? JSON.parse(data) : {}; } catch { /* optional appearance only */ }
  const limestone = mat('#d4c7aa');
  const pale = mat('#e8ddc4');
  const dark = mat('#25433d');
  const wood = mat('#97704c');
  const copper = mat('#b96f46', { metalness: 0.3, roughness: 0.6 });
  switch (kind) {
    case 'cube': group.add(box(1, 1, 1, pale, 0, 0.5)); break;
    case 'column': {
      group.add(box(1.6, 0.25, 1.6, limestone, 0, 0.125));
      group.add(mesh(new THREE.CylinderGeometry(0.5, 0.6, 3.5, 16), pale, 0, 2));
      group.add(box(1.5, 0.25, 1.5, limestone, 0, 3.875));
      group.add(mesh(new THREE.CylinderGeometry(0.64, 0.64, 0.08, 16), copper, 0, 0.4));
      group.add(mesh(new THREE.CylinderGeometry(0.54, 0.54, 0.08, 16), copper, 0, 3.6));
      break;
    }
    case 'landscape': {
      const ground = mesh(new THREE.CircleGeometry(500, 96), mat('#688c65')); ground.rotation.x = -Math.PI / 2; ground.position.y = -0.07; ground.castShadow = false; ground.userData.studioTerrainBase = true; group.add(ground);
      const random = (n: number) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
      for (let i = 0; i < 18; i++) {
        const a = i / 18 * Math.PI * 2, distance = 170 + random(i) * 100;
        const hill = mesh(new THREE.SphereGeometry(1, 20, 12), mat(i % 2 ? '#7c947c' : '#789985'), Math.cos(a) * distance, -8, Math.sin(a) * distance + 30);
        hill.scale.set(55 + random(i + 1) * 35, 20 + random(i + 2) * 28, 65); hill.castShadow = false; group.add(hill);
      }
      const pond = mesh(new THREE.CircleGeometry(1, 64), mat('#83b7af', { metalness: 0.4, roughness: 0.25 }), 40, -0.03, -12); pond.rotation.x = -Math.PI / 2; pond.scale.set(11, 22, 1); group.add(pond);
      break;
    }
    case 'plaza': {
      group.add(box(23, 0.06, 64, limestone, 0, -0.01, 5));
      group.add(box(7, 0.07, 43, pale, 0, 0, 41));
      group.add(box(35, 0.06, 9, pale, -12, -0.015, 18));
      group.add(box(30, 0.06, 8, pale, 18, -0.015, 24));
      const line = mat('#b8ad95');
      for (let z = -26; z < 38; z += 2) group.add(box(23, 0.006, 0.025, line, 0, 0.024, z));
      for (let x = -10; x <= 10; x += 2) group.add(box(0.025, 0.006, 64, line, x, 0.024, 5));
      group.add(box(0.12, 0.01, 64, copper, -10.8, 0.03, 5)); group.add(box(0.12, 0.01, 64, copper, 10.8, 0.03, 5));
      break;
    }
    case 'fountain': {
      group.add(mesh(new THREE.CylinderGeometry(4, 4.2, 0.5, 48), limestone, 0, 0.25));
      group.add(mesh(new THREE.CylinderGeometry(3.6, 3.6, 0.13, 48), mat('#619c96', { metalness: 0.55, roughness: 0.2 }), 0, 0.55));
      const rim = mesh(new THREE.TorusGeometry(3.8, 0.22, 8, 64), pale, 0, 0.56); rim.rotation.x = Math.PI / 2; group.add(rim);
      group.add(mesh(new THREE.CylinderGeometry(0.5, 0.8, 1, 8), pale, 0, 1));
      const sculpture = mesh(new THREE.TorusGeometry(1.55, 0.14, 12, 64), copper, 0, 3.0); sculpture.rotation.y = 0.5; group.add(sculpture);
      const inner = mesh(new THREE.TorusGeometry(1.05, 0.09, 10, 48), copper, 0, 3); inner.rotation.y = -0.9; group.add(inner);
      const orb = mesh(new THREE.IcosahedronGeometry(0.36, 2), mat('#e9c88a', { metalness: 0.65, roughness: 0.24 }), 0, 3); group.add(orb);
      break;
    }
    case 'pavilion': {
      group.add(box(13, 0.25, 12, pale, 0, 0.125));
      for (const x of [-5.7, 5.7]) for (const z of [-5, 0, 5]) group.add(box(0.5, 5, 0.5, pale, x, 2.7, z));
      group.add(box(14, 0.42, 13, dark, 0, 5.25));
      for (let x = -6.4; x <= 6.5; x += 0.8) group.add(box(0.16, 0.2, 13, wood, x, 5.6));
      group.add(box(11.4, 2.8, 0.22, mat('#acb4a0'), 0, 1.65, 5));
      const sign = label('THE COMMONS', 'Meet. Explore. Make.', 5.5, 1.8); sign.position.set(0, 3.15, -5.24); sign.rotation.y = Math.PI; group.add(sign);
      for (const x of [-3.5, 3.5]) { group.add(mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.12, 32), wood, x, 1, 0)); group.add(mesh(new THREE.CylinderGeometry(0.1, 0.3, 1, 12), dark, x, 0.5, 0)); }
      break;
    }
    case 'gallery': {
      const wall = mat('#cba88b');
      group.add(box(12, 0.25, 11, pale, 0, 0.125));
      group.add(box(12, 6.3, 0.5, wall, 0, 3.3, 5));
      group.add(box(0.5, 6.3, 11, wall, 5.7, 3.3));
      group.add(box(0.5, 6.3, 11, wall, -5.7, 3.3));
      for (const x of [-4.2, 4.2]) group.add(box(3, 6.3, 0.4, wall, x, 3.3, -5));
      group.add(box(12.7, 0.45, 11.7, pale, 0, 6.6));
      group.add(box(5, 1.2, 0.4, wall, 0, 6, -5));
      const sign = label('ATELIER', 'Build a little possibility', 4, 1.2); sign.position.set(0, 5.35, -5.25); sign.rotation.y = Math.PI; group.add(sign);
      const sculpture = mesh(new THREE.TorusKnotGeometry(1.2, 0.23, 72, 12), copper, 0, 2.8, 1); group.add(sculpture); group.add(box(2, 1, 2, pale, 0, 0.7, 1));
      break;
    }
    case 'arch': {
      for (const x of [-3.9, 3.9]) { group.add(box(1.2, 5.2, 1.2, pale, x, 2.6)); group.add(box(1.7, 0.35, 1.7, limestone, x, 0.175)); }
      const arch = mesh(new THREE.TorusGeometry(3.9, 0.6, 6, 36, Math.PI), pale, 0, 5.2); group.add(arch);
      const inset = mesh(new THREE.TorusGeometry(3.85, 0.06, 8, 36, Math.PI), copper, 0, 5.2, -0.63); group.add(inset);
      break;
    }
    case 'obelisk': {
      group.add(box(3, 0.5, 3, limestone, 0, 0.25));
      group.add(mesh(new THREE.CylinderGeometry(0.3, 0.8, 9, 4), pale, 0, 5));
      const marker = mesh(new THREE.OctahedronGeometry(0.8), copper, 0, 10.1); group.add(marker);
      break;
    }
    case 'tree': {
      const colors = ['#b8ad65', '#bb8750', '#6a9469', '#7e9d75'];
      const leaf = mat(colors[(params.variant ?? 0) % colors.length], { roughness: 1 });
      group.add(mesh(new THREE.CylinderGeometry(0.17, 0.32, 5, 8), mat('#715944'), 0, 2.5));
      for (const [x, y, z, scale] of [[0, 6.6, 0, 2.9], [-1.8, 5.7, 0.3, 2.1], [1.7, 6, 0.4, 2.3], [0.4, 5.8, -1.6, 2.2]]) {
        const crown = mesh(new THREE.IcosahedronGeometry(scale, 2), leaf, x, y, z); crown.scale.y = 1.08; group.add(crown);
      }
      group.scale.setScalar(params.scale ?? 1);
      break;
    }
    case 'planter': {
      group.add(box(2.3, 0.7, 2.3, limestone, 0, 0.35));
      group.add(box(2, 0.06, 2, mat('#5b5640'), 0, 0.73));
      for (let i = 0; i < 7; i++) {
        const angle = i * 2.4;
        group.add(mesh(new THREE.SphereGeometry(0.55, 8, 6), mat(i % 2 ? '#879963' : '#9aaf72'), Math.sin(angle) * 0.55, 0.98, Math.cos(angle) * 0.55));
      }
      break;
    }
    case 'bench': {
      for (const x of [-1.4, 1.4]) group.add(box(0.3, 0.65, 1.1, limestone, x, 0.325));
      for (let i = 0; i < 4; i++) group.add(box(3.8, 0.12, 0.21, wood, 0, 0.72, -0.33 + i * 0.25));
      for (let i = 0; i < 3; i++) group.add(box(3.8, 0.17, 0.12, wood, 0, 1.06 + i * 0.23, 0.5));
      break;
    }
    case 'lamp': {
      group.add(mesh(new THREE.CylinderGeometry(0.07, 0.13, 4, 10), dark, 0, 2));
      group.add(box(0.5, 0.8, 0.5, mat('#ffe5a6', { emissive: '#ffcc74', emissiveIntensity: 0.8 }), 0, 4.2));
      group.add(box(0.7, 0.12, 0.7, dark, 0, 4.65));
      group.add(box(0.6, 0.12, 0.6, dark, 0, 3.75));
      break;
    }
    case 'sign': {
      for (const x of [-1.5, 1.5]) group.add(box(0.13, 2.7, 0.13, dark, x, 1.35));
      const sign = label(params.text ?? 'THE COMMONS', params.subtitle ?? 'A world of possibility'); sign.position.set(0, 2.3, -0.1); sign.rotation.y = Math.PI; group.add(sign);
      break;
    }
    case 'rock': {
      const rock = mesh(new THREE.IcosahedronGeometry(1.5, 1), mat('#a3a692'), 0, 0.6); rock.scale.set(1.6, 0.7, 1); group.add(rock); break;
    }
    default: group.add(box(1, 1, 1, pale));
  }
  // Dispose unused local palette materials; model disposal owns the referenced ones.
  const used = new Set<THREE.Material>(); group.traverse(node => { if (node instanceof THREE.Mesh) (Array.isArray(node.material) ? node.material : [node.material]).forEach(m => used.add(m)); });
  for (const m of [limestone, pale, dark, wood, copper]) if (!used.has(m)) m.dispose();
  return group;
}
