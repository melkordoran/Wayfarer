import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxisClient } from '../src/main/protocol/axis-client';
import { AxisTransport } from '../src/main/protocol/transport';
import { blob, bytes, encode, i32, num, str, type Field, type Packet } from '../src/main/protocol/codec';
import { P, V } from '../src/main/protocol/constants';
import { axisWorldRightAllows, defaultWorldSettings, mergeWorldSettingsPacket, normalizeWorldSettings, WORLD_ATTRIBUTE, WORLD_CAPABILITY } from '../src/main/protocol/world-settings';
import { assertCommand } from '../src/shared/validation';
import { terrainCellPage, terrainCentimetres, terrainRowPages, TerrainPageSamples, type TerrainSetCommand } from '../src/shared/terrain-edit';
import type { ClientEvent } from '../src/shared/types';

const clients: AxisClient[] = [];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { clients.splice(0).forEach(client => client.disconnect()); vi.restoreAllMocks(); vi.useRealTimers(); });
const command = (changes: Partial<TerrainSetCommand> = {}): TerrainSetCommand => ({ type: 'terrain-set', requestId: 'row-1', world: 'Haven', session: 41,
  cellX: 0, cellZ: 0, heights: [.29, -.12], texture: 65535, previousHeights: [0, 0], previousTextures: [0, 0], ...changes });
function setup() {
  const events: ClientEvent[] = [], packets: Packet[] = [], client = new AxisClient(event => events.push(event)); clients.push(client);
  const world = new AxisTransport(packet => Reflect.get(client, 'worldPacket').call(client, packet));
  Reflect.set(client, 'world', world); Reflect.set(client, 'worldReady', true); Reflect.set(client, 'session', 41); Reflect.set(client, 'citizen', 3);
  Reflect.set(client, 'settings', { ...defaultWorldSettings('Haven'), canEditTerrain: true });
  const send = vi.spyOn(world, 'send').mockImplementation((type, fields = []) => { packets.push({ type, fields, version: 4, flags: 2 }); });
  const samples = new Map<string, { height: number; texture: number }>();
  const deliver = (type: number, fields: Field[] = []) => Reflect.get(world, 'receive').call(world, encode(type, fields, 4));
  const results = () => events.filter((event): event is Extract<ClientEvent, { type: 'terrain-result' }> => event.type === 'terrain-result');
  const requests = (type = P.TerrainSet as number) => packets.filter(packet => packet.type === type);
  function changed(x = 0, z = 0) { deliver(P.TerrainChanged, [i32(V.TerrainPageX, x), i32(V.TerrainPageZ, z)]); }
  function begin(x = 0, z = 0) { deliver(P.TerrainBegin, [i32(V.TerrainPageX, x), i32(V.TerrainPageZ, z)]); }
  function node(pageX: number, pageZ: number, nodeX: number, nodeZ: number, size: number, heights: number[], textures: number[]) {
    const h = Buffer.alloc(heights.length * 4), t = Buffer.alloc(textures.length * 2);
    heights.forEach((value, i) => h.writeInt32LE(value, i * 4)); textures.forEach((value, i) => t.writeUInt16LE(value, i * 2));
    deliver(P.TerrainData, [i32(V.TerrainPageX, pageX), i32(V.TerrainPageZ, pageZ), i32(V.TerrainNodeX, nodeX), i32(V.TerrainNodeZ, nodeZ), i32(V.TerrainNodeSize, size / 2),
      i32(V.TerrainNodeMultipleHeights, heights.length > 1 ? 1 : 0), heights.length > 1 ? blob(V.TerrainNodeHeights, h) : i32(V.TerrainNodeHeights, heights[0]),
      i32(V.TerrainNodeMultipleTextures, textures.length > 1 ? 1 : 0), textures.length > 1 ? blob(V.TerrainNodeTextures, t) : i32(V.TerrainNodeTextures, textures[0])]);
  }
  const end = (sequence = 1, complete = 1) => deliver(P.TerrainEnd, [i32(V.TerrainNodeSequence, sequence), i32(V.TerrainComplete, complete)]);
  function fullPage(pageX = 0, pageZ = 0, sequence = 1, complete = 1) {
    begin(pageX, pageZ);
    // Real NodeGenerator-compatible full page: 8x8 detailed nodes, independently
    // packed singleton height/texture arrays where the node is uniform.
    for (let nz = 0; nz < 128; nz += 8) for (let nx = 0; nx < 128; nx += 8) {
      const heights: number[] = [], textures: number[] = [];
      for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) {
        const sample = samples.get(`${pageX * 128 - 64 + nx + x},${pageZ * 128 - 64 + nz + z}`);
        heights.push(sample?.height ?? 0); textures.push(sample?.texture ?? 0);
      }
      node(pageX, pageZ, nx, nz, 8, heights.every(value => value === heights[0]) ? [heights[0]] : heights, textures.every(value => value === textures[0]) ? [textures[0]] : textures);
    }
    end(sequence, complete);
  }
  async function seed(pageX = 0, pageZ = 0, sequence = 1) { changed(pageX, pageZ); fullPage(pageX, pageZ, sequence); await flush(); }
  function apply(request = requests().at(-1)!) {
    const heights = bytes(request, V.TerrainNodeHeights);
    for (let i = 0; i < num(request, V.TerrainCount); i++) samples.set(`${num(request, V.TerrainX) + i},${num(request, V.TerrainZ)}`, { height: heights.readInt32LE(i * 4), texture: num(request, V.TerrainNodeTextures) });
  }
  function ack(reason = 0, x = num(requests().at(-1)!, V.TerrainX), z = num(requests().at(-1)!, V.TerrainZ)) {
    deliver(P.TerrainSet, [i32(V.ReasonCode, reason), ...(reason === 32 ? [] : [i32(V.TerrainNodeX, x), i32(V.TerrainNodeZ, z)])]);
  }
  async function readback(sequence = 2) {
    const current = Reflect.get(client, 'terrainCurrent'); expect(current?.readback).toBe(true);
    fullPage(current.pageX, current.pageZ, sequence); await flush();
  }
  return { client, world, send, events, packets, requests, results, samples, deliver, changed, begin, node, end, fullPage, seed, apply, ack, readback };
}

