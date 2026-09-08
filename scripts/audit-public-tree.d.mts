export interface PublicTreeFinding { path: string; line: number; rule: string }
export interface PublicTreeException extends PublicTreeFinding { sha256: string }
export interface PublicTreeReport {
  passed: boolean;
  mode: 'index' | 'working-tree';
  files: number;
  bytes: number;
  findings: PublicTreeFinding[];
  exceptions: PublicTreeException[];
}
export const PUBLIC_TREE_LIMITS: Readonly<{ files: number; fileBytes: number; totalBytes: number }>;
export function auditPublicTree(options?: { cwd?: string; staged?: boolean }): PublicTreeReport;
