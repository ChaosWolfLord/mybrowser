# My Browser

A personal desktop browser (built on Chromium via Electron) for Windows, with
Gmail, Calendar, Drive, YouTube, and Claude always available in a side panel
next to your normal browsing tabs. One Google sign-in applies everywhere in
the app. Your open tabs are remembered across restarts. Updates download and
install themselves silently in the background.

## Installing it

The browser runs from source, launched from the Start Menu like any other
app. The installed copy lives at `%LOCALAPPDATA%\MyBrowser` and is a git
clone of this repository, which is also how it updates itself.

**It must not run from the OneDrive folder.** That is not a preference:

| Location | Time to a usable window |
|---|---|
| OneDrive | **10.3 seconds** |
| `%LOCALAPPDATA%\MyBrowser` | **0.36 seconds** |

OneDrive Files On-Demand turns every file into a placeholder that its filter
driver has to service on each read, and starting a browser reads thousands
of files. Keep the repository wherever you like; run the local clone.

To set it up from scratch:

```
git clone https://github.com/ChaosWolfLord/mybrowser.git "$env:LOCALAPPDATA\MyBrowser"
cd "$env:LOCALAPPDATA\MyBrowser"
npm install
```

Then make a Start Menu shortcut pointing at
`%LOCALAPPDATA%\MyBrowser
ode_modules\electron\dist\electron.exe`
with `%LOCALAPPDATA%\MyBrowser` as both the argument and the working
directory. `electron.exe` is a windowed program, so it opens no console.

## Updating

Nothing to do. Thirty seconds after launch, and every four hours after
that, the browser runs `git pull --ff-only` on its own clone in the
background; the new code runs the next time you open it. If dependencies
changed, it reinstalls them too.

The pull is `--ff-only` deliberately, so if you ever edit files in the
running clone the update fails loudly rather than overwriting your work.

## From here on: just open it from the Start Menu

- **Auto-updates**: every time you open the app, and every 4 hours while
  it's running, it quietly checks `github.com/ChaosWolfLord/mybrowser` for a
  newer release, downloads it in the background, and installs it the next
  time you close the window -- never interrupting you mid-session. (This
  needs the repo to be public; see step 3.)
- **Your tabs are restored** exactly where you left them each time you
  reopen it.

## Shipping a future update

Whenever you want to change something (ask me, or edit the files yourself):

1. Make your changes.
2. Bump the `"version"` field in `package.json` (e.g. `1.0.0` → `1.0.1`).
3. Run:
   ```
   $env:GH_TOKEN = "your_token_here"
   npm run release
   ```
That's it — every copy of the app already installed on your computer will
find and install that update automatically within a few hours, with no
action from you.

## Signing into Google — important note

Google actively tries to detect embedded/automated browsers and can block
sign-in with a *"this browser or app may not be secure"* message. This app
sets a normal desktop Chrome user-agent on every panel to avoid that, which
works for most people. If you hit that block anyway, sign in from the
**Gmail panel first** — Calendar, Drive, YouTube, and Claude will inherit
that same session automatically.

## The sidebar

Five apps, switchable via the icon strip on the right — all five stay loaded
in the background so switching is instant:

| Icon | App | Accent color |
|---|---|---|
| Envelope | Gmail | amber `#C98A3E` |
| Calendar | Calendar | teal `#6C9A93` |
| Drop | Drive | blue `#7C93B0` |
| Play | YouTube | brick `#B85C4A` |
| Star | Claude | violet `#8B7EC8` |

**Fitting the panel:** Gmail and Calendar lay out a fixed-width desktop
interface that does not reflow, so they are scaled to whatever width the
sidebar currently is. Drag the sidebar's edge and they rescale with it, live.
Drive, YouTube and Claude are responsive on their own and sit at 100%.

The percentage at the bottom-right shows the current scale, dimmed while it
is being worked out automatically. The `-` and `+` buttons override it for
that app if you would rather set it yourself; clicking the percentage hands
control back to the automatic fit.

