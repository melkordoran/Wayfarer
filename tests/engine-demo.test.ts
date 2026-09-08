import { describe, expect, it } from 'vitest';
import { Box3, Mesh } from 'three';
import { makeDemoModel } from '../src/renderer/engine/demo';

describe('Original build palette geometry', () => {
  it('places the 1m cube entirely above its object origin', () => {
    const cube = makeDemoModel('cube');
    const bounds = new Box3().setFromObject(cube);
    expect(bounds.min.toArray()).toEqual([-0.5, 0, -0.5]);
    expect(bounds.max.toArray()).toEqual([0.5, 1, 0.5]);
  });
  it('builds a 4m column with a shaft, base, capital and copper collars', () => {
    const column = makeDemoModel('column');
    const bounds = new Box3().setFromObject(column);
    expect(bounds.min.y).toBeCloseTo(0); expect(bounds.max.y).toBeCloseTo(4);
    expect(column.children.filter(child => child instanceof Mesh)).toHaveLength(5);
  });
});
