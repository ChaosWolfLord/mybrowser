# How This Browser Works

This is a real web browser. Not a toy, not a website pretending to be one —
it opens tabs, loads any site, blocks trackers, keeps history and bookmarks,
and lives in the Start Menu like Chrome does. One person built it.

This document explains how, from the outside in. You don't need to already
know how browsers work. You do need to be okay reading a bit of code-shaped
English.

---

## 1. The cheat code: nobody builds a browser from scratch

Here's the thing people get wrong. When you imagine "building a browser,"
you probably imagine writing the part that turns HTML into pixels — fonts,
images, layout, video, JavaScript, HTTPS. That part is genuinely one of the
hardest things humans have ever written. Chrome's engine is tens of millions
of lines of code and took thousands of engineers decades.

So we didn't write it. We **borrowed** it.

Chrome's engine is open source and free to use. It's called **Chromium**.
There's a toolkit called **Electron** that hands you Chromium in a box, plus
the ability to write normal desktop-app code around it. Discord, VS Code,
Slack, Spotify's desktop app — all Electron.

That means:

> **Everything hard about displaying a webpage: already solved.
> Everything about being a *browser* — tabs, an address bar, history,
> bookmarks, blocking ads — that's the part we wrote.**

This browser is about 2,500 lines of our code sitting on top of roughly
30 million lines of somebody else's. That ratio isn't cheating; it's how
essentially all software works. You stand on a huge pile of existing work
and add the part that didn't exist yet.

---

## 2. The two brains

This is the single most important idea in the whole program. If you only
remember one thing, remember this.

The app is split into **two kinds of process** — two separate running
programs that talk to each other.

### The main process — "the manager"

There's exactly one. It's `main.js`. It's the only part allowed to touch
the actual computer: read and write files, create windows, watch the
network, quit the app.

Think of it as the manager of a restaurant. Access to the safe, the
supplier accounts, the keys.

### The renderer processes — "the dining room"

These display things. The browser's own interface is one. **Every single web
page you open is another one.** Ten tabs open means ten-ish separate
processes running at once.

These are the dining room. Guests sit here. Guests are *not* allowed in the
office, and they definitely don't get the keys to the safe.

### Why bother splitting them?

Two reasons, and both matter enormously.

**Crashes stay small.** If a page runs out of memory and dies, it takes down
one process. The tab shows an error; the rest of the browser doesn't blink.
Before browsers worked this way, one bad page killed everything you had open.

**Websites are strangers.** Any page you visit is running code written by
someone you've never met. If that code found a bug in the engine and escaped,
you'd want it to land somewhere harmless — a locked room with no file access
— rather than in the process that can read your documents.

So the rule this browser follows, everywhere, without exception:

> **A web page can never touch your computer directly. Ever. It has to ask.**

---

## 3. Asking: the slot in the door

If pages can't touch anything, how does the browser save your tabs when you
close it?

Through a deliberately tiny opening called **IPC** — inter-process
communication. Picture a locked door with a narrow slot. You can pass a note
through. You cannot climb through.

Our slot is `preload.js`, and it's short on purpose. It offers a specific
list of things the interface may ask the manager to do:

- save my list of tabs / give it back
- add this page to history / search history
- list, add or remove a bookmark
- read a setting / change a setting
- tell me when a download's progress changes

That's roughly it. Notice what's *not* on that list: "read any file,"
"run any program," "delete this folder." Those were never offered, so
they can never be requested. A door with no handle can't be opened by
picking the lock.

There's a detail here worth appreciating. The list is written down *once*,
in one small file. Anyone reviewing this browser's security can read that
one file and know the complete set of things a page could ever ask for. If
it's not there, it can't happen. Making the dangerous surface *small enough
to read* is often better security than making it clever.

---

## 4. A tab is a browser inside a browser

The browser window is itself a web page. Seriously. The tab strip, the
address bar, the buttons — that's HTML and CSS, in `index.html` and
`styles.css`, styled the same way any website is.

So how do you put a website *inside* a website?

A special element called a **`<webview>`**. It's like an iframe with much
stronger walls: its own process, its own memory, no access to the page
containing it. Each tab is one. The five sidebar apps are five more.

