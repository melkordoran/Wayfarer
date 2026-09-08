import * as THREE from 'three';
import type { TerrainTile } from '../../shared/types';

export interface TerrainTexture { index: number; quarterTurns: number; hole: boolean; supported: boolean }
/** The byte-compatible AW terrain representation. Extended 16-bit variants are not silently guessed. */
export function decodeTerrainTexture(value: number): TerrainTexture {
  const supported = Number.isInteger(value) && value >= 0 && value <= 255;
  return { index: supported ? value & 63 : 0, quarterTurns: supported ? (value >>> 6) & 3 : 0, hole: value === 254, supported };
}
export function terrainTextureName(index: number) { return `terrain${index}`; }

function gridWidth(count: number) {
  const grid = Math.round(Math.sqrt(count));
  if (grid < 1 || grid * grid !== count || grid > 128) throw new Error('Invalid terrain sample grid');
  return grid;
}

export type TerrainHeightLookup = (cellX: number, cellZ: number) => number | null;
/** Axis pages are centred on their page coordinates. Detailed nodes carry an 8×8 sample grid. */
export function terrainGeometry(tile: TerrainTile, heightAt?: TerrainHeightLookup): THREE.BufferGeometry {
  if (!Number.isFinite(tile.size) || tile.size < 1 || tile.size > 128) throw new Error('Invalid terrain node size');
  const grid = gridWidth(tile.heights.length), textureGrid = gridWidth(tile.textures.length || 1);
  let segments = Math.max(grid, textureGrid);
  const left = tile.pageX * 128 + tile.nodeX - 64, bottom = tile.pageZ * 128 + tile.nodeZ - 64;
  const ownHeight = (x: number, z: number) => tile.heights[Math.min(grid - 1, Math.floor(z * grid / tile.size)) * grid + Math.min(grid - 1, Math.floor(x * grid / tile.size))];
  // A compressed flat node still needs its last row/column to meet authored
  // neighbouring vertices. Subdivide only when an edge actually differs.
  if (heightAt && segments < tile.size) for (let i = 0; i <= tile.size; i++) {
    const east = heightAt(left + tile.size, bottom + i), north = heightAt(left + i, bottom + tile.size);
    if ((east !== null && east !== ownHeight(tile.size, i)) || (north !== null && north !== ownHeight(i, tile.size))) { segments = tile.size; break; }
  }
  const geometry = new THREE.PlaneGeometry(tile.size * 10, tile.size * 10, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  for (let z = 0; z <= segments; z++) for (let x = 0; x <= segments; x++) {
    const index = Math.min(Math.floor(z * grid / segments), grid - 1) * grid + Math.min(Math.floor(x * grid / segments), grid - 1);
    const adjacent = heightAt?.(left + x * tile.size / segments, bottom + z * tile.size / segments);
    positions.setY(z * (segments + 1) + x, adjacent ?? (Number.isFinite(tile.heights[index]) ? tile.heights[index] : 0));
  }
  geometry.translate((tile.pageX * 128 + tile.nodeX - 64) * 10 + tile.size * 5, 0, (tile.pageZ * 128 + tile.nodeZ - 64) * 10 + tile.size * 5);
  geometry.computeVertexNormals();
  return geometry;
}

export interface TerrainSurface { geometry: THREE.BufferGeometry; textureIds: number[]; unsupportedValues: number[] }
/** Group cells by texture, bake their rotation into UVs, and omit hole triangles from rendering/collision. */
export function terrainSurface(tile: TerrainTile, heightAt?: TerrainHeightLookup): TerrainSurface {
  const base = terrainGeometry(tile, heightAt);
  const grid = Math.round(Math.sqrt(base.attributes.position.count)) - 1;
  const textureGrid = gridWidth(tile.textures.length || 1), span = tile.size / grid;
  const points = base.attributes.position, normals = base.attributes.normal, indices = base.index!;
  const groups = new Map<number, { positions: number[]; normals: number[]; uvs: number[] }>();
  const unsupported = new Set<number>();
  for (let z = 0; z < grid; z++) for (let x = 0; x < grid; x++) {
    const sample = Math.min(textureGrid - 1, Math.floor(z * textureGrid / grid)) * textureGrid + Math.min(textureGrid - 1, Math.floor(x * textureGrid / grid));
    const value = tile.textures[sample] ?? 0, texture = decodeTerrainTexture(value);
    if (!texture.supported) unsupported.add(value);
    if (texture.hole) continue;
    let group = groups.get(texture.index);
    if (!group) { group = { positions: [], normals: [], uvs: [] }; groups.set(texture.index, group); }
    for (let corner = 0; corner < 6; corner++) {
      const vertex = indices.getX((z * grid + x) * 6 + corner);
      const vx = vertex % (grid + 1), vz = Math.floor(vertex / (grid + 1));
      let u = (vx - x) * span, v = (1 - (vz - z)) * span;
      for (let rotation = 0; rotation < texture.quarterTurns; rotation++) [u, v] = [v, span - u];
      group.positions.push(points.getX(vertex), points.getY(vertex), points.getZ(vertex));
      group.normals.push(normals.getX(vertex), normals.getY(vertex), normals.getZ(vertex));
      group.uvs.push(u, v);
    }
  }
  base.dispose();
  const geometry = new THREE.BufferGeometry(), positions: number[] = [], normalValues: number[] = [], uvs: number[] = [];
  const textureIds = [...groups.keys()];
  for (const [materialIndex, texture] of textureIds.entries()) {
    const group = groups.get(texture)!;
    geometry.addGroup(positions.length / 3, group.positions.length / 3, materialIndex);
    for (const value of group.positions) positions.push(value);
    for (const value of group.normals) normalValues.push(value);
    for (const value of group.uvs) uvs.push(value);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normalValues, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return { geometry, textureIds, unsupportedValues: [...unsupported] };
}

export function isTerrainHoleAt(tile: TerrainTile, x: number, z: number): boolean | undefined {
  const left = (tile.pageX * 128 + tile.nodeX - 64) * 10, bottom = (tile.pageZ * 128 + tile.nodeZ - 64) * 10;
  if (x < left || z < bottom || x >= left + tile.size * 10 || z >= bottom + tile.size * 10) return undefined;
  const grid = gridWidth(tile.textures.length || 1);
  const cellX = Math.floor((x - left) / (tile.size * 10) * grid), cellZ = Math.floor((z - bottom) / (tile.size * 10) * grid);
  return decodeTerrainTexture(tile.textures[cellZ * grid + cellX] ?? 0).hole;
}
