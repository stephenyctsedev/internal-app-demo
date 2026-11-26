// Read-only mode (web build only).
//
// The server (api/app.js) adds <meta name="app-access" content="read|write">
// to the page from the person's 閱讀／寫入 choice in the 鑰匙簿. With
// "read" the apps hide every button that would write to the Sheet. This is
// only the UI: api/sheets.js refuses the writes themselves.
//
// The claude.ai artifact build is never read-only here — there the viewer's
// own Google account decides (Sheet shared as Viewer vs Editor).

function initial(): boolean {
  if (!__WEB__) return false;
  try {
    return document.querySelector('meta[name="app-access"]')?.getAttribute("content") !== "write";
  } catch {
    return true;
  }
}

/** True when this person may only look, not change anything. */
export const readOnly: boolean = initial();
