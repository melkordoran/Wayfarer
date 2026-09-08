export interface FixtureBone {
  name: string;
  parent: string | null;
  local: number[];
  origin: number[];
  rest: number[];
  offset: number[];
}
export interface FixtureExpectations {
  source: { handedness: string; up: string; units: string };
  static: {
    vertices: number[][];
    faces: number[][];
    materials: number[];
    uv: number[][];
    parent: number[];
    child: number[];
    transformedVertices: number[][];
    bounds: { min: number[]; max: number[] };
    concaveArea: number;
  };
  skinned: {
    vertices: number[][];
    faces: number[][];
    weights: Array<Array<{ bone: string; weight: number }>>;
    bones: FixtureBone[];
    parent: number[];
    bindVertices: number[][];
    elbowWitness: { index: number; bind: number[]; rotated90Z: number[] };
    blendedWitness: { index: number; bind: number[]; rotated90Z: number[] };
  };
  binary: {
    tokenBytes: number;
    countBytes: number;
    stringTerminatorBytes: number;
    endian: string;
    floatBits: number[];
  };
}
export function directXFixtureSources(): {
  staticText: string;
  skinnedText: string;
};
export function directXFixtureExpectations(): FixtureExpectations;
export function directXFixtureAssets(): Map<string, Uint8Array>;
export function directXMalformedFixtures(): Map<string, Uint8Array>;
export function studioDirectXFixtureAssets(): Map<string, Uint8Array>;
export function studioDirectXFixtureExpectations(): FixtureExpectations['skinned'];
export function studioDirectXFixtureJson(): Uint8Array;
export function ensureStudioDirectXFixtures(options?: {
  check?: boolean;
}): number;
export function writeDirectXFixtureAssets(
  destination: string,
  options?: { check?: boolean },
): number;
