export const RENDERER_NOTICE_PACKAGES: readonly string[];
export const FRAMEWORK_NOTICE_ELECTRON_VERSION: '44.2.0';
export interface FrameworkNotice {
  readonly name: string;
  readonly file: string;
  readonly revision: string;
  readonly sourceUrl: string;
  readonly bytes: number;
  readonly sha256: string;
}
export const FRAMEWORK_NOTICES: readonly FrameworkNotice[];
export interface OmnibusNotice {
  readonly name: string;
  readonly revision: string;
  readonly sourceUrl: string;
  readonly normalizedSha256: string;
}
export const SQUIRREL_OMNIBUS_NOTICE: Readonly<OmnibusNotice>;
export interface ReleaseNoticeReport {
  passed: true;
  app: string;
  version: string;
  dependencies: Array<{ name: string; version: string; license: string }>;
  frameworkNotices: readonly FrameworkNotice[];
  omnibusNotices: readonly OmnibusNotice[];
  matchedNotices: Array<{ source: string; packaged: string; bytes: number; sha256: string }>;
  coverage: string;
  limits: string;
}
export function verifyReleaseNotices(options: { appPath: string; root: string }): ReleaseNoticeReport;