describe('canonical scoped terrain row writes', () => {
  it('encodes centimetres/uint16 texture and waits for a full readback before verified success', async () => {
    const view = setup(); await view.seed(); view.events.length = 0;
    const pending = view.client.command(command()); await flush();
    expect(view.requests()).toHaveLength(1); const packet = view.requests()[0];
    expect(num(packet, V.TerrainX)).toBe(0); expect(num(packet, V.TerrainCount)).toBe(2); expect(num(packet, V.TerrainNodeTextures)).toBe(65535);
    expect([...bytes(packet, V.TerrainNodeHeights)]).toEqual([...Buffer.from([29, 0, 0, 0, 244, 255, 255, 255])]);
    view.apply(); view.ack(); await flush(); expect(view.results()).toEqual([]);
    expect(num(view.requests(P.TerrainQuery).at(-1)!, V.TerrainNodeSequence)).toBe(-1);
    await view.readback(); await pending;
    expect(view.results()).toEqual([{ type: 'terrain-result', requestId: 'row-1', world: 'Haven', session: 41, cellX: 0, cellZ: 0, heights: [.29, -.12], textures: [65535, 65535], status: 'verified' }]);
    expect(view.events.findIndex(event => event.type === 'terrain-page' && event.complete)).toBeLessThan(view.events.findIndex(event => event.type === 'terrain-result'));
    expect(Reflect.get(view.client, 'terrainEdit')).toBeUndefined(); expect(Reflect.get(view.world, 'waiters').size).toBe(0);
  });
  it.each([[-65, 0], [63, 63], [63, 64]])('serially reads both affected pages for boundary row %i,%i', async (cellX, cellZ) => {
    const view = setup(), pages = terrainRowPages(cellX, cellZ, 3);
    for (const page of pages) await view.seed(page.pageX, page.pageZ);
    const pending = view.client.command(command({ cellX, cellZ, heights: [.01, .02, .03], previousHeights: [0, 0, 0], previousTextures: [0, 0, 0] })); await flush();
    view.apply(); view.ack(); await flush();
    await view.readback(); expect(view.results()).toEqual([]); await view.readback(); await pending;
    expect(view.results()[0]).toMatchObject({ heights: [.01, .02, .03], status: 'verified' }); expect(view.requests()).toHaveLength(1);
  });
  it('reports canonical conflicting values after accepted ACK rather than false success or retry', async () => {
    const view = setup(); await view.seed(); const pending = view.client.command(command()); await flush();
    view.apply(); view.samples.set('1,0', { height: 123, texture: 17 }); view.ack(); await flush(); await view.readback(); await pending;
    expect(view.results()[0]).toMatchObject({ heights: [.29, 1.23], textures: [65535, 17], status: 'conflict' }); expect(view.requests()).toHaveLength(1);
    expect(Reflect.get(view.client, 'terrainEditFailed')).toBe(false);
  });
  it('rejects a second row while the first is pending rather than queuing an ambiguous write', async () => {
    const view = setup(); await view.seed(); const pending = view.client.command(command()); await flush();
    await expect(view.client.command(command({ requestId: 'row-2' }))).rejects.toThrow('already pending');
    view.ack(32); await expect(pending).rejects.toThrow('Not authorized'); expect(view.requests()).toHaveLength(1);
  });
  it('handles Unauthorized without coordinates and permits a later explicit request', async () => {
    const view = setup(); await view.seed(); const first = view.client.command(command()); await flush(); view.ack(32);
    await expect(first).rejects.toThrow('Axis 32'); expect(view.results()).toEqual([]); expect(Reflect.get(view.client, 'terrainEditFailed')).toBe(false);
    const second = view.client.command(command()); await flush(); expect(view.requests()).toHaveLength(2); view.ack(32); await expect(second).rejects.toThrow('Axis 32');
  });
  it.each(['wrong coordinates', 'missing reason', 'missing coordinates'])('pauses after %s in a success-like acknowledgement', async kind => {
    const view = setup(); await view.seed(); const pending = view.client.command(command()); await flush();
    if (kind === 'wrong coordinates') view.ack(0, 99, 0);
    else view.deliver(P.TerrainSet, kind === 'missing reason' ? [i32(V.TerrainNodeX, 0), i32(V.TerrainNodeZ, 0)] : [i32(V.ReasonCode, 0)]);
    await expect(pending).rejects.toThrow('uncertain'); expect(view.results()).toEqual([]);
    await expect(view.client.command(command())).rejects.toThrow('paused until world re-entry'); expect(view.requests()).toHaveLength(1);
  });
  it('times out without retry, ignores late ACK and releases all waiters', async () => {
    vi.useFakeTimers(); const view = setup(); await view.seed(); const pending = view.client.command(command()).catch(error => error); await flush();
    await vi.advanceTimersByTimeAsync(15_001); expect(await pending).toBeInstanceOf(Error);
    view.ack(); await flush(); await expect(view.client.command(command())).rejects.toThrow('paused until world re-entry');
    expect(view.results()).toEqual([]); expect(view.requests()).toHaveLength(1); expect(Reflect.get(view.world, 'waiters').size).toBe(0);
  });
  it('rejects acknowledged edits whose readback times out and never claims they were rolled back', async () => {
    vi.useFakeTimers(); const view = setup(); await view.seed(); const pending = view.client.command(command()).catch(error => error); await flush();
    view.apply(); view.ack(); await flush(); await vi.advanceTimersByTimeAsync(15_001);
    expect((await pending).message).toContain('acknowledged but readback is uncertain'); expect(view.results()).toEqual([]);
    expect(Reflect.get(view.client, 'terrainReadbacks').size).toBe(0); expect(Reflect.get(view.world, 'waiters').size).toBe(0);
  });
  it('rejects incomplete readback End instead of promoting partial tiles', async () => {
    const view = setup(); await view.seed(); const pending = view.client.command(command()); await flush(); view.apply(); view.ack(); await flush();
    view.fullPage(0, 0, 2, 0); await expect(pending).rejects.toThrow('uncertain'); expect(view.results()).toEqual([]);
    expect(view.events.filter(event => event.type === 'terrain-page').at(-1)).toMatchObject({ complete: false });
  });
  it('invalidates a readback changed while loading and pauses without automatic resubmission', async () => {
    const view = setup(); await view.seed(); const pending = view.client.command(command()); await flush(); view.apply(); view.ack(); await flush();
    view.begin(); view.node(0, 0, 64, 64, 8, [0], [0]); view.changed(); view.end(2);
    await expect(pending).rejects.toThrow('uncertain'); expect(view.results()).toEqual([]); expect(view.requests()).toHaveLength(1);
  });
  it('cancels readback after travel eviction without adding terrain pins or leaking old-scope results', async () => {
    const view = setup(); await view.seed(); const pending = view.client.command(command()); await flush(); view.apply(); view.ack(); await flush();
    Reflect.get(view.client, 'updateStreamingWindow').call(view.client, 5000, 5000);
    await expect(pending).rejects.toThrow('uncertain'); view.fullPage(); await flush();
    expect(view.results()).toEqual([]); expect(Reflect.get(view.client, 'terrainReadbacks').size).toBe(0); expect(Reflect.get(view.client, 'terrainPages').has('0,0')).toBe(false);
  });
  it('cleans pending acknowledgement and readback on disconnect and resets uncertainty for the next world', async () => {
    const view = setup(); await view.seed(); const pending = view.client.command(command()); await flush(); view.client.disconnect();
    await expect(pending).rejects.toThrow('Disconnected'); expect(Reflect.get(view.world, 'waiters').size).toBe(0);
    expect(Reflect.get(view.client, 'terrainEdit')).toBeUndefined(); expect(Reflect.get(view.client, 'terrainEditFailed')).toBe(false); expect(view.results()).toEqual([]);
  });
  it('cancels post-ACK page readback on disconnect without emitting a result in the new scope', async () => {
    const view = setup(); await view.seed(); const pending = view.client.command(command()); await flush(); view.apply(); view.ack(); await flush();
    view.client.disconnect(); await expect(pending).rejects.toThrow('World changed'); await flush();
    expect(view.results()).toEqual([]); expect(Reflect.get(view.client, 'terrainReadbacks').size).toBe(0); expect(Reflect.get(view.world, 'waiters').size).toBe(0);
  });
  it('cancels send-failure waiters and does not resubmit automatically', async () => {
    const view = setup(); await view.seed(); view.send.mockImplementation(() => { throw new Error('write failed'); });
    await expect(view.client.command(command())).rejects.toThrow('outcome is uncertain');
    expect(Reflect.get(view.world, 'waiters').size).toBe(0); expect(view.results()).toEqual([]);
    await expect(view.client.command(command())).rejects.toThrow('paused until world re-entry');
  });
  it('snapshots the caller arrays before awaiting the reserved query worker', async () => {
    const view = setup(); await view.seed(); const input = command(); const pending = view.client.command(input);
    input.heights[0] = 9; input.previousHeights[0] = 9; input.texture = 7; await flush();
    expect(bytes(view.requests()[0], V.TerrainNodeHeights).readInt32LE(0)).toBe(29); expect(num(view.requests()[0], V.TerrainNodeTextures)).toBe(65535);
    view.ack(32); await expect(pending).rejects.toThrow('Axis 32');
  });
});

