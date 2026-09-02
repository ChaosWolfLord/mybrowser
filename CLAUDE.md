# My Browser

A personal Electron browser for one user (ChaosWolfLord), on Windows only.
Normal tabbed browsing on the left, a five-app sidebar on the right (Gmail,
Calendar, Drive, YouTube, Claude). Not a product -- there is no multi-user
story, no cross-platform story, and no test suite. Optimise for "works well
for this one person on this one machine" over generality.

## Layout gotcha

The project root is nested: `BrowserPersonal/my-browser/my-browser/`. The
git repo is the inner folder.

## How it fits together

| File | Purpose |
|---|---|
| `main.js` | Electron entry, shared session, security policy, network filtering, auto-updater, tab IPC |
| `preload.js` | The only Node bridge: `tabStore.save/load/onOpenUrl`. Keep it this small |
| `index.html` | Layout: titlebar, tabstrip, browsing pane, sidebar, drag shield |
| `renderer.js` | Tabs, address bar, sidebar switching/sizing/zoom/layout, session restore |
| `styles.css` | All styling. Dark warm palette, amber `#C98A3E` accent |
| `newtab.html` | The new-tab page |

Everything shares one session partition (`persist:main`), which is why a
single Google sign-in covers all five sidebar apps plus regular tabs.

## Things that will bite you

- **Zoom cannot fix the Google apps' layout.** Gmail, Calendar and Drive
  choose desktop vs mobile from the *user-agent*, not the width they have.
  On the desktop string they lay out a full desktop UI and overflow a
  narrow panel; zooming out only shrinks the text, it doesn't reflow
  anything. They are given `MOBILE_UA` so Google serves the responsive
  layout. YouTube and Claude are genuinely responsive and keep the desktop
  string. The footer toggle flips this per app, and changing it must
  `reload()` -- the UA is read at request time.
- **CSP must keep `'unsafe-inline'` in `style-src`.** Electron's `<webview>`
  applies inline styles to size itself; a strict `style-src 'self'` makes
  Chromium refuse them and the panels mis-size. `script-src` stays strict.
- **Webviews swallow mouse events.** Each `<webview>` is a separate
  renderer, so a drag started in the host page dies the moment the pointer
  crosses one. Any drag interaction needs `#drag-shield` (a transparent
  fixed overlay) switched on for its duration.
- **Zoom resets on navigation.** `setZoomFactor` does not survive a panel
  navigating, so it is reapplied on every `dom-ready`.
- **Never persist resolved `file://` URLs.** `newtab.html` resolves to a
  real folder path in dev and to a path inside `app.asar` when packaged.
  Normalise to the bare relative name via `isNewTabUrl()` before saving.
- **`new-window` no longer exists.** Electron removed the webview
  `new-window` event in v22; the old listener never fired, so `target=_blank`
  did nothing. Popups are handled by `setWindowOpenHandler` in `main.js`,
  which allows Google sign-in and routes everything else to a tab via the
  `open-url` IPC.
- **Google's embedded-browser detection.** Sign-in works because of the
  desktop UA, `allowpopups`, and masking `navigator.webdriver` together. If
  it breaks after a Google change, suspect these first. Sign in from the
  **Gmail** panel to seed the session for the other four.
- **Preferences live in renderer `localStorage`** (sidebar width, per-app
  zoom, per-app layout). Tabs go over IPC to `tabs.json` in userData.

## Startup

Cold start used to load five Google web apps plus every restored tab at
once. Now:

- Sidebar panels carry `data-src`, not `src`, and load on first open. The
  initially-active panel waits for `requestIdleCallback`.
- Restored tabs are deferred: only the first loads, the rest fetch when
  clicked. A deferred tab holds its URL in `tab.pendingUrl`, which
  `persistTabs` must read *before* `getURL()` or the session is lost.
- The window uses `show: false` + `ready-to-show`.
- The update check is delayed 30s so it doesn't compete for the network.

## Security model

`webviewTag` is on, which is the main risk surface. Accordingly:

- `will-attach-webview` strips any preload and forces `nodeIntegration`
  off, `contextIsolation` on, and the session partition.
- Renderer is `sandbox: true`, `contextIsolation: true`. The preload
  exposes three functions and nothing else. **Verify the bridge still
  works after touching preload** -- the cheap end-to-end check is to write
  a sentinel into `tabs.json`, launch, and confirm it gets rewritten.
- Permissions default to deny; only notifications and clipboard are
  allowed, via both the request and check handlers.
- `certificate-error` is never bypassed.
- The shell window refuses to navigate anywhere but `file://`.
- `BLOCKED_HOSTS` cancels third-party tracker/ad requests at the network
  layer, and top-level `http://` is upgraded to `https://` (loopback
  exempt). Matching is exact-host-or-dot-suffix, so `myhotjar.com` does not
  match `hotjar.com`. Trim the list if a site you need misbehaves.

## Shipping a change

**Smart App Control is enforced on this machine and blocks building the
installer** -- it truncated a 1.0.1 build to 188KB mid-write. Until that is
resolved, changes ship by running from source (`npm start`), not by
packaging. There are no published GitHub releases yet, so auto-update has
never actually run.

If packaging is unblocked later: bump `version` in `package.json`, then
`$env:GH_TOKEN = "..."; npm run release`. The repo (public) is
`ChaosWolfLord/mybrowser`. `npm start` skips auto-update entirely via the
`app.isPackaged` guard.
