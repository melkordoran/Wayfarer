import { describe, expect, it } from 'vitest';
import { decodeTerrainTexture, isTerrainHoleAt, terrainGeometry, terrainSurface, terrainTextureName } from '../src/renderer/engine/terrain';
import { assetUrls, unpackAsset } from '../src/renderer/engine/assets';
import { zipSync } from 'fflate';

describe('Axis terrain placement', () => {
  it('centres a page around its origin and expands flat height nodes', () => {
    const geometry = terrainGeometry({ pageX: 0, pageZ: 0, nodeX: 0, nodeZ: 0, size: 32, heights: [3.5], textures: [0] });
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.toArray()).toEqual([-640, 3.5, -640]);
    expect(geometry.boundingBox!.max.toArray()).toEqual([-320, 3.5, -320]);
  });
  it('uses eight samples per detailed node regardless of node width', () => {
    const geometry = terrainGeometry({ pageX: 1, pageZ: -1, nodeX: 64, nodeZ: 64, size: 32, heights: Array.from({ length: 64 }, (_, i) => i), textures: [0] });
    const positions = geometry.attributes.position;
    expect(positions.count).toBe(81);
    expect(positions.getY(0)).toBe(0);
    expect(positions.getY(8)).toBe(7);
    expect(positions.getY(80)).toBe(63);
    expect(positions.getX(0)).toBe(1280);
    expect(positions.getZ(0)).toBe(-1280);
  });
  it('decodes documented byte-format texture rotations and holes without guessing extended values', () => {
    expect(decodeTerrainTexture(3 + 64)).toEqual({ index: 3, quarterTurns: 1, hole: false, supported: true });
    expect(decodeTerrainTexture(254).hole).toBe(true);
    expect(decodeTerrainTexture(1024).supported).toBe(false);
    expect(terrainTextureName(3)).toBe('terrain3');
  });
  it('groups cells by image, bakes per-cell rotation, and excludes hole faces', () => {
    const surface = terrainSurface({ pageX: 0, pageZ: 0, nodeX: 64, nodeZ: 64, size: 2, heights: [0], textures: [0, 64, 1, 254] });
    expect(surface.textureIds).toEqual([0, 1]);
    expect(surface.geometry.groups).toEqual([{ start: 0, count: 12, materialIndex: 0 }, { start: 12, count: 6, materialIndex: 1 }]);
    expect(surface.geometry.attributes.position.count).toBe(18);
    const uv = surface.geometry.attributes.uv;
    // First triangle of each adjacent cell begins on its southern/eastern corner; rotation changes UV only.
    expect([uv.getX(0), uv.getY(0)]).toEqual([0, 1]);
    expect([uv.getX(6), uv.getY(6)]).toEqual([1, 1]);
  });
  it('repeats a flat compressed node texture once per 10m cell', () => {
    const surface = terrainSurface({ pageX: 0, pageZ: 0, nodeX: 64, nodeZ: 64, size: 32, heights: [0], textures: [0] });
    const values = Array.from(surface.geometry.attributes.uv.array);
    expect(Math.min(...values)).toBe(0); expect(Math.max(...values)).toBe(32);
  });
  it('identifies holes in world coordinates and keeps them out of neighboring tiles', () => {
    const tile = { pageX: 0, pageZ: 0, nodeX: 64, nodeZ: 64, size: 2, heights: [0], textures: [0, 0, 0, 254] };
    expect(isTerrainHoleAt(tile, 15, 15)).toBe(true);
    expect(isTerrainHoleAt(tile, 5, 15)).toBe(false);
    expect(isTerrainHoleAt(tile, -5, 15)).toBeUndefined();
  });
  it('resolves terrain images through the ordinary object-path JPG/PNG/ZIP fallback', () => {
    expect(assetUrls('https://example.test/world/', terrainTextureName(2), 'textures')).toContain('https://example.test/world/textures/terrain2.zip');
    const original = new Uint8Array([137, 80, 78, 71]);
    expect(unpackAsset(zipSync({ 'terrain2.png': original }), 'texture').bytes).toEqual(original);
  });
});
