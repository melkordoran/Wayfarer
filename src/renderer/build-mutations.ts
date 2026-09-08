import type { ClientBridge, ClientCommand, WorldObject } from "../shared/types";
import { assertCommand } from "../shared/validation";
import type { BuildChange } from "./build-history";

/** Subscribe before dispatch: coalesced TCP responses can precede the IPC acknowledgement. */
export async function requestBuildMutation(bridge: ClientBridge, change: BuildChange, timeoutMs = 35_000): Promise<BuildChange> {
  const requestId = crypto.randomUUID();
  const operation = change.before ? change.after ? "change" : "delete" : "add";
  if (!change.before && !change.after) throw new Error("There is no object to change.");
  const command = operation === "change"
    ? { type: "object-change", object: change.after!, previous: change.before!, requestId }
    : { type: operation === "add" ? "object-add" : "object-delete", object: change.after ?? change.before!, requestId };
  assertCommand(command);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  let rejectLifecycle!: (error: Error) => void;
  // A result can precede its IPC acknowledgement. Cancellation must stay live
  // until both have completed, not only while waiting for the result event.
  const lifecycle = new Promise<never>((_, reject) => { rejectLifecycle = reject; });
  const response = new Promise<WorldObject | null>((resolve, reject) => {
    unsubscribe = bridge.subscribe(event => {
      if (event.type === "status" && event.phase !== "online")
        rejectLifecycle(new Error("The world connection changed before this edit completed."));
      if (event.type !== "object-result" || event.requestId !== requestId) return;
      if (event.operation !== operation || (operation !== "delete" && !event.object)) {
        reject(new Error("The server returned an inconsistent build result.")); return;
      }
      resolve(event.object ? { ...event.object } : null);
    });
    timer = setTimeout(() => rejectLifecycle(new Error("The accepted object update was not confirmed. Refresh the world before retrying; do not assume the operation failed.")), timeoutMs);
  });
  try {
    const [after] = await Promise.race([
      Promise.all([response, Promise.resolve().then(() => bridge.command(command as ClientCommand))]),
      lifecycle,
    ]);
    return { before: change.before ? { ...change.before } : null, after };
  } finally { if (timer) clearTimeout(timer); unsubscribe(); }
}
