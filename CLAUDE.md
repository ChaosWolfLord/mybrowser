# Aurora

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

- **Never run this from the OneDrive folder.** Measured on this machine,
  with an otherwise identical build:

  | Location | Window on screen |
  |---|---|
  | `OneDrive\Documents\BrowserPersonal\...` | **10,337 ms** |
  | `%USERPROFILE%\Aurora` | **356 ms** |

  OneDrive Files On-Demand marks every file a `ReparsePoint`, so each read
  goes through its filter driver; spawning a renderer reads a great many
  Chromium files. A blank page took the same 10.3s, which is what proved it
  was the location and not the app. The repository can live in OneDrive; the
  copy you *run* must not. If startup ever feels slow again, check
  `(Get-Item index.html -Force).Attributes` for `ReparsePoint` before
  looking at any code.
- **The request filters are not a performance problem.** 577 requests on a
  real Google results page cost 8.9ms through `onBeforeRequest` and 3.2ms
  through `onBeforeSendHeaders` -- about 0.015ms each. Measure before
  optimising them again.

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

## Menus are drawn by the renderer

Both the toolbar menu and every right-click menu are HTML in `renderer.js`,
not `Menu.buildFromTemplate().popup()`. Electron's native menu is a grey
Windows menu that looks like it belongs to a different program, and there is
no way to style it.

- `main.js` only forwards: `context-menu` sends `{ wcId, params }`, with
  `pickMenuParams` flattening and type-checking the fields the menu uses
  instead of passing Chromium's params object across.
- The renderer finds the element by matching `wv.getWebContentsId()` against
  `wcId`, then positions the menu at the webview's rect plus the click
  coordinates **scaled by that panel's zoom** -- the coordinates arrive in
  the page's own pixels, so a zoomed sidebar panel would otherwise place the
  menu away from the pointer.
- Dismissing needs `#drag-shield`. A click aimed at closing the menu usually
  lands on a page, which is its own renderer and never tells this window.
- When `wcId` matches no webview the click was on the shell itself -- the
  settings or guide page -- and there is no webview to act on, so only Copy
  is offered, and only when something is selected.
- `clipboard.writeText` stays in main, reached over `clipboard-write`.
- Confirmation dialogs (sign out, clear history) are still native
  `dialog.showMessageBox`, which is right: a modal confirmation should look
  like the system asking.

## Getting data into the new tab page

That page is a `<webview>`, so it has no preload, and its CSP has no
`connect-src`. It cannot fetch anything and nothing can hand it anything --
both deliberate. The one route in is `executeJavaScript`, which bypasses page
CSP; the webdriver mask already relied on this. Main fetches the headlines,
the renderer injects them on `dom-ready` by calling `window.__setNews`.

Do not "fix" this by giving the page a preload or loosening its CSP. Those
were the two alternatives and both widen the surface of a page that renders
text from the open internet.

- `parseRss` is hand-rolled because the feed is flat and only four fields are
  wanted. `decodeEntities` must decode `&amp;` **last**, or `&amp;lt;` turns
  into `<`.
- Items whose link is not `http`/`https` are dropped in main *and* again in
  the page before rendering.
- `newsTopics` and `allowedProtocols` are the two non-boolean settings, so
  each has its own validation in `loadSettings`; `settings-set` still refuses
  anything that is not a boolean.

## More than one window

`mainWindow` now means *the focused window*, and is only for things that
need any window at all: dialogs and the protocol prompt. Anything caused by
a particular page goes to that page's own window via `ownerWindow(contents)`;
anything global (downloads, session-cleared) goes through `sendToAll`.

- **Only the first ordinary window owns `tabs.json`.** Two windows writing
  it would each clobber the other, so `persistTabs` returns early unless
  `windowInfo.isPrimary`, and non-primary windows start empty rather than
  cloning what the first had open.
- **A private window is a partition without `persist:`**, so the session is
  in memory and gone when the window closes. `will-attach-webview` picks the
  partition from `windowPartitions` keyed on the *embedder*, which is what
  keeps a private window's webviews out of the signed-in session. It records
  no history either.
- **Every session gets the network policy**, not just the first --
  `applySettings` iterates `sessions`. A private window that skipped tracker
  blocking would be a strange kind of private.
- `tabs.json` entries are `{url, pinned}` objects now; plain strings are
  still accepted, since that is what existing files contain.

## Internal pages

