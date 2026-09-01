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

**Sizing it to taste:** drag the sidebar's left edge to make it wider or
narrower, and use the zoom controls in the bottom-right corner to scale the
app inside it. Zoom is tracked per app, so Gmail can sit at 80% while Claude
stays at 100%, and clicking the percentage resets that app to its default.
Both the width and the zoom levels are remembered between restarts.

Gmail, Calendar and Drive default to 80% because they decide between their
desktop and mobile layouts based on browser identity rather than the width
they actually have -- so in a narrow panel they still lay out a full desktop
UI, and zooming out is what gives them the room to fit it.

**Want ChatGPT instead of Claude?** In `index.html`, find the line with
`id="panel-assistant"` and change `src="https://claude.ai"` to
`src="https://chatgpt.com"`. That's the entire change.

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