There is a floor of 35% -- past that the text stops being readable, and the
answer is a wider sidebar rather than a smaller Gmail.

**Want ChatGPT instead of Claude?** In `index.html`, find the line with
`id="panel-assistant"` and change `src="https://claude.ai"` to
`src="https://chatgpt.com"`. That's the entire change.

## The new tab page

Three fields of colour in the app's accent hues, blurred past recognition,
drifting on their own slow cycles -- and they move away from your pointer
like something viscous. The nearest one shoves hardest, the far ones stir a
little, and they take their time settling back; that lag is what makes it
read as liquid rather than parallax. The search box and shortcuts are
frosted so the colour shows through them.

It costs almost nothing: three composited layers moving on `transform` only,
the animation stops itself once everything settles, and it holds still
entirely if you have asked your system to reduce motion.

## Keyboard shortcuts

| Keys | Does |
|---|---|
| `Ctrl+T` / `Ctrl+W` | New tab / close tab |
| `Ctrl+Shift+T` | Reopen the tab you just closed |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+L` | Jump to the address bar |
| `Ctrl+F` | Find in page (`Enter` next, `Shift+Enter` back, `Esc` closes) |
| `Ctrl+H` / `Ctrl+J` | History / downloads |
| `Ctrl+` `+` / `-` / `0` | Zoom the page in, out, or back to 100% |

Page zoom is remembered per site, so a site you always squint at stays
zoomed the next time you open it.

Middle-click a tab to close it. Right-click anywhere in a page for the
usual menu: open link in new tab, copy link, copy image, search the
selection, back, reload, inspect.

## History and the address bar

Every page you visit is recorded, and the address bar suggests from that
history as you type. Matching the *start of a hostname* is what ranks
highest, so typing `gi` offers github.com rather than some page with "gi"
buried in its title. Arrow keys walk the list, `Enter` takes the highlighted
one, `Esc` dismisses it.

`Ctrl+H` opens the full history: searchable, with a delete button on each
row and a Clear all. It holds the last 5000 pages and is written to
`history.json` in the app's data folder.

## Downloads

Files save straight to your Downloads folder, the way any browser does, and
`Ctrl+J` shows them with live progress, Open, and Show-in-folder. Nothing is
ever overwritten -- a second copy of the same file becomes `name (1).ext`.

Executables are treated differently on purpose. A `.exe`, `.msi`, `.bat`,
`.ps1` and friends will not launch from inside the browser; the Open button
becomes Show, which reveals the file in Explorer. Running one stays a
deliberate act outside the browser rather than one click inside it.

## The menu

The three-dot button in the toolbar holds history, downloads, and the
clearing controls:

- **Sign out of all sites** -- removes cookies and logins. Because all five
  sidebar panels deliberately share one session (that is what makes a single
  Google sign-in cover everything), this signs you out of Claude and YouTube
  as well, not only Google. Your history, tabs and preferences survive it,
  and nothing changes on the accounts themselves. Use this if you sign in
  with the wrong account.
- **Clear cache** -- frees space, keeps you signed in.
- **Clear browsing history** -- empties the list and the address bar's
  suggestions.

## Knowing something is happening

A loading tab swaps its favicon for a spinner, and a thin amber sweep runs
along the bottom of the toolbar while the tab you are looking at is still
fetching. The sweep is deliberately indeterminate: Chromium reports no real
progress figure for an embedded page, so a bar that filled up would be
inventing one.

## Bookmarks

The star at the right of the address bar saves the page you are on, or
`Ctrl+D`. Saved pages appear on a strip under the address bar; click one to
open it, hover for the small x to remove it. Right-clicking a link gives you
**Bookmark link** without opening it first.

The strip hides itself when you have nothing saved, and can be turned off in
Settings. Bookmarks live in `bookmarks.json` in the app's data folder, and
only ordinary `http`/`https` pages can be saved.

## Settings

Opens as a **tab**, with `Ctrl+,` or from the menu. It is not a website: it
is part of the browser, drawn by the browser, and it cannot be loaded from
anywhere. Close it like any other tab.

### What is on it

Everything protective is a switch rather
than a decision baked into the code, and a switch that is off costs nothing
-- the request handler behind it is torn down rather than left running and
deciding to do nothing.

| Setting | Default | What it does |
|---|---|---|
| Block trackers and ads | on | Refuses known tracking, analytics and ad hosts before the request leaves your machine |
| Strip tracking parameters | on | Removes `utm_*`, `fbclid`, `gclid` and 20-odd others from addresses you open |
| Always try HTTPS first | on | Upgrades plain `http://` pages; loopback exempt so local dev servers work |
| Do Not Track + Global Privacy Control | on | Sends `DNT` and `Sec-GPC`. Most sites ignore DNT; `Sec-GPC` has legal weight in some places |
| Trim referrers between sites | **off** | Sends the origin but not the page. Off because it breaks images on sites that check the referrer |
| Hide local address from WebRTC | on | Stops a page discovering your machine on the local network, even through a VPN |
| Allow notifications | on | Everything unlisted is refused outright and never prompts: location, camera, microphone, MIDI, USB, serial |
| Allow clipboard reading | on | |
| Clear history on exit | off | Does not sign you out; cookies untouched |