describe('terrain baseline and authority gates', () => {
  it.each(['world', 'session', 'permission', 'disabled'])('rejects wrong %s before sending', async kind => {
    const view = setup(); await view.seed();
    if (kind === 'permission') Reflect.get(view.client, 'settings').canEditTerrain = false;
    if (kind === 'disabled') Reflect.get(view.client, 'settings').terrainEnabled = false;
    await expect(view.client.command(command(kind === 'world' ? { world: 'Elsewhere' } : kind === 'session' ? { session: 42 } : {}))).rejects.toThrow(); expect(view.requests()).toEqual([]);
  });
  it('rejects unknown, partially loaded, changed and unloaded baselines', async () => {
    const view = setup(); await expect(view.client.command(command())).rejects.toThrow('unknown');
    view.changed(); view.begin(); view.node(0, 0, 64, 64, 8, [0], [0]);
    await expect(view.client.command(command())).rejects.toThrow('incomplete'); view.end(); await flush();
    await expect(view.client.command(command({ previousTextures: [1, 0] }))).rejects.toThrow('changed since selection');
    Reflect.get(view.client, 'updateStreamingWindow').call(view.client, 5000, 0);
    await expect(view.client.command(command())).rejects.toThrow('no longer cached'); expect(view.requests()).toEqual([]);
  });
  it('rechecks baseline after draining a background page query before any write', async () => {
    const view = setup(); await view.seed();
    Reflect.get(view.client, 'terrainPending').set('0,0', { pageX: 0, pageZ: 0 }); Reflect.get(view.client, 'startTerrainWorker').call(view.client);
    const pending = view.client.command(command()); await flush(); expect(view.requests()).toEqual([]);
    view.samples.set('0,0', { height: 25, texture: 0 }); view.fullPage(0, 0, 2);
    await expect(pending).rejects.toThrow('changed since selection'); expect(view.requests()).toEqual([]);
  });
  it('loads sequence-zero default pages explicitly with -1 instead of inventing zero samples', async () => {
    const view = setup(); view.changed(); expect(num(view.requests(P.TerrainQuery)[0], V.TerrainNodeSequence)).toBe(-1);
    view.fullPage(0, 0, 0); await flush();
    const pending = view.client.command(command()); await flush(); expect(view.requests()).toHaveLength(1); view.ack(32); await expect(pending).rejects.toThrow();
  });
  it('preserves a known default page across unchanged zero-sequence replies', async () => {
    const view = setup(); await view.seed(0, 0, 0); view.events.length = 0;
    Reflect.get(view.client, 'terrainPending').set('0,0', { pageX: 0, pageZ: 0 }); Reflect.get(view.client, 'startTerrainWorker').call(view.client);
    expect(num(view.requests(P.TerrainQuery).at(-1)!, V.TerrainNodeSequence)).toBe(0);
    view.begin(); view.end(0); await flush();
    expect(view.events.some(event => event.type === 'stream-unload')).toBe(false);
    const pending = view.client.command(command()); await flush(); expect(view.requests()).toHaveLength(1); view.ack(32); await expect(pending).rejects.toThrow('Axis 32');
  });
  it('rejects malformed direct-client commands as well as IPC validation', async () => {
    const view = setup(); await view.seed();
    for (const malformed of [command({ heights: [.001, 0] }), command({ texture: -1 }), command({ previousHeights: [] }), command({ session: 0 })])
      await expect(view.client.command(malformed)).rejects.toThrow();
    expect(view.requests()).toEqual([]);
  });
});

