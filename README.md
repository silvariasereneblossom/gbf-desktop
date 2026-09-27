# Granblue Fantasy Desktop

A lightweight Electron wrapper for [game.granbluefantasy.jp](https://game.granbluefantasy.jp) that
lives in the system tray, keeps you on top of reset / dailies, and shows
[granblue.team](https://granblue.team) parties next to the game.

> **Disclaimer:** Unofficial fan project, not affiliated with or endorsed by Cygames or DeNA.
> Nothing here plays the game for you. Risk-wise the features fall into three tiers —
> unlike Viramate-style extensions, almost everything is **external to the game page**:
>
> | Tier | Features | Why |
> |---|---|---|
> | **External utilities** (no meaningful risk) | Tray/reminders/checklist, team viewer & assisted import (read-only [hensei-api](https://github.com/jedmund/hensei-api) data + navigation), ping meter, multiwindow, mouse bindings, proxy/Mudfish tools, multi-account, bookmarks, recording | Live entirely outside the game; server-side indistinguishable from a browser plus side tools |
> | **Compatibility / hygiene** | Login shims (FedCM hide, cookie unpartitioning), tracker blocking | Adjust *browser* behavior so login and loading work as in Chrome; zero gameplay effect. The community optimization guide treats ad blocking as safe |
> | **Mildly risky** (opt-in, off by default) | Battle auto-refresh, SkyLeap UA | Auto-refresh is literally an automated F5 after *your* action — but machine-timed. SkyLeap UA misrepresents the client (community-standard for years) |
> | **Risky** (opt-in, explicit consent gate) | Party auto-equip | The one feature that drives the game's own UI via injected script — the same category Cygames has acted against historically |
>
> Using the opt-in tiers is your own decision and risk.

## Install / update

Grab the installer from the [latest release](https://github.com/silvariasereneblossom/gbf-desktop/releases/latest).
After that, updates come to you: the app checks the releases feed at launch and every 6 hours,
and the tray right-click menu has **Check for updates** → downloads in the background →
**Restart & update to vX.Y.Z** (a pending update also applies automatically on next quit).

## Develop

```bash
npm install
npm start
```

Build a Windows installer locally: `npm run dist` (output in `dist/`).

**Pipeline:** every push/PR runs a build check on CI (installer kept 7 days as an artifact).
To ship a release: bump `version` in `package.json`, then

```bash
git tag v0.1.2 && git push origin v0.1.2
```

CI builds on a clean Windows runner and publishes the installer + update feed
(`latest.yml`/blockmap) to a GitHub Release, which installed apps pick up automatically.
`npm run release` does the same from a local machine (needs `GH_TOKEN`).

## What it does

| Area | Details |
|---|---|
| **Game** | Full-window game view with a persistent login session (`persist:gbf`), desktop-Chrome user agent, login popups (Mobage/Gree/Google) allowed in-session, other links open in your browser. |
| **Background** | Close → hides to tray (toggle in Settings). Tray menu shows time-to-reset, remaining dailies with jump links, launch-at-login. `Ctrl+Shift+G` summons the window from anywhere. |
| **Never throttled** | Runs at full speed while minimized, tray-hidden, or covered: occlusion detection and all Chromium background/timer throttling disabled (`CalculateNativeWinOcclusion`, `IntensiveWakeUpThrottling`, renderer backgrounding), `backgroundThrottling:false` on every view, and a `prevent-app-suspension` power-save blocker against Windows efficiency mode. Verified hidden-to-tray: timers at 100%, rAF at 60 fps, `document.hidden` stays `false` so the game never pauses itself. |
| **Reset & dailies** | Live countdown to 05:00 JST. Daily checklist auto-clears at reset; each row has a → that jumps to the right in-game screen. Notifications: at reset, N minutes before reset if anything is unchecked, optional hourly AP nudge, and custom local times. |
| **Battle auto-refresh** (opt-in) | Watches the game's `normal_attack_result` / `summon_result` / `ability_result` responses at the network layer and reloads the game view the instant the server has applied the action — the classic "F5 after attack". Toggle via Settings, the `⟳A` top-bar button, or the tray. Off by default; interrupts Full Auto. Grey area under Cygames' ToS — your call. |
| **Login plumbing** | Mobage login works in Electron only with three adjustments: hide FedCM's `IdentityCredential` from the game page (SDK otherwise insists on FedCM, which Electron can't serve), keep `window.opener` for the popup, and un-partition Mobage's CHIPS cookies (`Partitioned` stripped from `Set-Cookie` and `document.cookie`) so the session is visible to Mobage's iframes inside the game. `nav.log` in the data folder records the flow for diagnosis. |
| **Optimizations** (from the gbf.wiki micro-optimization guide) | SkyLeap UA mode (points on desktop, no game sidebar; pinnable game width, logins always use Chrome identity). Tracker blocker (microad/datadog/GA/etc cancelled at network layer — faster raid joins; toggle in Settings). GPU flags (`ignore-gpu-blocklist`, `enable-gpu-rasterization`, Fluent scrollbars). Live ping meter in the topbar, measured through the game session (includes proxy if set). Per-app proxy for the game session only (Mudfish SOCKS5 or any local proxy; Mudfish TUN mode needs nothing). Extra game windows (⧉ / tray) sharing the login for multiwindow flow/guarding/preloading/weaving. Mouse 4/5 → back / reload. Raid bookmarks (Pending / Backups / Raid ID) in quick-nav. |
| **Recording** | ● in the top bar, **F9** in the game, or the tray. Tab-captures only the game view (not the sidebar or desktop) with the game's own audio (not Discord/system; local playback keeps playing), keeps recording while minimized/in the tray, and never touches the game page. MP4 (H.264 + AAC; WebM fallback) at 30/60 fps, ~6 or ~12 Mbps, saved to `Videos\GBF Desktop`. Streams to disk as it goes (forced 2 s keyframes → a fragment every 2 s, so memory stays flat and a crash loses ≤2 s); quitting mid-recording finalizes the file first. |
| **Bookmarks** | Capture the page the game is on with **+ current page** — built for rotating GW raid pages — then jump back in one click; **Clear all** between events. |
| **Multiwindow layout** | ⧉ opens extra same-login game windows; auto-tiles main + extras into columns (grid past 4) and restores the main window when the last extra closes. ▦ re-tiles on demand. |
| **Teams** | Paste a granblue.team URL/shortcode or browse the *Explore* feed (same API as the site). Renders MC, characters (uncap/transcend/awakening), mainhand + grid weapons (keys, awakening), main/friend/sub summons — using the game's own art. Save teams for later. |
| **Into game — assisted** | Open the target party set in-game; the wrapper reads the deck number from the URL and lists every slot with an **Open** button that jumps the game straight to that slot's picker (`#party/list_weapon/pc/{deck}/{slot}/1/null/{rarity}/{element}` etc., pre-filtered). You tap Equip. Per-team done-checklist. No writes. |
| **Into game — auto-equip** (opt-in, red warning) | UI-level automation: drives the game's own views — opens the picker, finds your owned copy in the list the game loaded (by master id, nearest uncap), `tap`s it and then `.btn-equip`, with human-like pauses; stops on the first slot it can't resolve. No direct API calls — but still a client-side tool, which the ToS prohibits; shown only after accepting the risk. Untested against a live account at the time of writing (I can't log in) — the slot mapping is from the game's router source. |

Shortcuts inside the game view: `F5` reload · `Ctrl+B` toggle sidebar · `Ctrl +/−/0` zoom.

## What it deliberately does *not* do

- **Write a team into your account.** Pushing a party into the game would mean calling GBF's private
  endpoints — that violates the ToS and risks a ban. Teams are a side-by-side reference; build them in
  Party → Edit yourself.
- **Auto-play content.** "Automation" here means reminders, checklists and navigation, not botting.

## Layout

```
src/
  main.js        window, game/side views, tray, IPC, shortcuts
  reminders.js   JST reset math + notification scheduler
  teams.js       granblue.team (hensei-api) importer / explore
  store.js       JSON settings (stored in %APPDATA%/gbf-desktop/settings.json)
  icon.js        generates assets/icon.png on first run (no binary assets in repo)
  preload.js     contextBridge API exposed as window.gbf
  renderer/      sidebar UI (vanilla HTML/CSS/JS)
```

Debug aid: set `GBF_DEBUG_SHOT=<dir>` (and optionally `GBF_DEBUG_NOSHOT=1`) to auto-import a team,
dump sidebar DOM state / console to `<dir>`, and exit.

Game assets © Cygames. Team data via [hensei-api](https://github.com/jedmund/hensei-api).
