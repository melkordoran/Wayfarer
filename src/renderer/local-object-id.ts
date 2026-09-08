/** Imported projects may use any uint32 ID; scan past occupied IDs and wrap safely. */
export function nextLocalObjectId(objects: ReadonlyMap<number, unknown>, after: number): number {
  let candidate = Number.isInteger(after) && after >= 0 && after <= 0xffffffff ? after : 0;
  for (let checked = 0; checked <= objects.size; checked++) {
    candidate = candidate >= 0xffffffff ? 1 : candidate + 1;
    if (!objects.has(candidate)) return candidate;
  }
  throw new Error("No object ID is available for this studio.");
}
