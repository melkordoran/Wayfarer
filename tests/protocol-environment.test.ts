import { describe, expect, it } from 'vitest';
import { AxisClient } from '../src/main/protocol/axis-client';
import { blob, decode, encode, i32, str, type Field } from '../src/main/protocol/codec';
import { P } from '../src/main/protocol/constants';
import { defaultWorldSettings, mergeWorldSettingsPacket, normalizeWorldSettings, WORLD_ATTRIBUTE as A, WORLD_CAPABILITY as C } from '../src/main/protocol/world-settings';
import type { ClientEvent, WorldSettings } from '../src/shared/types';

/** Exercise the real wire decoder and AxisClient dispatcher with no sockets. */
function setup() {
  const events: ClientEvent[] = [], client = new AxisClient(event => events.push(event));
  Reflect.set(client, 'settings', defaultWorldSettings('Haven'));
  const deliver = (type: number, values: Field[]) => {
    for (const packet of decode(encode(type, values, 4))) Reflect.get(client, 'worldPacket').call(client, packet);
    return Reflect.get(client, 'settings') as WorldSettings;
  };
  const attrs = (values: Record<number, string>, type: number = P.AttributeChange) => deliver(type, Object.entries(values).map(([id, value]) => str(Number(id), value)));
  const caps = (values: Record<number, string>) => attrs(values, P.Capabilities);
  return { client, events, attrs, caps, deliver };
}