describe('terrain command validation and normalized rights', () => {
  it.each([
    { heights: [] }, { heights: Array(33).fill(0), previousHeights: Array(33).fill(0), previousTextures: Array(33).fill(0) },
    { heights: [NaN, 0] }, { heights: [Infinity, 0] }, { heights: [.001, 0] }, { heights: [21474836.48, 0] },
    { heights: [-21474836.49, 0] }, { previousTextures: [65536, 0] }, { texture: 1.5 }, { cellX: 1.1 }, { cellZ: 2147483647 },
    { requestId: '' }, { world: '' }, { session: 0 }, { previousHeights: [0] }, { previousTextures: [0] },
  ])('rejects malformed terrain input %j', changes => expect(() => assertCommand(command(changes))).toThrow());
  it('preserves exact centimetres and extended texture values', () => {
    expect(terrainCentimetres(.29)).toBe(29); expect(terrainCentimetres(-21474836.48)).toBe(-2147483648);
    expect(() => assertCommand(command({ heights: [-21474836.48, 21474836.47], texture: 65535 }))).not.toThrow();
    expect(() => assertCommand(command({ heights: Array(32).fill(.01), previousHeights: Array(32).fill(0), previousTextures: Array(32).fill(65535) }))).not.toThrow();
  });
  it.each([
    ['*', 0, true], [' * ', 3, false], ['*,-5', 3, false], ['3,4', 3, true], ['3,-3', 3, false], ['1~10 -3', 3, false],
    ['-2~+5', 3, true], ['5~2', 3, false], ['', 3, false], ['garbage', 3, false], ['+3', 3, true], ['3\t4', 3, false], ['0', 0, true],
    ['-2147483648~5', 3, false], ['2147483648', 3, false], ['1~10', 10, true],
  ])('matches pinned ACL %j for citizen %i', (rights, citizen, expected) => expect(axisWorldRightAllows(rights as string, citizen as number)).toBe(expected));
  it('uses ACL plus current citizen or caretaker, never owner/build or an invented capability bit', () => {
    const settings = defaultWorldSettings('Haven'), attrs = new Map([[WORLD_ATTRIBUTE.TerrainRight, '3']]);
    expect(normalizeWorldSettings(settings, attrs, new Map(), 3).canEditTerrain).toBe(true);
    expect(normalizeWorldSettings(settings, attrs, new Map(), 4).canEditTerrain).toBe(false);
    expect(normalizeWorldSettings(settings, attrs).canEditTerrain).toBe(false);
    expect(normalizeWorldSettings(settings, new Map(), new Map([[WORLD_CAPABILITY.Caretaker, 'Y']]), 4).canEditTerrain).toBe(true);
    expect(normalizeWorldSettings(settings, new Map(), new Map([[WORLD_CAPABILITY.Build, 'Y'], [WORLD_CAPABILITY.Owner, 'Y'], [7, 'Y']]), 4).canEditTerrain).toBe(false);
    mergeWorldSettingsPacket(attrs, { type: P.AttributeChange, version: 4, flags: 2, fields: [i32(WORLD_ATTRIBUTE.TerrainRight, 3)] });
    expect(normalizeWorldSettings(settings, attrs, new Map(), 3).canEditTerrain).toBe(false);
  });
  it('retains ACL across partial packets and revokes it when an invalid oversized value arrives', () => {
    const attrs = new Map<number, string>();
    const packet = (fields: Field[]): Packet => ({ type: P.AttributeChange, version: 4, flags: 2, fields });
    mergeWorldSettingsPacket(attrs, packet([str(WORLD_ATTRIBUTE.TerrainRight, '3')]));
    mergeWorldSettingsPacket(attrs, packet([str(WORLD_ATTRIBUTE.Title, 'New title')]));
    expect(normalizeWorldSettings(defaultWorldSettings('Haven'), attrs, new Map(), 3).canEditTerrain).toBe(true);
    mergeWorldSettingsPacket(attrs, packet([str(WORLD_ATTRIBUTE.TerrainRight, '3'.repeat(8193))]));
    expect(normalizeWorldSettings(defaultWorldSettings('Haven'), attrs, new Map(), 3).canEditTerrain).toBe(false);
  });
  it('maps centered page/cell boundaries and never samples unknown data as zero', () => {
    expect(terrainCellPage(-65, 64)).toEqual({ pageX: -1, pageZ: 1, nodeX: 127, nodeZ: 0 });
    const samples = new TerrainPageSamples(); expect(samples.sample(0, 0)).toBeNull();
    samples.write({ pageX: 0, pageZ: 0, nodeX: 0, nodeZ: 0, size: 2, heights: [1, 2, 3, 4], textures: [65535] });
    expect(samples.sample(1, 0)).toEqual({ height: 2, texture: 65535 }); expect(samples.sample(0, 1)).toEqual({ height: 3, texture: 65535 });
    expect(samples.sample(2, 0)).toBeNull();
  });
});
