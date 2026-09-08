/** Only the first-party main frame can request user-facing viewport controls. */
export function allowViewportPermission(
  permission: string,
  requestingUrl: string,
  entryUrl: string,
  mainFrame: boolean,
): boolean {
  return (
    mainFrame &&
    (permission === "pointerLock" || permission === "fullscreen") &&
    requestingUrl.split("#")[0] === entryUrl
  );
}