describe('Axis environment normalization', () => {
  it('uses pinned Axis defaults, without inventing an external object path or a light intensity', () => {
    const settings = defaultWorldSettings('Haven');
    expect(settings).toMatchObject({ title: 'Untitled', objectPath: '', fogEnabled: false, fogMin: 0, fogMax: 1200, fogColor: '#ffffff',
      skyColor: '#000000', ambientColor: '#bfbfbf', lightColor: '#ffffff', lightDirection: { x: 0, y: 0, z: 0 },
      terrainEnabled: true, terrainOffset: -0.1, terrainAmbient: 1, terrainDiffuse: 0,
      waterEnabled: false, waterLevel: 0, waterOpacity: 0, waterColor: '#000000', waterVisibility: 150,
      allowFlying: true, canFly: true, caretaker: false, owner: false, canBuild: false });
    expect(settings).not.toHaveProperty('lightIntensity');
    settings.lightDirection!.x = 1;
    expect(defaultWorldSettings('Next').lightDirection).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('maps all six cardinal sky colors and leaves vector magnitude unchanged', () => {
    const { attrs } = setup();
    const settings = attrs({ [A.SkyTopRed]: '10', [A.SkyBottomGreen]: '20', [A.SkyNorthBlue]: '30', [A.SkySouthRed]: '40', [A.SkyEastGreen]: '50', [A.SkyWestBlue]: '60',
      [A.LightX]: '-0.8', [A.LightY]: '-0.5', [A.LightZ]: '-0.2', [A.LightRed]: '80', [A.LightGreen]: '90', [A.LightBlue]: '100' }, P.Attributes);
    expect(settings.skyColors).toEqual({ top: '#0a0000', bottom: '#001400', north: '#00001e', south: '#280000', east: '#003200', west: '#00003c' });
    expect(settings.skyColor).toBe('#0a0000'); expect(settings.lightColor).toBe('#505a64');
    expect(settings.lightDirection).toEqual({ x: -0.8, y: -0.5, z: -0.2 });
    expect(Math.hypot(...Object.values(settings.lightDirection!))).not.toBe(1);
  });

  it('preserves partial RGB channels, metadata, entry, fog and capabilities across interleaved packets', () => {
    const { attrs, caps } = setup();
    attrs({ [A.Title]: 'Garden', [A.WelcomeMessage]: 'Welcome', [A.EntryPoint]: '2.9S 1W 0.5a 90', [A.ObjectPath]: 'https://assets.invalid/world/',
      [A.FogRed]: '20', [A.FogMinimum]: '50', [A.FogMaximum]: '700', [A.FogEnable]: 'Y' });
    caps({ [C.Build]: 'Y', [C.Speak]: 'Y' });
    const settings = attrs({ [A.FogGreen]: '30', [A.WaterLevel]: '-1.25' });
    expect(settings).toMatchObject({ title: 'Garden', welcome: 'Welcome', objectPath: 'https://assets.invalid/world/', fogEnabled: true, fogMin: 50, fogMax: 700, fogColor: '#141eff', canBuild: true, canSpeak: true, waterLevel: -1.25 });
    expect(settings.entry).toEqual({ x: 10, y: 5, z: -29, yaw: Math.PI / 2 });
  });

  it('maps authored ground, water and terrain fields with verified units', () => {
    const { attrs } = setup();
    const settings = attrs({ [A.Ground]: 'ground.rwx', [A.RepeatingGround]: 'N', [A.Skybox]: 'sky.rwx', [A.Backdrop]: 'sky.jpg',
      [A.EnableTerrain]: 'Y', [A.TerrainOffset]: '-0.2', [A.TerrainAmbient]: '0.3', [A.TerrainDiffuse]: '0.7', [A.DisableShadows]: 'Y',
      [A.WaterEnabled]: 'Y', [A.WaterLevel]: '12.5', [A.WaterOpacity]: '128', [A.WaterRed]: '12', [A.WaterGreen]: '34', [A.WaterBlue]: '56',
      [A.WaterTexture]: 'top', [A.WaterMask]: 'top-mask', [A.WaterBottomTexture]: 'bottom', [A.WaterBottomMask]: 'bottom-mask',
      [A.WaterUnderTerrain]: 'Y', [A.WaterVisibility]: '250', [A.WaterSpeed]: '1.5', [A.WaterSurfaceMove]: '-0.8', [A.WaterWaveMove]: '0.4' });
    expect(settings).toMatchObject({ ground: 'ground.rwx', repeatingGround: false, skybox: 'sky.rwx', backdrop: 'sky.jpg', terrainOffset: -0.2, terrainAmbient: 0.3, terrainDiffuse: 0.7,
      disableShadows: true, waterEnabled: true, waterLevel: 12.5, waterOpacity: 128 / 255, waterColor: '#0c2238', waterTexture: 'top', waterMask: 'top-mask',
      waterBottomTexture: 'bottom', waterBottomMask: 'bottom-mask', waterUnderTerrain: true, waterVisibility: 250, waterSpeed: 1.5, waterSurfaceMove: -0.8, waterWaveMove: 0.4 });
    expect(settings.environmentWarnings).toEqual([]);
  });

  it.each(['', ' ', 'NaN', 'Infinity', '1e999', '0x10', 'not a number', '1,5', '2.5'])('rejects invalid integer color %j and retains its earlier value', value => {
    const { attrs } = setup(); attrs({ [A.FogRed]: '70' });
    const settings = attrs({ [A.FogRed]: value });
    expect(settings.fogColor).toBe('#46ffff'); expect(settings.environmentWarnings?.join(' ')).toContain('Invalid FogRed');
  });

  it('bounds finite numeric values, without losing authored diagnostic values', () => {
    const { attrs } = setup();
    const settings = attrs({ [A.LightX]: '10', [A.LightY]: '-10', [A.WaterOpacity]: '999', [A.WaterRed]: '-3', [A.WaterLevel]: '9999',
      [A.TerrainOffset]: '-999', [A.TerrainAmbient]: '2', [A.WaterWaveMove]: '-20', [A.Gravity]: '-99', [A.Friction]: '150' });
    expect(settings).toMatchObject({ lightDirection: { x: 1, y: -1, z: 0 }, waterOpacity: 1, waterColor: '#000000', waterLevel: 1000,
      terrainOffset: -320, terrainAmbient: 1, waterWaveMove: -10, gravity: -10, friction: 100 });
    expect(settings.rawAttributes?.[A.WaterOpacity]).toBe('999');
    expect(settings.environmentWarnings?.some(message => message.includes('WaterOpacity was clamped'))).toBe(true);
  });

  it('never disables valid fog after malformed booleans and preserves a valid near/far pair', () => {
    const { attrs } = setup(); attrs({ [A.FogEnable]: 'Y', [A.FogMinimum]: '20', [A.FogMaximum]: '200' });
    let settings = attrs({ [A.FogEnable]: 'maybe', [A.FogMinimum]: '400' });
    expect(settings).toMatchObject({ fogEnabled: true, fogMin: 20, fogMax: 200 });
    expect(settings.environmentWarnings?.join(' ')).toContain('FogMaximum must exceed');
    settings = attrs({ [A.FogEnable]: 'N', [A.FogMaximum]: '600' });
    expect(settings).toMatchObject({ fogEnabled: false, fogMin: 400, fogMax: 600 });
  });
  it('bounds far clipping to the documented 3.4+ fog maximum range even with fog disabled', () => {
    const { attrs } = setup();
    expect(attrs({ [A.FogEnable]: 'N', [A.FogMaximum]: '0' })).toMatchObject({ fogEnabled: false, fogMax: 50 });
    const settings = attrs({ [A.FogMaximum]: '1000000000' });
    expect(settings.fogMax).toBe(1200); expect(settings.environmentWarnings).toContain('FogMaximum was clamped to 50..1200.');
  });

  it.each(['garbage', '9999999999999999999999999999999N 0W'])('retains a safe entry on invalid coordinates %s', entry => {
    const { attrs } = setup(); const original = attrs({ [A.EntryPoint]: '10N 20W' }).entry;
    const settings = attrs({ [A.EntryPoint]: entry }); expect(settings.entry).toEqual(original);
    expect(settings.environmentWarnings).toContain('Invalid EntryPoint coordinates; the previous entry was retained.');
  });

  it('allows explicitly clearing text and the entry point', () => {
    const { attrs } = setup(); attrs({ [A.EntryPoint]: '10N 20W', [A.Ground]: 'old.rwx', [A.Title]: 'Old' });
    expect(attrs({ [A.EntryPoint]: '', [A.Ground]: '', [A.Title]: '' })).toMatchObject({ title: '', ground: '', entry: { x: 0, y: 0, z: 0, yaw: 0 } });
  });
  it('does not confuse malformed NUL-bearing entry text with an intentional empty entry', () => {
    const { attrs, deliver } = setup(); const original = attrs({ [A.EntryPoint]: '10N 20W' }).entry;
    const settings = deliver(P.AttributeChange, [{ id: A.EntryPoint, type: 4, data: Buffer.from('1N\0hidden 2W\0') }]);
    expect(settings.entry).toEqual(original); expect(settings.environmentWarnings?.join(' ')).toContain('Invalid EntryPoint');
  });

  it('retains unsupported shader/color/sprite/cloud metadata without fabricating a color conversion or motion formula', () => {
    const { attrs } = setup();
    const settings = attrs({ [A.WaterUseShaders]: '1', [A.WaterSurfaceColor]: '-16711936', [A.LightTexture]: 'moon', 0x18: 'clouds', 0xba: '2.5' });
    expect(settings.unsupportedEnvironmentAttributes).toMatchObject({ WaterUseShaders: '1', WaterSurfaceColor: '-16711936', LightTexture: 'moon', CloudsLayer1Texture: 'clouds', WaterWave1Speed: '2.5' });
    expect(settings.waterColor).toBe('#000000'); expect(settings.environmentWarnings).toHaveLength(3);
    expect(settings).not.toHaveProperty('waterWaveFrequency');
  });
});

describe('environment rights and bounded packet handling', () => {
  it('applies the documented caretaker exception and recomputes it after partial capability revocation', () => {
    const { attrs, caps } = setup();
    expect(attrs({ [A.AllowFlying]: 'N', [A.AllowPassthru]: 'N', [A.AllowTeleport]: 'N' })).toMatchObject({ allowFlying: false, canFly: false, canPassthru: false, canTeleport: false });
    expect(caps({ [C.Caretaker]: 'Y', [C.Build]: 'N', [C.Speak]: 'N' })).toMatchObject({ caretaker: true, canBuild: true, canSpeak: true, canFly: true, canPassthru: true, canTeleport: true });
    expect(attrs({ [A.FogTinted]: 'Y' })).toMatchObject({ canFly: true, allowFlying: false, fogTinted: true });
    expect(caps({ [C.Caretaker]: 'N' })).toMatchObject({ caretaker: false, canFly: false, canBuild: false, canSpeak: false });
  });
  it('preserves independent capability bits and does not grant caretaker rights from owner alone', () => {
    const { caps, attrs } = setup(); attrs({ [A.AllowFlying]: 'N' });
    caps({ [C.Build]: 'Y', [C.Eject]: 'Y', [C.EminentDomain]: 'N', [C.PublicSpeaker]: 'Y', [C.Owner]: 'Y' });
    expect(caps({ [C.Speak]: 'N' })).toMatchObject({ canBuild: true, canSpeak: false, canEject: true, canUseEminentDomain: false, publicSpeaker: true, owner: true, caretaker: false, canFly: false });
  });
  it('fails closed for malformed capability values instead of preserving a stale grant', () => {
    const { caps, deliver } = setup(); caps({ [C.Build]: 'Y', [C.Speak]: 'Y' });
    expect(caps({ [C.Build]: 'maybe' })).toMatchObject({ canBuild: false, canSpeak: true });
    expect(deliver(P.Capabilities, [i32(C.Speak, 1)])).toMatchObject({ canBuild: false, canSpeak: false });
  });
  it('revokes an oversized malformed capability without disturbing independent valid rights', () => {
    const target = new Map([[C.Caretaker, 'Y'], [C.Build, 'Y']]);
    mergeWorldSettingsPacket(target, { type: P.Capabilities, version: 4, flags: 0, fields: [str(C.Caretaker, 'x'.repeat(8193))] }, true);
    const settings = normalizeWorldSettings(defaultWorldSettings('Test'), new Map([[A.AllowFlying, 'N']]), target);
    expect(settings).toMatchObject({ caretaker: false, canFly: false, canBuild: true });
  });
  it('does not confuse attribute IDs with capability IDs and clears both on leaving', () => {
    const { attrs, caps, client } = setup(); attrs({ [A.AllowAvatarCollision]: 'N' }); caps({ [C.Caretaker]: 'Y' });
    Reflect.get(client, 'clearWorld').call(client);
    expect(Reflect.get(client, 'capabilities').size).toBe(0); expect(Reflect.get(client, 'attributes').size).toBe(0);
    Reflect.set(client, 'settings', defaultWorldSettings('Next'));
    expect(attrs({ [A.AllowFlying]: 'N' })).toMatchObject({ caretaker: false, canFly: false, allowAvatarCollision: true });
  });
  it('does not retain or emit either object-path password, even if encoded as text', () => {
    const { deliver } = setup();
    const settings = deliver(P.Attributes, [blob(A.ObjectPassword, Buffer.from('private-password')), str(A.CavObjectPassword, 'private-cav-password'), str(A.Title, 'Safe')]);
    expect(JSON.stringify(settings)).not.toContain('private'); expect(settings.rawAttributes).toEqual({ [A.Title]: 'Safe' });
    expect(normalizeWorldSettings(defaultWorldSettings('Test'), new Map([[A.ObjectPassword, 'private']])).rawAttributes).toEqual({});
  });
  it('bounds cumulative packet storage and ignores oversized values', () => {
    const target = new Map<number, string>(Array.from({ length: 1024 }, (_, i) => [i + 1000, 'existing']));
    const warnings = mergeWorldSettingsPacket(target, { type: P.Attributes, version: 4, flags: 0, fields: [str(3000, 'extra'), str(1000, 'replacement'), str(1001, 'x'.repeat(8193))] });
    expect(target.size).toBe(1024); expect(target.get(1000)).toBe('replacement'); expect(target.get(1001)).toBe('existing'); expect(target.has(3000)).toBe(false); expect(warnings).toHaveLength(1);
  });
  it('uses the last field when an attribute is repeated within a packet', () => {
    const { deliver } = setup(); expect(deliver(P.Attributes, [str(A.FogRed, '10'), str(A.FogRed, '20')]).fogColor).toBe('#14ffff');
  });
});