`INTERNAL_PAGES` in `renderer.js` registers pages that the shell draws
itself. Settings is one; the `guide` page (`HOW-IT-WORKS.md` rewritten as
markup, opened from the menu) is the other. Its content is inline in
`index.html` rather than fetched, because the shell's CSP has no
`connect-src` and adding one to load a static local file would be a worse
trade than a longer file. They are tabs in every visible sense -- title,
icon, close button, restored across restarts -- but they hold a `panel`
element instead of a `webview`.

**This is not a stylistic choice.** `will-attach-webview` strips the preload
from every webview on purpose, so a webview has no bridge to main and could
never read or write settings. Anything that needs IPC has to be a panel in
the shell.

Consequences to keep in mind when touching tab code:

- `tab.webview` is null for these. Every use needs a guard; `updateNavButtons`,
  `runFind`, `applyTabZoom`, `nudgeTabZoom` and the nav buttons all have one.
- The panel element is static in `index.html`, so `closeTab` removes the
  `active` class rather than the node, and `openInternalTab` reuses the
  existing tab instead of opening a second one.
- They persist as their sentinel (`about:settings`) and are recognised on
  boot by `internalKindOf`.
- Typing an address while one is showing opens a *new* tab rather than
  trying to convert the panel into a website.

## Bookmarks and settings storage

Both live in the main process (`bookmarks.json`, `settings.json`) and both
validate what they read back: only `http`/`https` URLs are accepted as
bookmarks, which is what keeps a `javascript:` URL out of a clickable chip.

## Settings

`DEFAULT_SETTINGS` in `main.js` is the single source of truth; the renderer
only renders what it is told and calls `settings-set`. Adding a switch means
one key there plus one entry in `SETTINGS_SECTIONS` in `renderer.js`.

- **Main owns the settings, not the renderer.** Every policy that depends on
  one is enforced in the main process, so a compromised page cannot turn a
  protection off by writing to `localStorage`.
- **`settings-set` validates.** Unknown keys and non-boolean values are
  refused. `loadSettings` does the same for the file on disk, so a stale or
  hand-edited `settings.json` cannot introduce a key the code does not
  expect, and cannot pollute the prototype.
- **Handlers are torn down, not short-circuited.** `syncRequestHandler` and
  `syncHeaderHandler` call `onBeforeRequest(null)` / `onBeforeSendHeaders(null)`
  when nothing in their group is enabled, so switching everything off really
  does remove the per-request cost instead of paying it to decide nothing.
- **`stripTrackingParams` must return null when it changes nothing.**
  Redirecting a request to its own URL loops forever. Stripping is
  idempotent, which is what makes one redirect the maximum.

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
- **WebAuthn has no permission hook.** `setPermissionRequestHandler` never
  sees it, so a page can raise the native Windows security-key dialog with
  no way for the app to decline. The only place to stand is inside the page
  ahead of its scripts: `no-webauthn.js`, registered on each session with
  `registerPreloadScript({ type: 'frame' })` and reaching page globals via
  `contextBridge.executeInMainWorld`. A session preload is not the same
  thing as `webPreferences.preload`, which `will-attach-webview` still
  strips -- the guest cannot opt out of this one or choose its own.
  `--disable-blink-features=WebAuthentication` does **not** work; it was
  tried and `PublicKeyCredential` survived it.
- Only guest sessions are covered, not the shell window's (it uses the
  default session and is our own `file://` code).
- The shell window refuses to navigate anywhere but `file://`.
- `BLOCKED_HOSTS` cancels third-party tracker/ad requests at the network
  layer, and top-level `http://` is upgraded to `https://` (loopback
  exempt). Matching is exact-host-or-dot-suffix, so `myhotjar.com` does not
  match `hotjar.com`. Trim the list if a site you need misbehaves.

## Extensions

Electron runs the *engine* half of an extension and none of the interface.
Loading, content scripts and MV3 service workers are Electron's; the toolbar
button, the popup and the management UI are ours.

- Load with `ses.extensions.loadExtension(dir, { allowFileAccess: true })`.
  Nothing persists across restarts, so `extensions.json` in the profile is
  the registry and every extension is loaded again on each boot.
- **Content scripts do reach `<webview>` guests.** Verified: a content
  script set an attribute on a guest's DOM. Note that `window.__x` set by a
  content script is *not* visible to `executeJavaScript` -- separate worlds,
  as in Chrome -- so check the DOM, not globals, when testing.
