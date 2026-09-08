// Launch the production Electron entrypoint and inspect native readiness events only.
// This does not automate the browser or click through the UI.
const { app } = require("electron");
const { join } = require("node:path");
const { mkdirSync, writeFileSync } = require("node:fs");
const root = join(__dirname, "..");
const smokeProfile = join(root, ".runtime", "native-smoke-profile");
mkdirSync(smokeProfile, { recursive: true });
app.setPath("userData", smokeProfile);
const started = Date.now();
let verified = false;
const timer = setTimeout(() => {
  console.error("Native window readiness timed out.");
  app.exit(1);
}, 20000);
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`Native page load failed: ${code} ${description}`);
    app.exit(1);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      `Native renderer exited unexpectedly: ${JSON.stringify(details)}`,
    );
    app.exit(1);
  });
  window.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      if (
        window.isDestroyed() ||
        !window.isVisible() ||
        window.webContents.isLoading()
      ) {
        console.error("Native window did not become visible and idle.");
        app.exit(1);
        return;
      }
      const result = {
        passed: true,
        timestamp: new Date().toISOString(),
        nativeWindowVisible: window.isVisible(),
        title: window.getTitle(),
        url: window.webContents.getURL(),
        size: window.getSize(),
        electron: process.versions.electron,
        elapsedMs: Date.now() - started,
      };
      mkdirSync(join(root, ".runtime"), { recursive: true });
      writeFileSync(
        join(root, ".runtime", "native-smoke.json"),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result));
      verified = true;
      clearTimeout(timer);
      app.quit();
    }, 1500);
  });
});
app.on("will-quit", () => {
  clearTimeout(timer);
  if (!verified) process.exitCode = 1;
});
require(join(root, "dist-electron", "main.cjs"));
