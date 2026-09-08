import { app, BrowserWindow, dialog, ipcMain, Menu, session } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AxisClient } from "./protocol";
import { fetchAsset } from "./assets";
import { assertCommand } from "../shared/validation";
import { allowViewportPermission } from "./security";
import { assertNativeCommandTarget, assertNativeWorldTarget, configureNativeProfile, nativeQaAssetTarget, nativeStartupOptions, NATIVE_QA_SCHEMA, writeNativeQaReceipt, type NativeQaReceipt, type NativeStartup } from "./native-startup";
import { createScopedAssetFetcher } from "./scoped-assets";

let mainWindow: BrowserWindow | null = null;
let client: AxisClient | null = null;
const dev = !app.isPackaged && process.env.WAYFARER_DEV === "1";
app.setName("Wayfarer");
let startup: NativeStartup, qaReceipt: NativeQaReceipt | undefined, qaReadyWritten = false;
try {
  startup = nativeStartupOptions(process.argv);
  const profileDir = configureNativeProfile(app, startup);
  if (profileDir && startup.qa) {
    qaReceipt = { schema: NATIVE_QA_SCHEMA, pid: process.pid, version: app.getVersion(), profileDir,
      userData: app.getPath("userData"), sessionData: app.getPath("sessionData"), appPath: app.getAppPath(),
      isPackaged: app.isPackaged, qa: startup.qa, timestamp: new Date().toISOString() };
    writeNativeQaReceipt(profileDir, "native-startup.json", qaReceipt);
  }
} catch (error) {
  console.error("Native startup isolation failed:", error instanceof Error ? error.message : "Invalid startup options");
  app.exit(1);
  throw error; // A mocked exit must not let tests continue through the normal profile.
}
const qaAssetFetcher = startup.qa ? createScopedAssetFetcher(input => nativeQaAssetTarget(input, startup.qa!)) : undefined;
const entry = dev
  ? "http://127.0.0.1:5173/"
  : pathToFileURL(join(__dirname, "../dist/index.html")).href;
function trusted(event: Electron.IpcMainInvokeEvent) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    event.senderFrame.url.split("#")[0] !== entry
  )
    throw new Error("Untrusted IPC sender.");
}
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    title: startup.qa ? "Wayfarer · Isolated QA" : "Wayfarer",
    backgroundColor: "#151a20",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  if (startup.qa) mainWindow.on("page-title-updated", event => { event.preventDefault(); });
  client = new AxisClient((event) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("wayfarer:event", event);
  }, { authorizeWorldConnection: target => assertNativeWorldTarget(target, startup.qa) });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.split("#")[0] !== entry) event.preventDefault();
  });
  // Electron respects renderer beforeunload; only an explicit choice may discard work.
  mainWindow.webContents.on("will-prevent-unload", (event) => {
    if (!mainWindow) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "warning",
      buttons: ["Keep editing", "Close without saving"],
      defaultId: 0,
      cancelId: 0,
      title: "Your work is not fully saved",
      message:
        "You have unsaved edits, an operation in progress, or local work that could not be saved.",
      detail:
        "Keep the window open to finish saving or export a backup. Closing now may lose local work or collected telegrams; a submitted server operation may still complete.",
    });
    if (choice === 1) event.preventDefault();
  });
  mainWindow.on("closed", () => {
    client?.disconnect();
    client = null;
    mainWindow = null;
  });
  await mainWindow.loadURL(entry);
  if (qaReceipt && !qaReadyWritten) {
    writeNativeQaReceipt(qaReceipt.profileDir, "native-ready.json", {
      ...qaReceipt, timestamp: new Date().toISOString(), nativeWindowVisible: mainWindow.isVisible(),
      size: mainWindow.getSize(), url: mainWindow.webContents.getURL(),
    });
    qaReadyWritten = true;
  }
}
app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) =>
        callback(
          !!mainWindow &&
            contents === mainWindow.webContents &&
            allowViewportPermission(
              permission,
              details.requestingUrl || contents.getURL(),
              entry,
              details.isMainFrame,
            ),
        ),
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        !!mainWindow &&
        contents === mainWindow.webContents &&
        allowViewportPermission(
          permission,
          details.requestingUrl || contents.getURL(),
          entry,
          details.isMainFrame,
        ),
    );
    ipcMain.handle("wayfarer:command", async (event, command: unknown) => {
      trusted(event);
      assertCommand(command);
      assertNativeCommandTarget(command, startup.qa);
      await client?.command(command);
    });
    ipcMain.handle("wayfarer:asset", async (event, url: string) => {
      trusted(event);
      return qaAssetFetcher ? qaAssetFetcher(url) : fetchAsset(url);
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin"
          ? [
              {
                label: "Wayfarer",
                submenu: [
                  { role: "about" as const },
                  { type: "separator" as const },
                  { role: "hide" as const },
                  { role: "quit" as const },
                ],
              },
            ]
          : []),
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "togglefullscreen" },
            ...(dev ? [{ role: "toggleDevTools" as const }] : []),
          ],
        },
        { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }] },
      ]),
    );
    await createWindow();
    app.on("activate", () => {
      if (!mainWindow) void createWindow();
    });
  })
  .catch((error) => {
    console.error("Could not start Wayfarer:", error.message);
    app.quit();
  });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => client?.disconnect());
