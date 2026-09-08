import { describe, expect, it } from 'vitest';
import { WORLD_SETTING_FIELDS as fields, validateWorldSettingsChanges, validateWorldSettingsCommand, worldSettingChanges, worldSettingDraftValue, worldSettingValuesEqual, type WorldSettingsSetCommand } from '../src/shared/world-settings-edit';
import { assertCommand } from '../src/shared/validation';
import { WORLD_ATTRIBUTE as A } from '../src/main/protocol/world-settings';

const field = (key: string) => fields.find(item => item.key === key)!;
const change = (key: string, value: string, raw: Record<number, string> = {}) => worldSettingChanges(field(key), value, raw);
const command = (overrides: Partial<WorldSettingsSetCommand> = {}): WorldSettingsSetCommand => ({ type: 'world-settings-set', requestId: 'request-1', world: 'Haven', session: 12, entryId: 'epoch-1', revision: 3, changes: [{ id: A.Title, before: 'Before', value: 'After' }], ...overrides });
describe('bounded caretaker attribute schema', () => {
  it('contains 50 logical fields and 70 unique known attribute IDs, without rights/passwords', () => {
    expect(fields).toHaveLength(50);
    const ids = fields.flatMap(item => [...item.ids]); expect(ids).toHaveLength(70); expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(Object.values(A)).toContain(id);
    for (const id of [A.ObjectPassword, A.CavObjectPassword, A.TerrainRight, 0x10, 0x2e, 0x13, 0x71]) expect(ids).not.toContain(id);
  });
  it('uses exact Axis color channel order, never packed RGB integers', () => {
    expect(change('ambientColor', '#123456')).toEqual([
      { id: A.AmbientLightRed, before: null, value: '18' }, { id: A.AmbientLightGreen, before: null, value: '52' }, { id: A.AmbientLightBlue, before: null, value: '86' },
    ]);
    expect(change('skyEast', '#010203').map(item => item.id)).toEqual([A.SkyEastRed, A.SkyEastGreen, A.SkyEastBlue]);
    expect(change('waterColor', '#102030').map(item => item.id)).toEqual([A.WaterRed, A.WaterGreen, A.WaterBlue]);
  });
  it('sends only changed channel IDs with exact raw baselines', () => {
    expect(change('fogColor', '#010204', { [A.FogRed]: '001', [A.FogGreen]: '2', [A.FogBlue]: '3' })).toEqual([{ id: A.FogBlue, before: '3', value: '4' }]);
    expect(change('title', 'Before', { [A.Title]: 'Before' })).toEqual([]);
    expect(change('waterLevel', '0.1', { [A.WaterLevel]: '0.100000001' })).toEqual([]);
  });
  it('requires a complete valid raw RGB baseline and never supplies renderer defaults', () => {
    expect(worldSettingDraftValue(field('skyTop'), {})).toBe('');
    expect(worldSettingDraftValue(field('skyTop'), { [A.SkyTopRed]: '256', [A.SkyTopGreen]: '0', [A.SkyTopBlue]: '0' })).toBe('');
    expect(worldSettingDraftValue(field('skyTop'), { [A.SkyTopRed]: '10', [A.SkyTopGreen]: '20', [A.SkyTopBlue]: '30' })).toBe('#0a141e');
  });
  it.each(['ground', 'skybox', 'backdrop', 'waterTexture', 'waterMask', 'waterBottomTexture', 'waterBottomMask'])('hides unsupported %s asset references from inputs', key => {
    const item = field(key);
    for (const value of ['https://user:password@example/model?secret#private', 'nested/model.rwx', '../secret.rwx', '%2Fprivate', 'token@private', '..', '.']) {
      expect(worldSettingDraftValue(item, { [item.ids[0]]: value })).toBe('');
      expect(() => change(key, value)).toThrow();
    }
    expect(change(key, 'tree02.rwx')[0].value).toBe('tree02.rwx'); expect(change(key, '')[0].value).toBe('');
  });
  it('never populates object path replacement, including public paths', () => {
    for (const value of ['', 'https://assets.example/world', 'https://user:password@assets.example/?secret#private']) expect(worldSettingDraftValue(field('objectPath'), { [A.ObjectPath]: value })).toBe('');
    expect(change('objectPath', '')).toEqual([{ id: A.ObjectPath, before: null, value: '' }]);
    expect(change('objectPath', 'https://assets.example/world/', { [A.ObjectPath]: 'https://secret@old.example/?token' })).toEqual([{ id: A.ObjectPath, before: 'https://secret@old.example/?token', value: 'https://assets.example/world/' }]);
  });
  it.each(['file:///tmp/secret', 'ftp://objects.example', 'javascript:alert(1)', 'https://user:password@host/', 'https://host/?token=secret', 'https://host/#secret', 'https://host/?', 'https://host/#', 'https:host', '//host/', ' https://host/', 'https://host/a b', 'https://host\\private', 'https://host/\nsecret'])('rejects unsafe object path without echoing it: %s', value => {
    expect(() => change('objectPath', value)).toThrow();
    try { change('objectPath', value); } catch (error) { expect(String(error)).not.toContain(value); }
  });
  it.each(['0N 0W', '12.5S 7.25E 0.5a 90', '0N 0W -1a -360', '2147483.647N 0E 0a 0'])('accepts bounded entrance syntax %s', value => expect(change('entry', value)[0].value).toBe(value));
  it.each(['', 'https://secret@example/path', '0N', '0N 0W arbitrary', '0N 0N', '0N 0W 361', '2147483.648N 0W', '0N 0W Infinitya', '0N 0W 0a 0 1', '1e9N 0W', '+1N 0W', '0N 0W +90'])('rejects invalid entrance %s', value => expect(() => change('entry', value)).toThrow());
  it.each(['', ' ', 'NaN', 'Infinity', '-Infinity', '0x10', '1,2', '1 2', '1\n', '.'])('rejects nondecimal, empty and nonfinite numeric drafts %s', value => {
    expect(() => change('waterLevel', value)).toThrow(); expect(() => change('fogMin', value)).toThrow();
  });
  it('matches exact server storage types and units', () => {
    expect(change('waterLevel', '1.5')[0].value).toBe('1.5');
    expect(change('waterOpacity', '128')[0].value).toBe('128');
    for (const key of ['fogMin', 'fogMax', 'waterVisibility', 'waterOpacity']) {
      expect(() => change(key, '100.5')).toThrow(); expect(() => change(key, '1e2')).toThrow(); expect(() => change(key, '100.0')).toThrow();
    }
    expect(change('gravity', '-2.5')[0].value).toBe('-2.5');
  });
  it.each(fields.filter(item => item.kind === 'integer' || item.kind === 'float').map(item => [item.key] as const))('enforces editor range for %s', key => {
    const item = field(key);
    expect(() => change(key, String(item.min! - 1))).toThrow(); expect(() => change(key, String(item.max! + 1))).toThrow();
    expect(() => change(key, String(item.min))).not.toThrow(); expect(() => change(key, String(item.max))).not.toThrow();
  });
  it('uses float32 semantics for server readback without tolerance guesses', () => {
    expect(worldSettingValuesEqual(A.WaterLevel, '0.1', String(Math.fround(0.1)))).toBe(true);
    expect(worldSettingValuesEqual(A.WaterLevel, '0.1', '0.10001')).toBe(false);
    expect(worldSettingValuesEqual(A.WaterLevel, '-0', '0')).toBe(true);
    for (const value of ['NaN', 'Infinity', '1001', '']) expect(worldSettingValuesEqual(A.WaterLevel, value, value)).toBe(false);
    expect(worldSettingValuesEqual(A.Title, ' Hello ', 'Hello')).toBe(false);
    expect(worldSettingValuesEqual(A.Title, '1', '01')).toBe(false);
    expect(worldSettingValuesEqual(A.ObjectPassword, 'x', 'x')).toBe(false);
  });
  it('emits Y/N only and refuses to treat unknown authored rules as false', () => {
    expect(change('allowFlying', 'N')[0].value).toBe('N');
    for (const value of ['', 'true', 'false', '1', '0', 'yes']) {
      expect(() => change('allowFlying', value)).toThrow();
      expect(worldSettingDraftValue(field('allowFlying'), { [A.AllowFlying]: value })).toBe('');
    }
  });
  it('allows welcome newlines but rejects controls and malformed Unicode', () => {
    expect(change('welcome', 'Hello\nWorld\t☀')[0].value).toBe('Hello\nWorld\t☀');
    for (const value of ['A\0B', 'A\x1bB', '\ud800', '\udc00']) expect(() => change('welcome', value)).toThrow();
    expect(() => change('title', 'line\nline')).toThrow();
    expect(() => change('title', 'é'.repeat(128))).toThrow(); expect(() => change('welcome', 'é'.repeat(2047))).not.toThrow();
    expect(() => change('welcome', 'x'.repeat(4094))).not.toThrow(); expect(() => change('welcome', 'x'.repeat(4095))).toThrow();
  });
  it('validates both sides only when a fog distance changes', () => {
    const baseline = new Map([[A.FogMinimum, '0'], [A.FogMaximum, '200']]);
    expect(() => validateWorldSettingsChanges(change('fogMin', '199'), baseline)).not.toThrow();
    for (const value of ['200', '201']) expect(() => validateWorldSettingsChanges(change('fogMin', value), baseline)).toThrow('greater');
    expect(() => validateWorldSettingsChanges(change('fogMax', '50'), new Map())).toThrow('both');
    expect(() => validateWorldSettingsChanges([...change('fogMin', '100'), ...change('fogMax', '150')], new Map())).not.toThrow();
    const legacy = new Map([[A.FogMinimum, 'bad'], [A.FogMaximum, '-1'], [A.ObjectPath, 'unsupported']]);
    expect(() => validateWorldSettingsChanges(change('title', 'Safe title'), legacy)).not.toThrow();
    expect(() => validateWorldSettingsChanges(change('fogMin', '0'), legacy)).toThrow();
  });
  it('validates IPC command via the shared dispatcher', () => {
    expect(() => validateWorldSettingsCommand(command())).not.toThrow(); expect(() => assertCommand(command())).not.toThrow();
  });
  it.each([
    { session: 0 }, { session: 1.1 }, { session: Infinity }, { session: 0x80000000 }, { revision: -1 }, { revision: 1.1 }, { revision: NaN },
    { world: '' }, { world: '\0Haven' }, { world: 'é'.repeat(33) }, { entryId: '' }, { entryId: '../secret' }, { requestId: 'bad token' },
    { changes: [] }, { changes: [{ id: A.Title, value: 'After' }] }, { changes: [{ id: A.Title, before: 1, value: 'After' }] },
    { changes: [{ id: A.Title, before: null, value: 'x\0' }] }, { changes: [{ id: A.ObjectPassword, before: null, value: 'x' }] },
    { changes: [{ id: A.TerrainRight, before: null, value: '*' }] }, { changes: [{ id: A.Title, before: null, value: 'x' }, { id: A.Title, before: null, value: 'y' }] },
  ])('rejects malformed or unscoped commands %#', override => expect(() => validateWorldSettingsCommand({ ...command(), ...override })).toThrow());
  it('bounds legacy baselines independently from newly authored strings', () => {
    expect(() => validateWorldSettingsCommand(command({ changes: [{ id: A.Title, before: 'é'.repeat(4097), value: 'After' }] }))).toThrow();
    expect(() => validateWorldSettingsCommand(command({ changes: ['title', 'welcome', 'entry', 'ground', 'objectPath'].map(key => ({ id: field(key).ids[0], before: 'x'.repeat(8192), value: key === 'entry' ? '0N 0W' : '' })) }))).toThrow('32 KiB');
  });
});
