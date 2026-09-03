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

- **Never hardcode a Chrome version in the user-agent.** A pinned
  `Chrome/128` silently became years out of date, and Google serves Gmail
  and Calendar a cut-down *legacy* interface to any browser it thinks is
  old. That presented as "the sidebar is running an older Gmail" and no
  amount of layout fiddling touched it, because it was never a layout
  problem. Both UA strings are now built from the running engine
  (`process.versions.chrome` in main, parsed off `navigator.userAgent` in
  the renderer). Keeping Electron current is therefore a functional
  requirement, not hygiene. Claiming a *newer* version than the engine
  would be worse than claiming an old one -- Google would serve code the
  engine cannot run.
- **Gmail and Calendar are scaled, not reflowed.** Their desktop layout is
  fixed-width and ignores the space available, so `FIT_TARGETS` records the
  width each one needs and the panel zoom is derived from
  `sidebarWidth / target` on every resize, throttled to one pass per
  animation frame. `zoomOverride` holds a manual setting per app; absent
  means "fit automatically". Drive, YouTube and Claude are responsive and
  are absent from `FIT_TARGETS`, so they stay at 100%.
- **Panel interfaces are fixed in `PANEL_UA`, with no UI to change them.**
  Drive is the one on the phone string, because its mobile layout genuinely
  suits a narrow column. There used to be a Phone/Desktop button; it was
  removed once the real cause was the stale version, not the layout.
- **A new source file must be added to `build.files` in `package.json`.**
  That array is an allowlist, not a hint: a file missing from it simply will
  not exist in the packaged app, and the failure only shows up in a build,
  never in `npm start`. `newtab.js` is listed there.
- **`newtab.html` runs its own script under `script-src 'self'`,** which does
  resolve for `file://` here (verified, not assumed). Its CSP previously said
  `form-action 'none'`, which silently stopped the page's own search box from
  submitting -- it now names Google explicitly. Keep scripts external; there
  is no `'unsafe-inline'` for script on that page.
- **`loadURL` must always be caught.** It rejects with `ERR_ABORTED (-3)`
  whenever a navigation is superseded -- a redirect, or a second navigation
  before the first settles. The page still loads; the rejection is noise,
  but unhandled it surfaces as an alarming `GUEST_VIEW_MANAGER_CALL` stack
  in the console.
- **`onBeforeRequest` runs on every single request**, so anything added to
  it is paid hundreds of times per page. It uses a regex for the host and
  caches the verdict per host rather than calling `new URL()` and rescanning
  `BLOCKED_HOSTS` each time (~4x faster on a realistic mix). If you touch
  `hostOf`, keep the `(?:[^/?#]*@)?` that skips userinfo: without it
  `https://user:pass@tracker.example/` reads as host `user` and walks
  straight through the blocklist.
- **CSP must keep `'unsafe-inline'` in `style-src`.** Electron's `<webview>`
  applies inline styles to size itself; a strict `style-src 'self'` makes
  Chromium refuse them and the panels mis-size. `script-src` stays strict.
- **Webviews swallow mouse events.** Each `<webview>` is a separate
  renderer, so a drag started in the host page dies the moment the pointer
  crosses one. Any drag interaction needs `#drag-shield` (a transparent
  fixed overlay) switched on for its duration.
- **Zoom resets on navigation.** `setZoomFactor` does not survive a panel
  navigating, so it is reapplied on every `dom-ready`.
- **Electron is on 44 (Chromium 152).** The jump from 31 came with
  `canGoBack()` being replaced by `navigationHistory`; the `canGo` helper in
  `main.js` handles both, so don't "simplify" it back.
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

## Where things live

- **History** is main-process state (`history` array, `history.json`), held
  in memory and flushed on a 15s timer plus on quit -- a navigation must
  never trigger a whole-file write. `addHistory` deliberately does not count
  a second visit within 5s of the first, because a page is recorded twice:
  once on `did-navigate` and again when its title arrives.
- **Downloads** are main-process state too, and are *not* persisted; the
  renderer gets the whole list pushed on every change via `downloads-changed`.
- **Preferences** (sidebar width, per-app zoom and layout, per-site page
  zoom) are renderer `localStorage`, which lives in the *default* session,
  not `persist:main`. This is why clearing the browsing session does not
  wipe preferences -- keep it that way.
- **Sessions**: every webview is on `persist:main`, at
  `<userData>/Partitions/main`. Clearing that is the "sign out everywhere"
  operation and signs out Claude and YouTube along with Google.

## Keyboard shortcuts are not what they look like

A key pressed while a `<webview>` has focus never reaches the shell window,
so a plain `keydown` listener would only fire when focus happened to be in
the chrome. `main.js` hooks `before-input-event` on every webview, swallows
the keys we claim, and replays them to the renderer as named actions on the
`shortcut` channel. The renderer has one `SHORTCUTS` map that both routes
feed. **Adding a shortcut means editing both ends** -- the matcher in
`main.js` and the map in `renderer.js` -- or it will work in the chrome and
mysteriously not in a page.

`Escape` is forwarded but deliberately not swallowed, since pages use it.

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
