export interface IsolatedPorts { readonly universe: number; readonly world: number; readonly assets: number }
export type IsolatedAssetProfile = 'baseline' | 'directx' | 'directx-animation';
export interface FixtureCredential { readonly username: string; readonly password: string; readonly citizen: number }
export interface PrimaryComparison { unchanged: boolean; changedFiles: string[]; changedProcesses: string[]; note: string }
export interface IsolatedFixture {
  readonly directory: string; readonly universePort: number; readonly worldPort: number; readonly assetPort: number;
  readonly objectPath: string; readonly world: 'Haven';
  readonly restrictMovement: boolean;
  readonly assetProfile: IsolatedAssetProfile;
  readonly ports: Readonly<IsolatedPorts>; readonly accounts: readonly FixtureCredential[];
  readonly credentials: { readonly wayfarer: FixtureCredential; readonly explorer: FixtureCredential };
  readonly connection: { readonly host: '127.0.0.1'; readonly port: number; readonly tls: false; readonly world: 'Haven' };
  start(): Promise<{ directory: string; processes: { name: string; pid: number; log: string }[] }>;
  stop(): Promise<{ stopped: string[]; refused: string[]; cleanupErrors: string[]; retainedDirectory: string; primary: PrimaryComparison & { report: string } }>;
  registerCleanup(callback: () => void | Promise<void>): () => void;
  verifyPrimary(): PrimaryComparison & { report: string };
  writeReport(name: string, value: unknown): string;
}
export const ISOLATED_PORTS: Readonly<IsolatedPorts>;
export function validateIsolatedPorts(value?: unknown): Readonly<IsolatedPorts>;
export function assertPortsFree(ports: IsolatedPorts): Promise<void>;
export function assertIsolatedDirectory(directory: string, expectedRoot?: string): string;
export function isolatedConfigurations(directory: string, ports: IsolatedPorts, privateKey: string, databasePassword: string, adminPassword: string): { universe: string; attributes: string; world: string };
export function matchesOwnedProcess(record: unknown, currentIdentity: unknown): boolean;
export function comparePrimarySnapshots(before: { files: Record<string, unknown>; processes: Record<string, unknown> }, after: { files: Record<string, unknown>; processes: Record<string, unknown> }): PrimaryComparison;
export function isolatedAssetFiles(profile?: IsolatedAssetProfile): Map<string, Buffer>;
export function createIsolatedFixture(options?: { ports?: IsolatedPorts; restrictMovement?: boolean; assetProfile?: IsolatedAssetProfile }): Promise<IsolatedFixture>;
export const prepareIsolatedAxis: typeof createIsolatedFixture;
export function startIsolatedAxis(fixture: IsolatedFixture): ReturnType<IsolatedFixture['start']>;
export function stopIsolatedAxis(fixture: IsolatedFixture): ReturnType<IsolatedFixture['stop']>;
export function verifyPrimaryUnchanged(fixture: IsolatedFixture): ReturnType<IsolatedFixture['verifyPrimary']>;
export function withIsolatedAxis<T>(callback: (fixture: IsolatedFixture) => Promise<T>, options?: { ports?: IsolatedPorts; restrictMovement?: boolean; assetProfile?: IsolatedAssetProfile }): Promise<T>;