The page also carries the clear-data buttons and a count of how many
tracking requests have been refused since the browser started.

Settings live in `settings.json` in the app's data folder. Only keys the app
already knows, holding booleans, are read back from it.

## Privacy and security

The browser blocks third-party tracking and ad hosts at the network layer
before the request leaves your machine. That is a privacy measure first, but
it is also the biggest single speed-up available -- on most pages a large
share of the loading time is other people's analytics. The list lives in
`BLOCKED_HOSTS` in `main.js`; trim it if a site you need misbehaves. Google's
own app domains are deliberately not on it, so Gmail and friends are
unaffected.

Also on by default:

- Plain `http://` pages are upgraded to `https://` (loopback exempt, for
  local dev servers).
- Site permissions default to **deny**. Only notifications and clipboard are
  allowed; geolocation, camera, microphone and the rest are refused without
  ever prompting you.
- Bad HTTPS certificates are never bypassed.
- Popups are blocked except for Google's sign-in window. Anything else that
  tries to open a window becomes an ordinary tab instead.
- Pages run with no access to Node, in a sandboxed renderer with context
  isolation, and cannot attach privileged webviews of their own.

## Startup speed

The sidebar's five apps no longer all load at launch -- each loads the first
time you open it, and the one showing at startup waits until the shell is
idle. Restored tabs work the same way: only the tab you were last looking at
loads immediately, the rest load when you click them.

## Customizing further

- **Add another sidebar app**: copy one `<webview>` block in `index.html`'s
  sidebar, plus its `.sbtab` icon button, give both a new `data-app` name,
  and add a matching entry to `sbPanels` in `renderer.js`.
- **Colors/spacing**: all in `styles.css`.
- **Launch at login**: you told me you didn't want this, so it's off. If you
  change your mind later, it's a one-line addition to `main.js` using
  `app.setLoginItemSettings({ openAtLogin: true })`.
- **Real Gmail/Calendar/Drive API features** (unread badges, quick-add
  events, searching Drive from the address bar): needs actual OAuth setup
  through Google Cloud Console — a bigger step up, happy to help when
  you're ready for it.

## Files

| File | Purpose |
|---|---|
| `main.js` | Electron entry point, shared session, auto-updater, tab-save/load |
| `preload.js` | Minimal, safe bridge for saving/restoring tabs |
| `index.html` | Layout: address bar, tabs, browsing pane, sidebar |
| `renderer.js` | Tab logic, address bar, sidebar switching, session restore |
| `styles.css` | All visual styling |
| `newtab.html` | The page shown in a fresh tab |
| `icon.svg` / `icon-small.svg` | Icon artwork; the small one is used below 48px |
| `icon.ico` | Built from those by `npx electron tools/make-icon.js` |
| `package.json` | Dependencies + electron-builder/publish configuration |