This creates a funny problem that took real debugging to notice. Because a
webview is a separate program, **keyboard presses inside a page never reach
the browser's interface.** Press Ctrl+F while reading an article and the
shortcut would just... not happen. The interface never heard the key.

The fix: the manager process listens for keys *before* the page gets them,
recognises the ones we've claimed, swallows those, and re-sends them to the
interface as messages. It works so smoothly you'd never guess — which is
exactly the point, and also why this is the kind of bug that survives to
release if nobody tests shortcuts while actually reading a page.

---

## 5. Where your stuff lives

Nothing is in the cloud. Nothing is on anyone's server. It's all files on
this computer, in the app's data folder.

| File | Holds |
|---|---|
| `tabs.json` | Which tabs were open, so they come back |
| `history.json` | Pages you've visited (last 5,000) |
| `bookmarks.json` | Saved pages, with their icons |
| `settings.json` | Every switch on the settings page |
| `Partitions/main/` | Cookies and logins — the part that keeps you signed in |

You can open the first four in Notepad. They're just text. That's not a
weakness; being able to look at your own data is a feature.

One detail that's more interesting than it looks: **history is not written
to disk every time you visit a page.** It's kept in memory and saved every
15 seconds, plus when you quit. If it saved on every navigation, a fast
browsing session would rewrite the entire file dozens of times a minute for
no reason. Writing less often is what makes it feel instant.

---

## 6. Not trusting web pages

Beyond the two-process split, the browser actively defends you. Every one of
these is a switch on the settings page.

**Tracker and ad blocking.** Before *any* request leaves your computer, it's
checked against a list of known tracking and advertising servers. Match, and
it's cancelled — the request never happens. This is a privacy feature that
happens to also be the single biggest speed-up available, because a shocking
amount of a slow page is other people's analytics.

**Tracking-tag stripping.** Ever seen a link like
`shop.com/thing?utm_source=twitter&fbclid=A8sk2...`? Those tags don't change
the page. They exist to tell the site where you came from. The browser
quietly removes about 25 of them from links you open.

**HTTPS upgrade.** `http://` means anyone on the same Wi-Fi can read what
you're sending. `https://` is encrypted. Ask for `http://`, get `https://`.

**Permissions default to no.** A page asking for your camera, microphone, or
location gets refused instantly — you're not even interrupted with a popup.
The only things allowed are notifications and clipboard, and both have
switches.

**WebRTC leak protection.** There's a video-call feature in every browser
that pages can abuse to learn your computer's address on the local network
— *even through a VPN*. It's confined so they can't.

**Downloads that won't run.** Files save normally, but if you download a
`.exe` or `.bat`, the Open button becomes Show. It opens the folder instead
of the program. Running something dangerous should take a deliberate step
outside the browser, not one click inside it.

---

## 7. Making it fast, and a ten-second mystery

Two speed ideas, then a story about being wrong.

**Nothing loads until you look at it.** The five sidebar apps used to all
load the instant the browser opened — five heavyweight web apps racing each
other before you'd done anything. Now each waits until you first click it.
Same for restored tabs: reopen with twelve tabs and only the one you were
actually looking at loads. The other eleven are just names until clicked.

**The window appears before it's finished.** It shows immediately, then
fills in, because a window that appears instantly and populates feels far
faster than a correct window that appears half a second later. Perceived
speed and actual speed are different things.

### Now the story.

At one point the browser took **ten full seconds** to open. Obviously
something in the code was slow. The obvious suspect was the tracker blocker,
since it inspects every single request.

Instead of guessing, we measured — and the tracker blocker turned out to
cost **8.9 milliseconds across 577 requests.** Roughly 0.015ms each.
Basically free. Not the problem, not close.

So we tried loading a **completely blank page**. No tabs, no sidebar, no
tracker blocking, nothing. Ten seconds.

That result is what cracked it. If an empty page is just as slow, the
problem cannot be in the code — there *is* no code running. It had to be
the environment.

It was the folder. The project was in OneDrive, and OneDrive replaces your
files with placeholders that get fetched on demand. Every file read goes
through OneDrive's machinery — and starting a browser reads thousands of
files.