- The popup has to be a `<webview>` pointed at
  `chrome-extension://<id>/<popup>`. Only a guest on that session gets the
  real `chrome.*` APIs.
- Icons are inlined as data URIs by main. The shell is a `file://` page and
  cannot load `chrome-extension://` images.
- Extensions load into `persist:main` only, so they are absent from private
  windows -- and the toolbar hides there, because a popup would otherwise be
  forced onto the private partition where the extension does not exist.
- A folder is registered where it sits (edit and Reload); a `.crx` is
  unpacked into the profile. Only profile-owned copies are deleted on
  Remove.
- `.crx` is a header plus an ordinary zip: `Cr24`, version, header length,
  then the zip. Stripped and handed to `Expand-Archive`, so no zip
  dependency.

**The API ceiling, measured rather than assumed** -- `Object.keys(chrome)`
in a service worker with every permission requested:

    action, alarms, declarativeNetRequest, dom, extension, i18n, idle,
    management, offscreen, proxy, runtime, scripting, storage, tabs,
    webRequest

Absent: `contextMenus`, `cookies`, `notifications`, `webNavigation`,
`downloads`, `history`, `bookmarks`, `commands`, `sidePanel`, `permissions`.
Extensions leaning on those will throw. There is also no `onClicked` for an
action without a popup, which is why such buttons are drawn inert.

**`declarativeNetRequest` is only half there, and the half that is missing
is the one ad blockers use.** Measured, both ways:

- Static `rule_resources` declared in the manifest are **ignored**. A test
  extension whose only ruleset blocked `iana.org` blocked nothing.
- Dynamic rules via `updateDynamicRules()` **do** block. The same rule added
  at runtime from a service worker worked.

So a blocker can only work here if it installs its rules at runtime.
**uBlock Origin Lite does not work** and was tried: its service worker dies
immediately on `browser.permissions.onRemoved` (no `permissions` API), and
its filtering is six static rulesets, which are ignored regardless. Do not
assume a namespace existing means the feature works -- check that it has an
effect.

## The ad blocker

`adblock.js` is the engine; `main.js` keeps the lists on disk and current.
It is in the browser rather than in an extension because Electron ignores
the static rulesets extensions declare in their manifests, which is exactly
how ad blockers ship filters -- see the extensions section above.

EasyList and EasyPrivacy, refreshed every five days, cached in
`<userData>/Filters`. Measured on the real lists: **107,061 network rules
and 16,304 hiding selectors, parsed in 318 ms, 69.8 MB of heap, 0.0062 ms
per request** -- about 3.7 ms added to a 600-request page.

- **`onBeforeRequest` runs on every request, so matching cannot be linear.**
  Rules are filed under a substring that must appear in the URL, and a
  request only tests the buckets its own tokens implicate. Only 62 rules
  have no usable token and are tested every time.
- **The single biggest win was skipping regex entirely for `||host^`.**
  That shape is most of a filter list, and a walk up the request host's own
  labels answers it exactly. Adding that fast path cut heap from 117 MB to
  70 MB, parse time from 954 ms to 318 ms, and per-request cost by 9x.
- **A filter with no type option must never match `document`.** Otherwise
  the first ad rule to match blanks the whole tab. `shouldBlock` refuses
  `mainFrame` outright as a second guard.
- **A rule carrying an option this engine does not implement is dropped**,
  not applied without it. A filter enforced more broadly than its author
  wrote it breaks pages.
- Only domain-specific cosmetic rules are kept. The generic ones are tens of
  thousands of selectors and would cost more than they are worth on every
  page.
- Parsing blocks the main process for ~300 ms, so it happens 2.5 s after
  launch, not in front of the window.
- `adblock.js` had to be added to `build.files` -- that array is an
  allowlist.

## Google sign-in and supervised accounts

A Google sign-in that fails here is not automatically the browser's fault.
The failure seen in this project was **"Accounts managed by Family Link are
not allowed to sign in here"** -- Google declining a supervised account in a
custom browser, because parental controls cannot be enforced in one. It is
an account policy, not a bug, not a detection of anything Aurora does, and
not something to engineer around.

Worth recording because it was misdiagnosed first: the WebAuthn refusal
preload was blamed, on the theory that replacing `navigator.credentials.get`
left a non-native `toString()` for Google's integrity checks to notice. That
theory was plausible, unverified -- the password step cannot be reached
without credentials -- and wrong. The screenshot of the actual error settled
it in one line. **Get the exact error text before theorising.**

