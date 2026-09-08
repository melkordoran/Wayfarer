import type { ClientBridge } from "../shared/types";
import {
  terrainCentimetres,
  type TerrainEditRow,
  type TerrainSetCommand,
} from "../shared/terrain-edit";
import { assertCommand } from "../shared/validation";

/** Keep lifecycle cancellation live until both canonical readback and IPC complete. */
export async function requestTerrainMutation(
  bridge: ClientBridge,
  input: TerrainSetCommand,
  timeoutMs = 75_000,
): Promise<TerrainEditRow> {
  assertCommand(input);
  const command = {
    ...input,
    heights: [...input.heights],
    previousHeights: [...input.previousHeights],
    previousTextures: [...input.previousTextures],
  };
  let timer: ReturnType<typeof setTimeout> | undefined,
    unsubscribe = () => {};
  let cancelled = false,
    cancellation: Error | undefined,
    cancel!: (error: Error) => void;
  const lifecycle = new Promise<never>((_, reject) => {
    cancel = (error) => {
      if (cancelled) return;
      cancelled = true;
      cancellation = error;
      reject(error);
    };
  });
  const response = new Promise<TerrainEditRow>((resolve) => {
    try {
      unsubscribe = bridge.subscribe((event) => {
        if (cancelled || !event || typeof event !== "object") return;
        if (event.type === "status" && event.phase !== "online")
          cancel(
            new Error("The world connection changed during the terrain edit."),
          );
        if (
          event.type !== "terrain-result" ||
          event.requestId !== command.requestId
        )
          return;
        try {
          if (
            Array.isArray(event) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(event))
          )
            throw new Error("Terrain readback is not a plain result object.");
          if (
            typeof event.world !== "string" ||
            event.world.length > 64 ||
            !Number.isInteger(event.session) ||
            !Number.isInteger(event.cellX) ||
            !Number.isInteger(event.cellZ) ||
            event.world.trim().toLowerCase() !==
              command.world.trim().toLowerCase() ||
            event.session !== command.session ||
            event.cellX !== command.cellX ||
            event.cellZ !== command.cellZ
          )
            throw new Error(
              "Terrain readback belongs to a different world, session or row.",
            );
          if (event.status !== "verified")
            throw new Error(
              "Terrain was accepted but canonical readback conflicted. Inspect the current terrain; do not assume the edit failed.",
            );
          if (
            !Array.isArray(event.heights) ||
            !Array.isArray(event.textures) ||
            event.heights.length !== command.heights.length ||
            event.textures.length !== command.heights.length
          )
            throw new Error(
              "Terrain readback contains inconsistent row arrays.",
            );
          for (let i = 0; i < event.heights.length; i++) {
            const height = event.heights[i],
              texture = event.textures[i];
            if (typeof height !== "number")
              throw new Error("Terrain readback contains an invalid height.");
            terrainCentimetres(height);
            if (!Number.isInteger(texture) || texture < 0 || texture > 65535)
              throw new Error("Terrain readback contains an invalid texture.");
            if (height !== command.heights[i] || texture !== command.texture)
              throw new Error(
                "Terrain verified readback does not match the submitted values. Inspect the current terrain.",
              );
          }
          resolve({
            cellX: event.cellX,
            cellZ: event.cellZ,
            heights: [...event.heights],
            textures: [...event.textures],
          });
        } catch (error) {
          cancel(
            error instanceof Error
              ? error
              : new Error(
                  "Terrain readback was malformed. Inspect the current terrain.",
                ),
          );
        }
      });
    } catch (error) {
      cancel(
        error instanceof Error
          ? error
          : new Error("Could not subscribe to terrain readback."),
      );
      return;
    }
    timer = setTimeout(
      () =>
        cancel(
          new Error(
            "Terrain readback is uncertain. Re-enter the world before editing again; no automatic retry was sent.",
          ),
        ),
      timeoutMs,
    );
  });
  try {
    const [row] = await Promise.race([
      Promise.all([
        response,
        Promise.resolve().then(() => {
          if (cancelled)
            throw (
              cancellation ??
              new Error("Terrain edit was cancelled before dispatch.")
            );
          return bridge.command(command);
        }),
      ]),
      lifecycle,
    ]);
    return row;
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
  }
}
