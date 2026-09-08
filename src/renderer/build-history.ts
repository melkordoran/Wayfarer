import type { WorldObject } from "../shared/types";

export interface BuildChange {
  before: WorldObject | null;
  after: WorldObject | null;
}
export interface BuildEntry {
  label: string;
  changes: BuildChange[];
}
export interface BuildAdapter {
  read(id: number): WorldObject | undefined;
  /** Return only the accepted, canonical result, never an optimistic guess. */
  apply(change: BuildChange): Promise<BuildChange>;
}
export interface BuildOutcome {
  applied: BuildChange[];
  error?: string;
  cancelled?: boolean;
}
const copyObject = (object: WorldObject | null) => object ? { ...object } : null;
const copyChange = (change: BuildChange): BuildChange => ({ before: copyObject(change.before), after: copyObject(change.after) });
const invert = (change: BuildChange): BuildChange => ({ before: copyObject(change.after), after: copyObject(change.before) });

/** Cell coordinates are derived transport metadata; every editable property is compared. */
export function sameBuildObject(a: WorldObject | undefined | null, b: WorldObject | undefined | null): boolean {
  if (!a || !b) return !a && !b;
  return a.id === b.id && a.owner === b.owner && a.model === b.model && a.description === b.description && a.action === b.action &&
    a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw && a.pitch === b.pitch && a.roll === b.roll &&
    (a.type ?? 0) === (b.type ?? 0) && (a.data ?? "") === (b.data ?? "");
}

/** Session-scoped, bounded history. Remote changes are conflicts, not permission to overwrite. */
export class BuildHistory {
  private past: BuildEntry[] = [];
  private future: BuildEntry[] = [];
  private generation = 0;
  private running = false;
  constructor(private readonly maxEntries = 100, private readonly maxBytes = 16 * 1024 * 1024) {}
  get undoLabel() { return this.past.at(-1)?.label ?? ""; }
  get redoLabel() { return this.future.at(-1)?.label ?? ""; }
  get busy() { return this.running; }
  get size() { return { undo: this.past.length, redo: this.future.length }; }
  reset() { this.generation++; this.running = false; this.past = []; this.future = []; }

  execute(label: string, changes: readonly BuildChange[], adapter: BuildAdapter) {
    return this.run("execute", { label, changes: changes.map(copyChange) }, adapter);
  }
  undo(adapter: BuildAdapter) { return this.run("undo", this.past.at(-1), adapter); }
  redo(adapter: BuildAdapter) { return this.run("redo", this.future.at(-1), adapter); }

  private conflict(change: BuildChange, adapter: BuildAdapter): string | undefined {
    if (!change.before) return undefined;
    const current = adapter.read(change.before.id);
    if (!sameBuildObject(current, change.before))
      return `Object #${change.before.id} ${current ? "changed since this edit" : "is no longer loaded"}. No conflicting object was overwritten. Inspect it before making a new edit.`;
  }

  private remap(oldId: number, newId: number, entries: BuildEntry[]) {
    if (!oldId || oldId === newId) return;
    for (const entry of entries) for (const change of entry.changes)
      for (const object of [change.before, change.after]) if (object?.id === oldId) object.id = newId;
  }
  private trim() {
    while (this.past.length > this.maxEntries) this.past.shift();
    while (this.future.length > this.maxEntries) this.future.shift();
    while (JSON.stringify([this.past, this.future]).length * 2 > this.maxBytes) {
      if (this.past.length > 1) this.past.shift();
      else if (this.future.length > 1) this.future.shift();
      else { this.past = []; this.future = []; break; }
    }
  }
  private async run(direction: "execute" | "undo" | "redo", source: BuildEntry | undefined, adapter: BuildAdapter): Promise<BuildOutcome> {
    if (this.running) return { applied: [], error: "A build operation is already in progress." };
    if (!source) return { applied: [] };
    if (!source.changes.length || source.changes.length > 256) return { applied: [], error: "Choose between 1 and 256 objects per build operation." };
    // Duplicate identities would make preflight and partial replay ambiguous.
    const ids = source.changes.flatMap(change => change.before ? [change.before.id] : []);
    if (new Set(ids).size !== ids.length || source.changes.some(change => !change.before && !change.after))
      return { applied: [], error: "Invalid or duplicate objects in build operation." };
    const generation = this.generation;
    const requested = { label: source.label, changes: (direction === "undo" ? [...source.changes].reverse().map(invert) : source.changes.map(copyChange)) };
    for (const change of requested.changes) {
      const error = this.conflict(change, adapter);
      if (error) return { applied: [], error };
    }
    this.running = true;
    const applied: BuildChange[] = [];
    let error: string | undefined;
    try {
      for (const change of requested.changes) {
        if (generation !== this.generation) return { applied, cancelled: true };
        const conflict = this.conflict(change, adapter);
        if (conflict) throw new Error(conflict);
        const accepted = copyChange(await adapter.apply(copyChange(change)));
        if (generation !== this.generation) return { applied, cancelled: true };
        applied.push(accepted);
        if (change.after && accepted.after) this.remap(change.after.id, accepted.after.id, [...this.past, ...this.future, source, requested]);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The build operation was rejected.";
    } finally {
      if (generation === this.generation) this.running = false;
    }
    if (generation !== this.generation) return { applied, cancelled: true };
    if (applied.length) {
      const label = applied.length < requested.changes.length ? `${source.label} (${applied.length}/${requested.changes.length})` : source.label;
      if (direction === "execute") {
        this.past.push({ label, changes: applied.map(copyChange) });
        this.future = [];
      } else {
        const from = direction === "undo" ? this.past : this.future;
        const to = direction === "undo" ? this.future : this.past;
        if (applied.length === source.changes.length) from.pop();
        else source.changes = direction === "undo" ? source.changes.slice(0, -applied.length) : source.changes.slice(applied.length);
        to.push({ label, changes: direction === "undo" ? [...applied].reverse().map(invert) : applied.map(copyChange) });
      }
      this.trim();
    }
    return { applied, ...(error ? { error: applied.length ? `${applied.length} of ${requested.changes.length} changes were accepted. ${error} Accepted changes remain undoable.` : error } : {}) };
  }
}

/** Group yaw rotates around the selection centre; individual orientation is preserved relative to it. */
export function transformSelection(objects: readonly WorldObject[], offset: { x: number; y: number; z: number; yaw: number }): WorldObject[] {
  if (!objects.length) return [];
  if (objects.length > 256 || !Object.values(offset).every(Number.isFinite)) throw new Error("Invalid selection transform.");
  const cx = objects.reduce((n, o) => n + o.x, 0) / objects.length;
  const cz = objects.reduce((n, o) => n + o.z, 0) / objects.length;
  const cos = Math.cos(offset.yaw), sin = Math.sin(offset.yaw);
  return objects.map(object => ({ ...object, x: cx + (object.x - cx) * cos + (object.z - cz) * sin + offset.x,
    y: object.y + offset.y, z: cz - (object.x - cx) * sin + (object.z - cz) * cos + offset.z, yaw: object.yaw + offset.yaw }));
}