The preload was rewritten as a `Proxy` anyway, which is strictly better:
`toString()` still reports `[native code]` and `PublicKeyCredential` is left
in place.

## Two traps worth remembering

- **Never touch `win.webContents` inside a `closed` handler.** The window is
  already gone and it throws "Object has been destroyed" -- inside an event
  handler, which Electron shows as an uncaught-exception dialog at the exact
  moment you are quitting. Read `webContents.id` once when the window is
  built and keep it. It does not reproduce on every close, so a clean test
  run does not mean the hazard is gone; the fix has to be structural.
- **Anything the shell loads at startup runs unattended.** The sidebar used
  to load Gmail at boot even while the sidebar was collapsed, so a Google
  sign-in page was running -- and raising a modal Windows dialog -- behind a
  panel that was not on screen. Boot now skips it when collapsed and loads
  on open instead.

## Running under WSL2 (because Smart App Control blocks the Windows build)

As of 9 Sep 2026 SAC blocks the unsigned Electron binary from running on
Windows at all, and SAC has no per-app allow-list. The user will not turn
SAC off (one-way). The solution in use: **run Aurora as a Linux app inside
WSL2**, which SAC does not gate, displayed on the Windows desktop via WSLg.

Setup that exists on this machine:

- Distro **Ubuntu-24.04**, user **aurora** (passwordless sudo). WSL 2.7.10
  with WSLg 1.0.73 was already present; only a distro was missing.
- The app is a fresh clone at **`/home/aurora/aurora-src`** (from GitHub, so
  its own `updateFromGit` keeps it current). It is a *separate checkout*
  from the Windows dev copy at `C:\Users\vihaa\Aurora`.
