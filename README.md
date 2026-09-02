# My Browser

A personal desktop browser (built on Chromium via Electron) for Windows, with
Gmail, Calendar, Drive, YouTube, and Claude always available in a side panel
next to your normal browsing tabs. One Google sign-in applies everywhere in
the app. Your open tabs are remembered across restarts. Updates download and
install themselves silently in the background.

## One-time setup

### 1. Install Node.js
Grab the LTS installer from [nodejs.org](https://nodejs.org) if you don't
already have it.

### 2. Install dependencies
Open a terminal (PowerShell or Command Prompt) in this folder and run:
```
npm install
```

### 3. The GitHub repo that hosts updates  (done, with one thing left)
Silent auto-updates work by checking a GitHub repo for new releases, which
is what avoids paying for a code-signing certificate.

The repo already exists and this project is already pushed to it:
**https://github.com/ChaosWolfLord/mybrowser**

**One thing still to do:** the repo is currently *private*, and
electron-updater cannot read releases from a private repo without a token
baked into the shipped app. Until it is public, the update check fails
silently every time. To fix it, go to the repo's **Settings -> General ->
Danger Zone -> Change visibility -> Make public**. Nothing sensitive lives
in here: it is about 700 lines of UI code plus the installer.

### 4. Create a GitHub token (needed only to publish new versions, not to run the app)
1. Go to **github.com -> Settings -> Developer settings -> Personal access
   tokens -> Fine-grained tokens -> Generate new token**.
2. Scope it to just the `mybrowser` repo, with **Contents: Read and write**
   permission.
3. Copy the token somewhere safe -- you'll set it as `GH_TOKEN` whenever you
   publish a new version (see below).

### 5. Build and install the app
```
$env:GH_TOKEN = "your_token_here"
npm run release
```
This builds a Windows installer and uploads it to a GitHub Release in your
repo. Find the installer in the `dist` folder (`My Browser Setup 1.0.0.exe`),
run it once — that's the "permanent install" step. It puts a shortcut in your
Start Menu like any normal app. Windows will likely show a SmartScreen
warning the first time since the installer isn't code-signed; click **More
info → Run anyway**. This only happens on this first manual install, not on
future auto-updates.

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
| `package.json` | Dependencies + electron-builder/publish configuration |
