import type { ClientBridge, ClientCommand, ClientEvent } from "../shared/types";

class PreviewBridge implements ClientBridge {
  readonly mode = "preview" as const;
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private id = 0;
  private listeners = new Set<(event: ClientEvent) => void>();
  private pending = new Map<
    number,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  subscribe(listener: (event: ClientEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private async open() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    this.opening = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/bridge`,
      );
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.opening = null;
        resolve();
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        this.opening = null;
        reject(
          new Error(
            "The local protocol bridge is unavailable. Start the app with npm run dev.",
          ),
        );
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        reject(
          new Error("Connection to the local bridge closed before opening."),
        );
        this.opening = null;
        this.socket = null;
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error("Connection to the local bridge closed."));
        }
        this.pending.clear();
        for (const listener of this.listeners)
          listener({
            type: "status",
            phase: "disconnected",
            message: "Local bridge disconnected.",
          });
      };
      socket.onmessage = (message) => {
        if (this.socket !== socket) return;
        let data;
        try {
          data = JSON.parse(message.data);
        } catch {
          return;
        }
        if (data.event) {
          for (const listener of this.listeners) listener(data.event);
          return;
        }
        const request = this.pending.get(data.id);
        if (request) {
          clearTimeout(request.timer);
          this.pending.delete(data.id);
          data.error
            ? request.reject(new Error(data.error))
            : request.resolve();
        }
      };
    });
    return this.opening;
  }
  async command(command: ClientCommand) {
    await this.open();
    const id = ++this.id;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(command.type === "terrain-set" ? "Terrain confirmation timed out. Re-enter the world and inspect it before editing again; the outcome may be uncertain." : "The server did not answer in time."));
      }, command.type === "terrain-set" ? 70_000 : 35_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
          throw new Error("The local bridge is not connected.");
        this.socket.send(JSON.stringify({ id, command }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          error instanceof Error ? error : new Error("Could not send command."),
        );
      }
    });
  }
  async asset(url: string) {
    const response = await fetch(`/asset?url=${encodeURIComponent(url)}`);
    if (!response.ok) throw new Error(await response.text());
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType:
        response.headers.get("X-Asset-Content-Type") ||
        "application/octet-stream",
    };
  }
}
export const bridge: ClientBridge = window.wayfarer ?? new PreviewBridge();
