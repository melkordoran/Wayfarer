import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { AxisClient } from "../src/main/protocol";
import { fetchAsset } from "../src/main/assets";
import { assertCommand } from "../src/shared/validation";
import { previewOptions, assertPreviewAssetTarget, assertPreviewCommandTarget, assertPreviewWorldTarget } from "./preview-options";
import { createIsolatedPreviewAssetFetcher } from "./isolated-preview-assets";

const options = previewOptions();
const { allowedOrigins, port } = options;
const assetFetcher = options.isolation ? createIsolatedPreviewAssetFetcher(options) : fetchAsset;
const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const referer = request.headers.referer;
    if (!referer || !allowedOrigins.has(new URL(referer).origin)) {
      response.writeHead(403).end();
      return;
    }
  } catch {
    response.writeHead(403).end();
    return;
  }
  try {
    const route = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method !== "GET" || route.pathname !== "/asset") {
      response.writeHead(404).end();
      return;
    }
    const url = assertPreviewAssetTarget(route.searchParams.get("url") || "", options);
    const result = await assetFetcher(url);
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "X-Asset-Content-Type": result.contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
    });
    response.end(result.bytes);
  } catch (error) {
    response
      .writeHead(400, { "Content-Type": "text/plain" })
      .end(error instanceof Error ? error.message : "Asset request failed.");
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
server.on("upgrade", (request, socket, head) => {
  if (
    request.url !== "/bridge" ||
    !request.headers.origin ||
    !allowedOrigins.has(request.headers.origin)
  ) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) =>
    wss.emit("connection", ws, request),
  );
});
wss.on("connection", (socket) => {
  const send = (value: unknown) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(value));
  };
  const client = new AxisClient((event) => send({ event }), options.isolation ? {
    authorizeWorldConnection: (target: { host: string; port: number; tls: boolean }) => assertPreviewWorldTarget(target, options),
  } : undefined);
  socket.on("message", async (data) => {
    let id: number | undefined;
    try {
      const request = JSON.parse(data.toString());
      if (!Number.isSafeInteger(request.id))
        throw new Error("Invalid request ID.");
      id = request.id;
      assertCommand(request.command);
      assertPreviewCommandTarget(request.command, options);
      await client.command(request.command);
      send({ id, ok: true });
    } catch (error) {
      send({
        id,
        error: error instanceof Error ? error.message : "Command failed.",
      });
    }
  });
  socket.on("close", () => client.disconnect());
  socket.on("error", () => client.disconnect());
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Wayfarer preview bridge listening on 127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    for (const client of wss.clients) client.close();
    wss.close();
    server.close(() => process.exit(0));
  });