| Where it lived | Time to a usable window |
|---|---|
| OneDrive folder | **10,337 ms** |
| Normal folder | **356 ms** |

Same code. Twenty-nine times faster. The fix was moving a folder.

**The lesson is worth more than the fix.** The instinct was to optimise the
code, and doing that would have produced a slightly faster tracker blocker
and a browser that still took ten seconds. Measuring first said "not here."
Testing a blank page said "not the code at all." When your program is slow,
find out *where* before deciding *what* — and try the empty version, because
what a program does when it does nothing tells you what it costs before it
even starts.

---

## 8. How it updates itself

There's no download page. The browser's own folder is a **git repository**,
connected to the copy on GitHub.

Thirty seconds after it opens, and every four hours after that, it quietly
checks GitHub for new code and pulls it. The next time you open the browser,
you're running the new version. You are never asked, never interrupted, and
never see a progress bar.

One safety catch: it only accepts changes that stack cleanly on top of what's
there. If someone edited the files locally, the update *fails loudly* rather
than overwriting their work. A tool that silently destroys your changes to
stay up to date is a bad tool.

---

## 9. The map

| File | What it does |
|---|---|
| `main.js` | The manager. Windows, security, network filtering, history, downloads, bookmarks, settings, updates |
| `preload.js` | The slot in the door. The complete list of what the interface may ask for |
| `index.html` | The shape of the window: tab strip, address bar, sidebar |
| `renderer.js` | The interface's brain. Tabs, address bar, find, zoom, bookmarks, settings screen |
| `styles.css` | Every colour, size and animation |
| `newtab.html` / `newtab.js` | The new tab page, including the colour fields that move away from your mouse |
| `icon.svg` / `icon.ico` | The app icon, and the built Windows version of it |
| `tools/make-icon.js` | Turns the drawing into a real icon file |

---

## 10. Things that surprised us

Real bugs from building this. Every one of them is a lesson that generalises.

**The browser was showing an old Gmail.** Sidebar Gmail looked years out of
date. It wasn't a layout problem — every browser announces what it is, and
this one was announcing a version of Chrome from two years earlier because
that text had been typed in by hand once and never updated. Google serves a
stripped-down old interface to browsers it thinks are ancient. *Anything you
write down by hand will eventually be a lie. Ask the program what version it
is instead of telling it.*

**A search box that silently did nothing.** A security rule was added listing
what the new tab page is allowed to do. The list was slightly too strict and
accidentally banned the page's own search box from submitting. No error, no
warning — pressing Enter just did nothing. *Security rules break features
silently. That's what makes them dangerous to add without testing.*

**Links that opened nothing.** Clicking a "opens in new tab" link did
absolutely nothing for weeks. The code handling it was listening for an event
Electron had *deleted* three versions earlier. The code was perfectly
correct; it was just waiting for a phone call that would never come. *Code
that stops being called doesn't announce itself. It just goes quiet.*

**Making it faster made it less safe.** The tracker blocker was sped up by
reading web addresses with a shortcut instead of parsing them properly. It
worked — four times faster. It also meant a tracker could disguise itself
with a specially crafted address and walk straight through the blocklist.
Caught only because the new version was tested *against the old one* rather
than just timed. *Fast and correct are different goals, and speeding
something up is a great way to quietly break it.*

**An app that couldn't find itself.** The Start Menu shortcut launched and
immediately reported it couldn't find the app. Both halves of the shortcut
were pointing at the same folder — except one had been quietly redirected
somewhere else, so the same text meant two different places. *"It works on
my machine" usually means the machine, not the code.*

---

## The actual takeaway

None of the individual pieces here are magic. A tab is a page inside a page.
Saving is writing a file. Blocking an ad is checking a name against a list
and saying no. Updating is downloading new code.

What makes it a *browser* is that a few hundred small, understandable
decisions are stacked up and made to work together — and then hammered on
until the rough edges are gone.

That's most software. It's not one brilliant idea. It's a lot of ordinary
ideas, arranged carefully, plus the patience to keep going after the tenth
weird bug.

The tenth weird bug is where you learn the most anyway.
