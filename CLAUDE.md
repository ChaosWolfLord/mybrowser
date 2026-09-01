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
| `main.js` | Electron entry, the shared `persist:main` session, auto-updater, tab read/write over IPC |
| `preload.js` | The only Node bridge: `window.tabStore.save/load`. Keep it this small |
| `index.html` | Layout: titlebar, tabstrip, browsing pane, sidebar, drag shield |
| `renderer.js` | Tabs, address bar, sidebar switching, sidebar sizing/zoom, session restore |
| `styles.css` | All styling. Dark warm palette, amber `#C98A3E` accent |
| `newtab.html` | The new-tab page |

Everything shares one session partition (`persist:main`), which is why a
single Google sign-in covers all five sidebar apps plus regular tabs.

## Things that will bite you

- **Webviews swallow mouse events.** Each `<webview>` is a separate
  renderer, so a drag started in the host page dies the moment the pointer
  crosses one. Any drag interaction needs `#drag-shield` (a transparent
  fixed overlay) switched on for its duration. The sidebar resizer does
  this; copy that pattern for anything similar.
- **Zoom resets on navigation.** `setZoomFactor` does not survive a panel
  navigating, so it is reapplied on every `dom-ready`. Don't "simplify" that
  into a one-time call.
- **Never persist resolved `file://` URLs.** `newtab.html` resolves to a
  real folder path in dev and to a path inside `app.asar` when packaged, so
  saving the resolved URL bakes in whichever one produced it. Normalise to
  the bare relative name via `isNewTabUrl()` before saving.
- **Google's embedded-browser detection.** Sign-in works right now because
  of three things together: the desktop Chrome UA (set both on the session
  in `main.js` and per-webview), `allowpopups` (the sign-in popup is
  silently blocked without it), and masking `navigator.webdriver`. If
  sign-in breaks after a Google change, suspect these first. Signing in
  from the **Gmail** panel seeds the session for the other four.
- **Preferences live in renderer `localStorage`**, not in `tabs.json`.
  Sidebar width and per-app zoom are there. Tabs go through IPC to
  `tabs.json` in userData.

## Shipping a change

Auto-update reads GitHub releases from `ChaosWolfLord/mybrowser`. Bump
`version` in `package.json`, then:

```
$env:GH_TOKEN = "..."
npm run release
```

The repo must be **public** for the update check to work -- electron-updater
can't read a private repo's releases without embedding a token in the app.

`npm start` runs from source and skips auto-update entirely
(`app.isPackaged` guard), so update behaviour can only be tested from a
built install.
