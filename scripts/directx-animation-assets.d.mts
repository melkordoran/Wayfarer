export interface DirectXAnimationExpectations {
  durationMs: number;
  ticksPerSecond: number;
  keyCount: number;
  tracks: Array<{ name: string; axis: number[]; angles: number[][] }>;
  witness: {
    timeMs: number; joint: string; physicalAxis: number[]; physicalDegrees: number;
    sourceWXYZ: number[]; sourceSpacePivot: number[];
    sourceSpacePoint: number[]; sourceSpaceResult: number[];
    sourceSpaceBlendedPoint: number[]; sourceSpaceBlendedResult: number[];
    stressRootPoint: number[]; stressRootResult: number[];
  };
  hold: { fromMs: number; toMs: number; shoulderDegrees: number; elbowDegrees: number; headDegrees: number };
  final: { timeMs: number; allRotationsIdentity: boolean; allTranslationsZero: boolean };
}
export function directXAnimationAssets(): Map<string, Uint8Array>;
export function withDirectXAnimationCatalog(base: Map<string, Uint8Array>): Map<string, Uint8Array>;
export function directXAnimationExpectations(): DirectXAnimationExpectations;
export function directXAnimationStudioBundle(): Record<string, string>;
export function directXAnimationContentType(name: string): string;
export function directXAnimationStudioJson(): string;
export function checkDirectXAnimationStudioBundle(): number;
