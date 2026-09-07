# Hello Aurora

A tiny extension to copy and change.

Add it in **Settings -> Extensions -> Add a folder...** and point at this
folder. It runs from here, so you can edit these files and press **Reload**
next to its name to see the change. No reinstalling, no restart.

- `manifest.json` — what the extension is and what it is allowed to do.
- `content.js` — runs inside every page you visit.
- `background.js` — the service worker; wakes on events, sleeps otherwise.
- `popup.html` / `popup.js` — what the toolbar button opens.

Aurora provides these `chrome.*` APIs: `action`, `alarms`,
`declarativeNetRequest`, `dom`, `extension`, `i18n`, `idle`, `management`,
`offscreen`, `proxy`, `runtime`, `scripting`, `storage`, `tabs`,
`webRequest`. Anything else (`contextMenus`, `cookies`, `notifications`,
`bookmarks`, `history`, `commands`) does not exist here, and calling it
throws.