- **Node must be 22**, via nvm (`~/.nvm`). The apt Node 18 cannot download
  the Electron binary (`ERR_REQUIRE_ESM` in electron's postinstall). Even
  under Node 22, npm's postinstall silently skipped the download once;
  running `node node_modules/electron/install.js` directly fetched it.
- `chrome-sandbox` must be `root:root` mode `4755`, or Chromium refuses to
  start without `--no-sandbox`.
- Launch env needs `DISPLAY=:0` (WSLg). `/home/aurora/aurora-run.sh` sets it
  and execs `node_modules/electron/dist/electron` **directly** (not the
  `.bin/electron` shim, which needs node on PATH — nvm's node is not there
  for a non-login launch).
- The Windows Start Menu / Desktop **Aurora** shortcut runs
  `"C:\Program Files\WSL\wslg.exe" -d Ubuntu-24.04 -u aurora --cd "~" --
  /home/aurora/aurora-run.sh` — the same way WSLg's own auto-generated
  "Aurora (Ubuntu-24.04)" entry launches it. `wslg.exe` is windowless (no
  console, so no `.vbs` wrapper) **and** it makes WSLg associate the window
  with the app, which is what gets the real icon instead of a bare penguin
  (see below). An earlier launcher used `wscript.exe` + a `.vbs` calling raw
  `wsl.exe`; that worked but WSLg never associated the window, so the taskbar
  showed a generic penguin.
- **The launcher must NOT live under `AppData`.** This sandbox redirects
  `AppData` writes into a private container mirror, so a `.vbs` written there
  exists for the agent but not for the real user's click ("Can not find
  script file"). Real vs mirrored was settled by reading a path back through
  WSL (`/mnt/c/...` sees the true disk): profile root is real, `AppData` is
  mirrored. The launcher lives at `C:\Users\vihaa\AuroraWSL\`.
- **The launch must stay attached, not detach.** A `setsid ... &` that
  returns immediately gets killed when WSL tears down the one-shot session,
  so the window never appears. `aurora-run.sh` execs electron in the
  foreground; the `.vbs` (`Run` window mode 0) hides the console.

**WSLg cannot project Chromium's GPU-composited surface** (it presents via
GL/dmabuf, which weston can't copy over its RDP link), so with default GPU
the window is created correctly (right size, title "Aurora" — confirmed via
`xwininfo`) but shows on the Windows side as a blank placeholder with a
penguin icon and a "copy mode" title.

The fix that stuck is **native Wayland**: `aurora-run.sh` passes
`--enable-features=UseOzonePlatform --ozone-platform=wayland --class=aurora`.
As a Wayland client the window is composited by weston directly (GPU, host
side) instead of going through the Xwayland → software-copy path, so
scrolling is smooth and the window shows. It also fixes input feel.

The road here, so nobody re-walks it: default GPU on X11 → blank ("copy
mode"). `LIBGL_ALWAYS_SOFTWARE=1 --disable-gpu` → visible but every page
renders in software, *slow*. `--disable-gpu-compositing` alone → visible and
page-load fast, but **scrolling** janky, because compositing (which drives
scroll) was on the CPU; obvious on the new tab page, whose aurora background
uses heavy blur. Native Wayland → weston composites on the GPU, smooth.
Caveats: WSL exposes no DRM render node, so Chromium's own GL is software and
**WebGL is blocklisted** (`--ignore-gpu-blocklist` / swiftshader if a page
needs it); and a Wayland window is not an X window, so `xwininfo`/`import`
can't see or screenshot it — verify via `/mnt/wslg/weston.log` and the user.

Related new-tab fix: `backdrop-filter: blur()` was removed from the search
box and app tiles (commit 88796ff). Re-blurring the moving background every
scroll frame with no GPU raster was the jank; plain translucent fills over
the already-90px-blurred aurora look the same.

The `.ico` window-icon warning is fixed (icon.png + a platform `appIcon`).
The default app menu is removed with `Menu.setApplicationMenu(null)`, or it
shows as a real menu bar above the toolbar on Linux. The window is
`frame: false`: WSLg draws a light title bar that can't be themed, so the
browser wears its own toolbar (already a drag region) plus min/max/close
buttons over a `window-control` IPC.

**Taskbar icon — as good as WSL allows.** The plain penguin came from
launching via raw `wsl.exe`, which WSLg never associates with the app. The
real icon needs three things together: a themed icon (`Icon=aurora`,
`aurora.png` under `hicolor/*/apps` in **both** `~/.local/share/icons` and
`/usr/share/icons` + `gtk-update-icon-cache`), an `aurora.desktop`
(`StartupWMClass=aurora`, no `NoDisplay`) in `/usr/share/applications`, and
**launching via `wslg.exe`** so WSLg does the association. With all that,
WSLg generates its own `WSLDVCPlugin/.../aurora.ico` and the taskbar shows
the Aurora orb — **but WSLg composites a small Tux penguin badge onto the
corner of every Linux app icon, and there is no toggle for it.** So orb-plus-
badge is the ceiling; a fully penguin-free icon is not achievable under WSL.
Confirmed by converting that generated `.ico`: our orb with a Tux corner.

Known gaps in the Linux build, not yet fixed:

- **The profile is fresh.** userData is `~/.config/Aurora` in Linux, so
  Google sign-in, bookmarks, history and tabs all start empty. Chromium
  encrypts cookies per-OS, so the Windows profile could not be copied over
  even if wanted.
- The auto-updater's `npm install` step (on a manifest change) may not find
  node on PATH under the launcher; `git pull` of JS still applies.

## Shipping a change


**Smart App Control is enforced on this machine, and as of 9 Sep 2026 it
blocks the app from running at all** -- not just from being packaged. It
had blocked installer builds for a while (truncating a 1.0.1 build to 188KB
mid-write); running from source still worked. It no longer does:

    Start-Process : An Application Control policy has blocked this file.

CodeIntegrity/Operational logs it as event 3077/3118 against
`node_modules\electron\dist\electron.exe`, which is **unsigned** (checked:
`Get-AuthenticodeSignature` reports `NotSigned`). SAC blocks unsigned
binaries it has no reputation for, and its verdict on this one changed
between 15:5x and 16:00 on that day -- nothing in the repo changed.

There is no code-side fix. SAC is not path-based, and a self-signed
certificate does not satisfy it. The only lever is the Smart App Control
setting itself, which **can only ever be turned off, never back on without
reinstalling Windows** -- so it is the machine owner's decision, not one to
make on their behalf. Diagnose with:

    (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy').VerifiedAndReputablePolicyState
    # 0 = off, 1 = enforced, 2 = evaluation

If packaging is unblocked later: bump `version` in `package.json`, then
`$env:GH_TOKEN = "..."; npm run release`. The repo (public) is
`ChaosWolfLord/mybrowser`. `npm start` skips auto-update entirely via the
`app.isPackaged` guard.
