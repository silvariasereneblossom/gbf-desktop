const { app, BaseWindow, WebContentsView, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, globalShortcut, session, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const teams = require('./teams');
const party = require('./party');
const { Reminders, msUntilReset, notify } = require('./reminders');

const GAME_URL = 'https://game.granbluefantasy.jp/';
// GBF serves a proper page to desktop Chrome; hide the "Electron/" token.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Community-documented SkyLeap UA (gbf.wiki optimization guide): SkyLeap points on desktop, no game sidebar.
const SKYLEAP_UA = 'Mozilla/5.0 (Linux; Android 11; IN2023 Build/RP1A.201005.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Mobile Safari/537.36; SkyLeap/1.25.1';
const gameUA = () => (store.load().skyleap && store.load().skyleap.enabled ? SKYLEAP_UA : CHROME_UA);
// Account 1 keeps the original partition name so existing logins survive the multi-account update.
const partitionFor = (id) => (id === 1 ? 'persist:gbf' : `persist:gbf-${id}`);
const activePartition = () => partitionFor(store.load().activeAccountId || 1);

let win, gameView, sideView, tray, reminders;
let quitting = false;

if (process.env.GBF_USERDATA) app.setPath('userData', process.env.GBF_USERDATA); // isolated profile for dev/debug

// Mobage's JS SDK detects the login through third-party iframes (connect.mobage.jp session_iframe,
// app.mobage.jp proxy). Chromium partitions third-party storage/cookies by default, which makes the
// game never "see" the session after the popup logs in. Turn those protections off for this app.
//
// Mobage's SDK also switches to FedCM (navigator.credentials.get({identity})) whenever the page
// exposes `IdentityCredential`. Electron has no FedCM account-chooser, so that call fails with
// "Error retrieving a token." and login dies. We hide `IdentityCredential` from the *game page only*
// (see game-preload.js) so the SDK uses its classic popup flow, while Mobage's own frames keep the
// full FedCM surface (their pages call IdentityProvider.close() unguarded).
app.commandLine.appendSwitch('disable-features', [
  'ThirdPartyStoragePartitioning', 'ThirdPartyCookieDeprecation', 'TrackingProtection3pcd',
  'BlockThirdPartyCookies', 'PartitionedCookies', 'StorageAccessAPI', 'CookieDeprecationFacilitatedTesting',
  'ThirdPartyCookiePhaseout', 'PrivacySandboxSettings4', 'IsolateSandboxedIframes',
  // Keep the game fully alive while hidden/occluded (tray, minimized, covered by other windows):
  'CalculateNativeWinOcclusion', 'IntensiveWakeUpThrottling'
].join(','));
// Belt and braces for the same: no renderer backgrounding, no timer throttling, no occlusion backgrounding.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// gbf.wiki optimization guide's browser flags: force GPU compositing/rasterization even on
// blocklisted configs ("Override software rendering list" + "GPU rasterization"), and the
// Fluent overlay scrollbars that fix SkyLeap-mode scrollbars.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-features', 'FluentOverlayScrollbar,FluentScrollbar');

const single = app.requestSingleInstanceLock();
if (!single) app.quit();

// ---------- icon (generated if assets/icon.png is missing, so the repo needs no binaries) ----------
function ensureIcon() {
  const file = path.join(__dirname, '..', 'assets', 'icon.png');
  if (fs.existsSync(file)) return nativeImage.createFromPath(file);
  const { png } = require('./icon');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png(64));
  return nativeImage.createFromPath(file);
}

// ---------- diagnostics: nav.log in userData (host + path only, query strings stripped) ----------
function navLog(kind, text) {
  try {
    let desc = String(text).replace(/\s+/g, ' ').slice(0, 1500);
    try {
      const u = new URL(text);
      // Only keep the hash for the game itself (SPA routes); other hosts put tokens in fragments.
      desc = u.origin + u.pathname + (u.hostname === 'game.granbluefantasy.jp' && u.hash ? ' ' + u.hash.slice(0, 60) : '');
    } catch {}
    const file = path.join(app.getPath('userData'), 'nav.log');
    try { if (fs.statSync(file).size > 512 * 1024) fs.unlinkSync(file); } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} [${kind}] ${desc}\n`);
  } catch {}
}

async function logMobageCookies() {
  try {
    const all = await session.fromPartition(activePartition()).cookies.get({});
    const rel = all.filter(c => /mobage\.jp|mbga\.jp|granbluefantasy\.jp/.test(c.domain))
      .map(c => `${c.domain}:${c.name}[${c.sameSite || 'unspecified'}${c.secure ? ',secure' : ''}${c.httpOnly ? ',httpOnly' : ''}${c.session ? ',session' : ''}]`);
    navLog('cookies', rel.join(' '));
  } catch (e) { navLog('cookies-error', e.message); }
}

// ---------- layout ----------
function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  const s = store.load();
  const sw = s.sidebarVisible ? s.sidebarWidth : 0;
  sideView.setBounds({ x: 0, y: 0, width: sw, height });
  sideView.setVisible(s.sidebarVisible);
  const avail = Math.max(0, width - sw);
  // SkyLeap layout scales the game to the view width — allow pinning it (centered) so it stays sane.
  const want = s.skyleap && s.skyleap.enabled && s.skyleap.width > 0 ? Math.min(s.skyleap.width, avail) : avail;
  gameView.setBounds({ x: sw + Math.floor((avail - want) / 2), y: 0, width: want, height });
}

function sendSide(channel, payload) {
  if (sideView && !sideView.webContents.isDestroyed()) sideView.webContents.send(channel, payload);
}

function navigate(hash) {
  if (!gameView) return;
  showWindow();
  const url = hash && hash.startsWith('http') ? hash : GAME_URL + (hash || '');
  const cur = gameView.webContents.getURL();
  if (cur.startsWith(GAME_URL) && hash && hash.startsWith('#')) {
    // In-app hash navigation keeps the game's SPA state.
    gameView.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
  } else {
    gameView.webContents.loadURL(url);
  }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- window ----------
function createWindow() {
  const icon = ensureIcon();
  win = new BaseWindow({
    width: 1400, height: 900, minWidth: 700, minHeight: 500,
    title: 'Granblue Fantasy', icon, backgroundColor: '#0b0d12', show: false
  });
  win.setMenuBarVisibility(false);

  sideView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.contentView.addChildView(sideView);
  createGameView();

  if (process.env.GBF_DEBUG_SHOT) {
    sideView.webContents.on('console-message', (_e, level, msg, line, src) =>
      fs.appendFileSync(path.join(process.env.GBF_DEBUG_SHOT, 'console.txt'), `[${level}] ${msg} (${src}:${line})\n`));
  }
  sideView.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Mouse 4/5 on the main window: back / reload in the game view (guide: "Key/Mouse Bindings").
  win.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') { gameView.webContents.navigationHistory.canGoBack() && gameView.webContents.navigationHistory.goBack(); e.preventDefault(); }
    if (cmd === 'browser-forward') { gameView.webContents.reload(); e.preventDefault(); }
  });

  win.on('resize', layout);
  win.on('ready-to-show', () => { layout(); win.show(); });
  setTimeout(() => { layout(); win.show(); }, 800); // BaseWindow doesn't emit ready-to-show; belt and braces.

  win.on('close', (e) => {
    if (!quitting && store.load().closeToTray) { e.preventDefault(); win.hide(); }
  });
}

// Builds (or rebuilds) the game view against the ACTIVE account's session partition.
function createGameView() {
  const partition = activePartition();
  setupGameSession(session.fromPartition(partition));
  gameView = new WebContentsView({
    // nodeIntegrationInSubFrames only makes the preload run in iframes too (Mobage frames); node stays off.
    // backgroundThrottling:false keeps game timers/XHR at full rate while hidden in the tray.
    webPreferences: { contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, partition, preload: path.join(__dirname, 'game-preload.js'), backgroundThrottling: false }
  });
  win.contentView.addChildView(gameView);
  win.contentView.addChildView(sideView); // re-append: keeps the sidebar on top of the new view

  gameView.webContents.setUserAgent(gameUA());
  // Login flows (Mobage → Yahoo/Google/Twitter/Apple/DMM…) open popups and bounce through many hosts.
  // Keep every popup inside the app, in the same cookie jar, so the session lands in the game view.
  const popupOpts = { width: 560, height: 760, autoHideMenuBar: true, webPreferences: { partition, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, preload: path.join(__dirname, 'game-preload.js'), backgroundThrottling: false } };
  gameView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/(www\.)?(wiki\.)?gbf\.wiki|granblue\.team|twitter\.com\/intent|x\.com\/intent/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: popupOpts };
  });
  gameView.webContents.on('did-create-window', (child) => {
    child.webContents.setUserAgent(CHROME_UA);
    child.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: popupOpts }));
    child.webContents.on('did-create-window', (gc) => gc.webContents.setUserAgent(CHROME_UA));
    child.webContents.on('did-navigate', (_e, url) => navLog('popup', url));
    child.webContents.on('did-redirect-navigation', (_e, url) => navLog('popup-redirect', url));
    // Last-resort fallback: if the game is STILL parked on #authentication long after the login
    // popup closed, reload once. Must be generous — the game exchanges the Mobage token with its
    // own server right after the popup closes, and reloading during that kills the login.
    child.on('closed', () => {
      const alive = () => gameView && !gameView.webContents.isDestroyed();
      if (!alive()) return;
      navLog('popup-closed', gameView.webContents.getURL());
      setTimeout(() => {
        if (!alive()) return; // app may have quit / account switched during the grace period
        const u = gameView.webContents.getURL();
        if (/#authentication/.test(u)) { navLog('still-on-auth → reload', u); gameView.webContents.loadURL(GAME_URL); }
      }, 15000);
    });
  });
  gameView.webContents.on('did-navigate', (_e, url) => navLog('game', url));
  gameView.webContents.on('did-navigate-in-page', (_e, url, isMain) => { navLog('game-hash', url); if (isMain) logMobageCookies(); });
  gameView.webContents.on('did-redirect-navigation', (_e, url, _http, isMain) => navLog(isMain ? 'game-redirect' : 'frame-redirect', url));
  gameView.webContents.on('did-frame-navigate', (_e, url, _code, _status, isMain) => { if (!isMain) navLog('frame', url); });
  gameView.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 || /gbfwrap|mobage|oauth|session|token|login|logout|jssdk|fedcm|postMessage/i.test(msg)) navLog(`console${level}`, msg);
  });
  // Persist cookies promptly (a hard kill before Chromium's periodic flush would lose the login).
  const flush = () => session.fromPartition(partition).cookies.flushStore().catch(() => {});
  gameView.webContents.on('did-navigate', flush);
  gameView.webContents.on('did-finish-load', flush);
  gameView.webContents.on('did-navigate-in-page', (_e, url) => sendSide('game-url', url));
  gameView.webContents.on('did-navigate', (_e, url) => sendSide('game-url', url));
  gameView.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'F5' || (ctrl && input.key.toLowerCase() === 'r')) { gameView.webContents.reload(); e.preventDefault(); }
    if (input.key === 'F9' && !input.isAutoRepeat) { rec.active ? stopRecording() : startRecording(); e.preventDefault(); }
    if (ctrl && input.key.toLowerCase() === 'b') { toggleSidebar(); e.preventDefault(); }
    if (ctrl && (input.key === '=' || input.key === '+')) { zoom(+0.5); e.preventDefault(); }
    if (ctrl && input.key === '-') { zoom(-0.5); e.preventDefault(); }
    if (ctrl && input.key === '0') { gameView.webContents.setZoomLevel(0); e.preventDefault(); }
  });

  gameContentsIds.add(gameView.webContents.id);
  gameView.webContents.loadURL(GAME_URL);
}

// Per-session network setup — must run once for every account partition we touch.
const preparedSessions = new Set();
function setupGameSession(ses) {
  if (preparedSessions.has(ses)) return;
  preparedSessions.add(ses);
  ses.setUserAgent(CHROME_UA);
  installCookieUnpartitioner(ses);
  installTrackerBlocker(ses);
  installAutoRefresh(ses);
  applyProxy(ses);
}

function switchAccount(id) {
  const s = store.load();
  if (!s.accounts.some(a => a.id === id) || id === s.activeAccountId) return;
  store.save({ activeAccountId: id });
  const old = gameView;
  gameContentsIds.delete(old.webContents.id);
  win.contentView.removeChildView(old);
  old.webContents.close();
  createGameView();
  layout();
  navLog('account', 'switched to ' + id + ' (' + activePartition() + ')');
  sendSide('settings-changed');
}

function zoom(delta) {
  const z = gameView.webContents.getZoomLevel() + delta;
  gameView.webContents.setZoomLevel(Math.max(-3, Math.min(5, z)));
}

async function clearSession() {
  const ses = session.fromPartition(activePartition());
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.cookies.flushStore().catch(() => {});
  gameView.webContents.loadURL(GAME_URL);
}

function toggleSidebar() {
  const s = store.load();
  store.save({ sidebarVisible: !s.sidebarVisible });
  layout();
}

// ---------- tray ----------
function createTray() {
  tray = new Tray(ensureIcon().resize({ width: 16, height: 16 }));
  tray.setToolTip('Granblue Fantasy');
  const rebuild = () => {
    const s = store.load();
    const pending = s.dailies.filter(d => !d.done);
    const mins = Math.round(msUntilReset() / 60000);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Granblue Fantasy', click: showWindow },
      { type: 'separator' },
      { label: `Reset in ${Math.floor(mins / 60)}h ${mins % 60}m`, enabled: false },
      { label: pending.length ? `${pending.length} dailies left` : 'All dailies done ✓', enabled: false },
      ...pending.slice(0, 6).map(d => ({ label: `   → ${d.label}`, click: () => navigate(d.hash) })),
      { type: 'separator' },
      { label: 'New game window', click: openGameWindow },
      rec.active
        ? { label: rec.stopping ? 'Saving recording…' : '■ Stop recording', enabled: !rec.stopping, click: stopRecording }
        : { label: '● Start recording (F9)', click: startRecording },
      { label: 'Auto-refresh on attack', type: 'checkbox', checked: !!(s.autoRefresh && s.autoRefresh.attack), click: (m) => { store.save({ autoRefresh: { ...store.load().autoRefresh, attack: m.checked } }); sendSide('settings-changed'); } },
      { label: 'Close to tray', type: 'checkbox', checked: s.closeToTray, click: (m) => store.save({ closeToTray: m.checked }) },
      { label: 'Launch at login', type: 'checkbox', checked: s.launchAtLogin, click: (m) => { store.save({ launchAtLogin: m.checked }); app.setLoginItemSettings({ openAtLogin: m.checked }); } },
      { label: 'Log out (clear game cookies)', click: clearSession },
      { type: 'separator' },
      trayUpdateItem(),
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
  };
  rebuild();
  tray.on('click', showWindow);
  setInterval(rebuild, 60 * 1000);
  ipcMain.on('tray:rebuild', rebuild);
}

// ---------- ipc ----------
function wireIpc() {
  ipcMain.handle('settings:get', () => store.load());
  ipcMain.handle('settings:set', (_e, partial) => { const s = store.save(partial); layout(); ipcMain.emit('tray:rebuild'); return s; });
  ipcMain.handle('dailies:toggle', (_e, id) => {
    const s = store.load();
    const dailies = s.dailies.map(d => d.id === id ? { ...d, done: !d.done } : d);
    store.save({ dailies }); ipcMain.emit('tray:rebuild'); return dailies;
  });
  ipcMain.handle('dailies:set', (_e, dailies) => { store.save({ dailies }); ipcMain.emit('tray:rebuild'); return dailies; });
  ipcMain.handle('reset:ms', () => msUntilReset());
  ipcMain.handle('nav:go', (_e, hash) => navigate(hash));
  ipcMain.handle('nav:currentUrl', () => (gameView ? gameView.webContents.getURL() : ''));
  ipcMain.handle('nav:reload', () => gameView.webContents.reload());
  ipcMain.handle('nav:back', () => gameView.webContents.navigationHistory.canGoBack() && gameView.webContents.navigationHistory.goBack());
  ipcMain.handle('nav:zoom', (_e, d) => d === 0 ? gameView.webContents.setZoomLevel(0) : zoom(d));
  ipcMain.handle('app:toggleSidebar', toggleSidebar);
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:openCurrentExternal', () => shell.openExternal(gameView.webContents.getURL()));
  ipcMain.handle('session:clear', clearSession);
  ipcMain.handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:newGameWindow', () => { openGameWindow(); });
  ipcMain.handle('app:tileWindows', () => { tileGameWindows(); });
  // Recorder: chunks are only accepted from our hidden recorder window.
  const fromRecorder = (e) => rec.win && !rec.win.isDestroyed() && e.sender === rec.win.webContents;
  ipcMain.on('rec:chunk', (e, u8) => {
    if (!fromRecorder(e) || !rec.out) return;
    const buf = Buffer.from(u8);
    rec.out.write(buf); rec.bytes += buf.length;
  });
  ipcMain.on('rec:stopped', (e) => { if (fromRecorder(e)) finalizeRecording('stopped'); });
  ipcMain.on('rec:error', (e, msg) => { if (fromRecorder(e)) { navLog('rec-error', msg); stopRecording(); } });
  ipcMain.handle('rec:toggle', () => (rec.active ? stopRecording() : startRecording()));
  ipcMain.handle('rec:state', () => recState());
  ipcMain.handle('rec:openFolder', () => { const d = recordingsDir(); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
  ipcMain.handle('accounts:switch', (_e, id) => { switchAccount(id | 0); return store.load(); });
  ipcMain.handle('accounts:add', (_e, name) => {
    const s = store.load();
    const id = Math.max(...s.accounts.map(a => a.id)) + 1;
    store.save({ accounts: [...s.accounts, { id, name: (name || '').trim() || `Account ${id}` }] });
    return store.load();
  });
  ipcMain.handle('accounts:rename', (_e, id, name) => {
    const s = store.load();
    store.save({ accounts: s.accounts.map(a => a.id === id ? { ...a, name: (name || '').trim() || a.name } : a) });
    return store.load();
  });
  ipcMain.handle('accounts:remove', async (_e, id) => {
    const s = store.load();
    if (id === s.activeAccountId || s.accounts.length <= 1) return { error: 'Cannot remove the active or last account' };
    // Wipe the removed account's cookie jar so its login doesn't linger on disk.
    try { await session.fromPartition(partitionFor(id)).clearStorageData(); } catch {}
    store.save({ accounts: s.accounts.filter(a => a.id !== id) });
    return store.load();
  });
  ipcMain.handle('mudfish:status', async () => {
    const port = (store.load().mudfish || {}).port || 8282;
    const exe = mudfishExe();
    return { installed: !!exe, running: await mudfishRunning(port), port };
  });
  ipcMain.handle('mudfish:launch', () => {
    const exe = mudfishExe();
    if (!exe) return { ok: false, message: 'Mudfish not found' };
    shell.openPath(exe); // via the OS so its UAC/driver elevation works normally
    navLog('mudfish', 'launch requested');
    // Poll the console port; open our console window the moment it's up (max 90s).
    const port = (store.load().mudfish || {}).port || 8282;
    let waited = 0;
    const iv = setInterval(async () => {
      waited += 3000;
      if (await mudfishRunning(port)) { clearInterval(iv); openMudfishWindow(port); sendSide('mudfish-up'); }
      else if (waited >= 90000) clearInterval(iv);
    }, 3000);
    return { ok: true };
  });
  ipcMain.handle('mudfish:saveCreds', (_e, user, pass) => {
    const { safeStorage } = require('electron');
    const m = store.load().mudfish || {};
    if (!user && !pass) { store.save({ mudfish: { ...m, user: '', passEnc: '' } }); return { ok: true, cleared: true }; }
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: 'OS encryption unavailable' };
    store.save({ mudfish: { ...m, user, passEnc: safeStorage.encryptString(pass).toString('base64') } });
    return { ok: true };
  });
  ipcMain.handle('mudfish:open', () => {
    openMudfishWindow((store.load().mudfish || {}).port || 8282);
  });
  ipcMain.handle('mudfish:setPort', (_e, port) => {
    store.save({ mudfish: { ...store.load().mudfish, port: Math.max(1, Math.min(65535, port | 0)) || 8282 } });
    return store.load();
  });
  ipcMain.handle('proxy:apply', async (_e, proxy) => {
    store.save({ proxy: { ...store.load().proxy, ...proxy } });
    for (const ses of preparedSessions) await applyProxy(ses);
    return store.load();
  });
  ipcMain.handle('skyleap:apply', (_e, skyleap) => {
    store.save({ skyleap: { ...store.load().skyleap, ...skyleap } });
    gameView.webContents.setUserAgent(gameUA());
    layout();
    gameView.webContents.reload();
    navLog('skyleap', `enabled=${store.load().skyleap.enabled} width=${store.load().skyleap.width}`);
    return store.load();
  });
  ipcMain.on('gbf:diag', (_e, kind, text) => navLog('diag-' + kind, text));

  // ---- party import (assisted + UI-level auto-equip) ----
  ipcMain.handle('party:deck', () => {
    const m = /#party\/(?:index|list_\w+|top|list|job)\/(?:pc\/)?(\d+)/.exec(gameView.webContents.getURL());
    return m ? m[1] : null;
  });
  ipcMain.handle('party:slots', (_e, team, deck) => party.slots(team, deck));
  ipcMain.handle('party:autoEquip', async (_e, slot) => {
    if (!store.load().autoEquipAccepted) return { ok: false, message: 'auto-equip not enabled' };
    showWindow();
    navLog('auto-equip', `${slot.kind} ${slot.label} ${slot.id}`);
    try {
      const r = await gameView.webContents.executeJavaScript(party.autoEquipScript(slot), true);
      navLog('auto-equip-result', JSON.stringify(r));
      return r;
    } catch (e) {
      navLog('auto-equip-error', e.message);
      return { ok: false, message: e.message.replace(/^Error invoking remote method[^:]*: /, '') };
    }
  });
  ipcMain.handle('teams:fetch', (_e, input) => teams.fetchParty(input));
  ipcMain.handle('teams:explore', (_e, params) => teams.explore(params));
  ipcMain.handle('teams:save', (_e, team) => {
    const s = store.load();
    const savedTeams = [team, ...s.savedTeams.filter(t => t.shortcode !== team.shortcode)];
    store.save({ savedTeams }); return savedTeams;
  });
  ipcMain.handle('teams:remove', (_e, code) => {
    const savedTeams = store.load().savedTeams.filter(t => t.shortcode !== code);
    store.save({ savedTeams }); return savedTeams;
  });
}

// ---------- lifecycle ----------
app.on('second-instance', showWindow);
app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('before-quit', (e) => {
  quitting = true;
  // Never cut a recording off mid-file: finalize first, then quit (finalizeRecording re-calls quit).
  if (rec.active) { e.preventDefault(); rec.quitAfter = true; stopRecording(); }
});

// Mobage stores its login in CHIPS *partitioned* cookies (CSID_P etc.). Those are scoped to the
// top-level site, so a session created in the login popup (top-level = mobage.jp) is invisible to
// Mobage's iframes inside the game (top-level = granbluefantasy.jp) → the SDK's silent re-check gets
// `login_required` and the game logs out. Chrome bridges this with FedCM; we can't, so make Mobage's
// cookies unpartitioned by dropping the `Partitioned` attribute before Chromium stores them.
function installCookieUnpartitioner(ses) {
  const urls = ['https://*.mobage.jp/*', 'https://*.mbga.jp/*', 'https://*.dena.com/*'];
  if (process.env.GBF_DEBUG_SHOT) urls.push('https://httpbin.org/*');
  // Login safeguard: the Mobage flow is validated against desktop Chrome — pin that UA on auth hosts
  // at the header layer, so SkyLeap mode (mobile UA on the game view) can't disturb it.
  ses.webRequest.onBeforeSendHeaders({ urls }, (details, cb) => {
    const h = details.requestHeaders || {};
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'user-agent') h[k] = CHROME_UA;
    if (process.env.GBF_DEBUG_SHOT) navLog('ua-pin', details.url.split('?')[0] + ' → ' + (h['User-Agent'] || h['user-agent'] || '?').slice(0, 40));
    cb({ requestHeaders: h });
  });
  ses.webRequest.onHeadersReceived({ urls }, (details, cb) => {
    const h = details.responseHeaders || {};
    let changed = false;
    for (const key of Object.keys(h)) {
      if (key.toLowerCase() !== 'set-cookie') continue;
      h[key] = h[key].map(v => {
        const nv = v.replace(/;\s*partitioned\s*(?=;|$)/ig, '');
        if (nv !== v) changed = true;
        return nv;
      });
    }
    cb(changed ? { responseHeaders: h } : {});
  });
}

// Ad/analytics beacons the game fires (and waits on) around raid start — blocking them speeds up
// joins (gbf.wiki guide: "Use an Ad Blocker"). Conservative list: nothing functional, no gree/mobage.
const TRACKER_URLS = [
  '*://*.microad.jp/*', '*://*.datadoghq-browser-agent.com/*', '*://browser-intake-datadoghq.com/*',
  '*://*.google-analytics.com/*', '*://*.googletagmanager.com/*', '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*', '*://static.ads-twitter.com/*', '*://analytics.twitter.com/*',
  '*://connect.facebook.net/*', '*://*.repro.io/*', '*://*.karte.io/*'
];
function installTrackerBlocker(ses) {
  ses.webRequest.onBeforeRequest({ urls: TRACKER_URLS }, (details, cb) =>
    cb({ cancel: !!store.load().blockTrackers }));
}

// Per-app proxy for the game session only (e.g. Mudfish's SOCKS5 interface). Mudfish's default
// TUN mode needs none of this — it captures our traffic by destination automatically.
async function applyProxy(ses) {
  const p = store.load().proxy || {};
  if (p.enabled && p.rules) await ses.setProxy({ proxyRules: p.rules, proxyBypassRules: '<local>' });
  else await ses.setProxy({});
  navLog('proxy', p.enabled && p.rules ? p.rules : 'direct');
}

// Latency meter: tiny request to the game host through the game session's network stack
// (so a configured proxy is included in the number). Reported to the sidebar every 10s.
function startPingLoop() {
  const { net } = require('electron');
  const ping = () => {
    const t0 = Date.now();
    try {
      const req = net.request({ url: GAME_URL + 'favicon.ico?ping=' + t0, partition: activePartition(), cache: 'no-store' });
      const timer = setTimeout(() => { try { req.abort(); } catch {} sendSide('ping', null); }, 8000);
      req.on('response', (res) => { clearTimeout(timer); sendSide('ping', Date.now() - t0); res.on('data', () => {}); res.on('error', () => {}); });
      req.on('error', () => { clearTimeout(timer); sendSide('ping', null); });
      req.end();
    } catch { sendSide('ping', null); }
  };
  setInterval(ping, 10000);
  setTimeout(ping, 3000);
}

// ---- built-in recorder: tab-captures the GAME VIEW (video + its own audio) from a hidden window. ----
const rec = { win: null, ready: null, active: false, stopping: false, out: null, file: '', bytes: 0, startedAt: 0, mime: '', quitAfter: false, watchdog: null };

function recordingsDir() {
  const f = (store.load().recording || {}).folder;
  return f || path.join(app.getPath('videos'), 'GBF Desktop');
}

function recState() {
  return { active: rec.active, stopping: rec.stopping, startedAt: rec.startedAt, bytes: rec.bytes, file: rec.file ? path.basename(rec.file) : '' };
}
function broadcastRec() { sendSide('rec-state', recState()); ipcMain.emit('tray:rebuild'); }

function ensureRecorder() {
  if (rec.win && !rec.win.isDestroyed()) return rec.ready;
  rec.win = new BrowserWindow({
    show: false, width: 320, height: 240, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'recorder-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'gbf-recorder' }
  });
  // Answer the recorder's getDisplayMedia() with the game view itself: tab capture of its frame,
  // audio from that frame only, and local echo so you keep hearing the game while recording.
  rec.win.webContents.session.setDisplayMediaRequestHandler((_req, callback) => {
    if (!gameView || gameView.webContents.isDestroyed()) return callback({});
    const frame = gameView.webContents.mainFrame;
    const withAudio = (store.load().recording || {}).audio !== false;
    callback(withAudio ? { video: frame, audio: frame, enableLocalEcho: true } : { video: frame });
  });
  rec.win.on('closed', () => { rec.win = null; rec.ready = null; if (rec.active) finalizeRecording('recorder window closed'); });
  rec.ready = rec.win.loadFile(path.join(__dirname, 'recorder.html')).then(() => rec.win);
  return rec.ready;
}

async function startRecording() {
  if (rec.active || rec.stopping) return recState();
  const s = store.load().recording || {};
  try {
    const w = await ensureRecorder();
    const mime = await w.webContents.executeJavaScript('pickMime()');
    const ext = /mp4/.test(mime) ? 'mp4' : 'webm';
    const dir = recordingsDir();
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    rec.file = path.join(dir, `GBF ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`);
    rec.out = fs.createWriteStream(rec.file);
    rec.bytes = 0;
    const vbps = s.quality === 'standard' ? 6e6 : 12e6;
    // userGesture=true: getDisplayMedia requires transient activation.
    const info = await w.webContents.executeJavaScript(`startRecording(${JSON.stringify({ fps: s.fps === 60 ? 60 : 30, audio: s.audio !== false, mime, vbps })})`, true);
    rec.mime = info.mime; rec.active = true; rec.startedAt = Date.now();
    navLog('rec', `start ${path.basename(rec.file)} ${info.mime} ${info.width}x${info.height}@${info.fps} audio=${info.audioTracks}`);
    broadcastRec();
  } catch (e) {
    navLog('rec-error', 'start: ' + e.message);
    if (rec.out) { rec.out.destroy(); try { fs.unlinkSync(rec.file); } catch {} }
    rec.out = null; rec.file = '';
    notify('Recording failed to start', String(e.message).replace(/^Error invoking remote method[^:]*: /, '').slice(0, 140));
    broadcastRec();
  }
  return recState();
}

function stopRecording() {
  if (!rec.active || rec.stopping) return recState();
  rec.stopping = true;
  broadcastRec();
  // Normal path: page stops MediaRecorder → flushes last chunk → 'rec:stopped' → finalize.
  // Watchdog covers a wedged recorder so the file still gets closed.
  rec.watchdog = setTimeout(() => finalizeRecording('watchdog'), 6000);
  if (rec.win && !rec.win.isDestroyed()) rec.win.webContents.executeJavaScript('stopRecording()').catch(() => finalizeRecording('stop failed'));
  else finalizeRecording('no recorder');
  return recState();
}

function finalizeRecording(reason) {
  if (!rec.active && !rec.stopping) return;
  clearTimeout(rec.watchdog);
  const file = rec.file, bytes = rec.bytes, secs = Math.round((Date.now() - rec.startedAt) / 1000);
  const out = rec.out;
  rec.active = false; rec.stopping = false; rec.out = null;
  const done = () => {
    navLog('rec', `saved ${path.basename(file)} ${(bytes / 1048576).toFixed(1)}MB ${secs}s (${reason})`);
    if (bytes > 0) notify('Recording saved', `${path.basename(file)} — ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}, ${(bytes / 1048576).toFixed(0)} MB. Click to show.`, () => shell.showItemInFolder(file));
    else { try { fs.unlinkSync(file); } catch {} notify('Recording was empty', 'Nothing was captured — see nav.log.'); }
    broadcastRec();
    if (rec.quitAfter) app.quit();
  };
  if (out) out.end(done); else done();
}

// ---- auto-update: checks the GitHub Releases feed (latest.yml) that CI publishes on tags. ----
const updateState = { checking: false, available: null, downloaded: null, manual: false };
let autoUpdater = null;
function setupAutoUpdate() {
  if (!app.isPackaged) return; // dev runs have no app-update.yml; tray shows a disabled entry
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { navLog('update-error', 'updater missing: ' + e.message); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // even without the tray click, next quit applies it
  autoUpdater.on('checking-for-update', () => { updateState.checking = true; ipcMain.emit('tray:rebuild'); });
  autoUpdater.on('update-available', (info) => { updateState.available = info.version; navLog('update', 'available ' + info.version); });
  autoUpdater.on('update-not-available', () => {
    updateState.checking = false; updateState.available = null;
    if (updateState.manual) { updateState.manual = false; notify('Granblue Fantasy Desktop', `Up to date (v${app.getVersion()}).`); }
    ipcMain.emit('tray:rebuild');
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState.checking = false; updateState.downloaded = info.version;
    navLog('update', 'downloaded ' + info.version);
    notify('Update ready', `v${info.version} downloaded — right-click the tray icon → “Restart & update”.`, () => autoUpdater.quitAndInstall());
    ipcMain.emit('tray:rebuild');
  });
  autoUpdater.on('error', (e) => {
    updateState.checking = false;
    navLog('update-error', e.message);
    if (updateState.manual) { updateState.manual = false; notify('Update check failed', e.message.slice(0, 120)); }
    ipcMain.emit('tray:rebuild');
  });
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 15000);           // once at launch
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 3600 * 1000); // then every 6h
}

function trayUpdateItem() {
  if (!app.isPackaged) return { label: `v${app.getVersion()} (dev — updates off)`, enabled: false };
  if (!autoUpdater) return { label: 'Updater unavailable', enabled: false };
  if (updateState.downloaded) return { label: `Restart & update to v${updateState.downloaded}`, click: () => autoUpdater.quitAndInstall() };
  if (updateState.checking) return { label: updateState.available ? `Downloading v${updateState.available}…` : 'Checking for updates…', enabled: false };
  return { label: `Check for updates (v${app.getVersion()})`, click: () => { updateState.manual = true; autoUpdater.checkForUpdates().catch(() => {}); } };
}

// ---- Mudfish integration: its desktop client is a local web dashboard; host it in-app. ----
const MUDFISH_DIRS = ['C:\\Program Files (x86)\\Mudfish Cloud VPN', 'C:\\Program Files\\Mudfish Cloud VPN'];
function mudfishExe() {
  for (const d of MUDFISH_DIRS) {
    const p = path.join(d, 'mudfish.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function mudfishRunning(port) {
  return new Promise((resolve) => {
    const s = require('net').connect({ host: '127.0.0.1', port, timeout: 1200 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}
function mudfishCreds() {
  const { safeStorage } = require('electron');
  const m = store.load().mudfish || {};
  if (!m.user || !m.passEnc || !safeStorage.isEncryptionAvailable()) return null;
  try { return { user: m.user, pass: safeStorage.decryptString(Buffer.from(m.passEnc, 'base64')) }; }
  catch { return null; }
}

let mudfishWin = null;
function openMudfishWindow(port) {
  if (mudfishWin && !mudfishWin.isDestroyed()) { mudfishWin.focus(); return; }
  mudfishWin = new BrowserWindow({
    width: 1080, height: 760, autoHideMenuBar: true, title: 'Mudfish console', icon: ensureIcon(), backgroundColor: '#101318',
    webPreferences: { partition: 'persist:mudfish', contextIsolation: true, nodeIntegration: false }
  });
  const url = `http://127.0.0.1:${port}/`;
  let tries = 0;
  const load = () => mudfishWin && !mudfishWin.isDestroyed() && mudfishWin.loadURL(url).catch(() => {});
  mudfishWin.webContents.on('did-fail-load', () => {
    // Console not up yet (Mudfish still starting) — retry a few times before giving up with a hint.
    if (++tries <= 10) setTimeout(load, 1500);
    else mudfishWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      `<body style="background:#101318;color:#dde;font-family:Segoe UI;padding:2em">
       <h3>Mudfish console not reachable at ${url}</h3>
       <p>Launch Mudfish first (Settings → Network → Launch Mudfish), or check the console port.
       Close this window and try again once Mudfish is running.</p></body>`));
  });
  // External links (mudfish.net docs/payment) go to the real browser.
  mudfishWin.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  // Saved-credentials autofill: when the local console shows its sign-in form, fill and submit once.
  // Generic DOM fill (any username+password inputs) so we don't depend on Mudfish's field names.
  let autofilled = false;
  mudfishWin.webContents.on('did-finish-load', async () => {
    if (autofilled || !mudfishWin || mudfishWin.isDestroyed()) return;
    if (!mudfishWin.webContents.getURL().startsWith(`http://127.0.0.1:${port}`)) return;
    const creds = mudfishCreds();
    if (!creds) return;
    try {
      const r = await mudfishWin.webContents.executeJavaScript(
        `document.querySelector('input[type=password]') ? 'form-found' : 'no-signin-form'`);
      if (r === 'form-found') {
        autofilled = true;
        await mudfishWin.webContents.executeJavaScript(`(function (U, P) {
          const p = document.querySelector('input[type=password]');
          const u = document.querySelector('input[type=email], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[type=text]');
          const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
          if (u) set(u, U);
          set(p, P);
          const remember = document.querySelector('input[type=checkbox][name*="remember" i], input[type=checkbox][id*="remember" i]');
          if (remember && !remember.checked) remember.click();
          const btn = document.querySelector('button[type=submit], input[type=submit], button[name*="sign" i], button[id*="sign" i]');
          if (btn) btn.click(); else if (p.form) p.form.submit();
          return 'submitted';
        })(${JSON.stringify(creds.user)}, ${JSON.stringify(creds.pass)})`);
        navLog('mudfish', 'console autofill submitted');
      }
    } catch (e) { navLog('mudfish', 'autofill error ' + e.message); }
  });
  mudfishWin.on('closed', () => { mudfishWin = null; });
  load();
}

// Auto-refresh: when a battle action's result response lands, reload the game view (the classic
// "F5 after attack" trick — skips the animation; the result is already committed server-side).
const BATTLE_ENDPOINTS = {
  attack: /\/rest\/(raid|multiraid)\/normal_attack_result\.json/,
  summon: /\/rest\/(raid|multiraid)\/summon_result\.json/,
  skill:  /\/rest\/(raid|multiraid)\/ability_result\.json/
};
let lastAutoRefresh = 0;
const gameContentsIds = new Set(); // main game view + any extra game windows

// Read the game's own auto-attack state (Full Auto or normal-auto). Multiple defensive signals
// because the battle engine is minified: stage.gGameStatus.auto_attack is the live flag, and
// window.auto_flag is the legacy global some builds set. Returns false safely outside a battle.
const FA_DETECT_JS = `(function () {
  try {
    var s = window.stage, gs = s && s.gGameStatus;
    return { autoAttack: !!(gs && gs.auto_attack), autoFlag: !!window.auto_flag };
  } catch (e) { return { autoAttack: false, autoFlag: false }; }
})()`;

// Delay before an auto-refresh fires: a fixed floor plus a random, human-shaped spread.
// Human reaction times cluster rather than spread flat, so we approximate a skewed/bell shape by
// averaging three uniforms (central-limit → roughly Gaussian) instead of a single flat random.
function refreshDelay(ar) {
  const base = Math.max(0, Math.min(3000, ar.delayMs | 0));
  const spread = Math.max(0, Math.min(3000, ar.jitterMs | 0));
  if (!spread) return base;
  const r = (Math.random() + Math.random() + Math.random()) / 3; // 0..1, peaked at 0.5
  return Math.min(5000, base + Math.round(r * spread));
}
function installAutoRefresh(ses) {
  const { webContents } = require('electron');
  ses.webRequest.onCompleted({ urls: ['https://game.granbluefantasy.jp/rest/*'] }, (details) => {
    if (!gameContentsIds.has(details.webContentsId)) return;
    if (details.statusCode !== 200 || details.method !== 'POST') return;
    const ar = store.load().autoRefresh || {};
    const kind = Object.keys(BATTLE_ENDPOINTS).find(k => BATTLE_ENDPOINTS[k].test(details.url));
    if (!kind || !ar[kind]) return;
    const now = Date.now();
    if (now - lastAutoRefresh < 1500) return; // one reload per action
    lastAutoRefresh = now;
    const delay = refreshDelay(ar);
    navLog('auto-refresh', `${kind} +${delay}ms`);
    setTimeout(async () => {
      const wc = webContents.fromId(details.webContentsId);
      if (!wc || wc.isDestroyed() || !/#raid/.test(wc.getURL())) return;
      // Reloading during Full Auto stops the FA loop. When pauseDuringFA is on, check the game's
      // own auto-attack state and skip the reload while FA (or normal-auto) is running.
      if (ar.pauseDuringFA !== false) {
        try {
          const fa = await wc.executeJavaScript(FA_DETECT_JS, true);
          if (fa && (fa.autoAttack || fa.autoFlag)) { navLog('auto-refresh', 'skipped — auto running'); return; }
        } catch {}
      }
      wc.reload();
    }, delay);
  });
}

// Extra game window sharing the same session — enables the guide's multiwindow techniques
// (second-window menuing, guarding, preloading, weaving). Same login, same cookies.
function openGameWindow() {
  const partition = activePartition();
  setupGameSession(session.fromPartition(partition));
  const w = new BrowserWindow({
    width: 700, height: 900, autoHideMenuBar: true, backgroundColor: '#0b0d12', icon: ensureIcon(),
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, preload: path.join(__dirname, 'game-preload.js'), backgroundThrottling: false }
  });
  w.webContents.setUserAgent(gameUA());
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/granbluefantasy\.jp|mobage\.jp|mbga\.jp|gree\.net|dena\.com/.test(url)) return { action: 'allow' };
    shell.openExternal(url); return { action: 'deny' };
  });
  w.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') { w.webContents.navigationHistory.canGoBack() && w.webContents.navigationHistory.goBack(); e.preventDefault(); }
    if (cmd === 'browser-forward') { w.webContents.reload(); e.preventDefault(); }
  });
  const wcId = w.webContents.id; // capture now — webContents is already destroyed inside 'closed'
  gameContentsIds.add(wcId);
  gameWindows.push(w);
  w.on('closed', () => {
    gameContentsIds.delete(wcId);
    const i = gameWindows.indexOf(w); if (i >= 0) gameWindows.splice(i, 1);
    if (store.load().multiwindow.autoTile) tileGameWindows();
  });
  w.loadURL(GAME_URL + '#mypage');
  if (store.load().multiwindow.autoTile) tileGameWindows();
  return w;
}

// ---- multiwindow auto-layout: tile main + extra game windows into equal columns (grid past 4),
// on the display the main window lives on; restore the main window when the last extra closes. ----
const gameWindows = [];
let preTileBounds = null;
function tileGameWindows() {
  const { screen } = require('electron');
  const extras = gameWindows.filter(w => !w.isDestroyed());
  if (!win || win.isDestroyed()) return;
  if (!extras.length) {
    if (preTileBounds) { win.setBounds(preTileBounds); preTileBounds = null; }
    return;
  }
  if (!preTileBounds) preTileBounds = win.getBounds();
  const wins = [win, ...extras];
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const n = wins.length;
  const cols = n <= 4 ? n : Math.ceil(n / 2);
  const rows = Math.ceil(n / cols);
  const cw = Math.floor(wa.width / cols), ch = Math.floor(wa.height / rows);
  wins.forEach((w, i) => {
    if (w.isMinimized && w.isMinimized()) w.restore();
    w.setBounds({ x: wa.x + (i % cols) * cw, y: wa.y + Math.floor(i / cols) * ch, width: cw, height: ch });
  });
  navLog('tile', `${n} windows → ${cols}x${rows} @ ${cw}x${ch}`);
}

async function purgePartitionedMobageCookies(ses) {
  // One-time migration: cookies stored before the unpartitioner existed are partitioned and useless.
  const s = store.load();
  if ((s.cookieSchema || 0) >= 2) return;
  try {
    await ses.clearStorageData({ storages: ['cookies'] });
    await ses.cookies.flushStore().catch(() => {});
    navLog('migration', 'cleared cookies (partitioned mobage session cannot be reused)');
  } catch (e) { navLog('migration-error', e.message); }
  store.save({ cookieSchema: 2 });
}

app.whenReady().then(async () => {
  const ses = session.fromPartition(activePartition());
  setupGameSession(ses);
  await purgePartitionedMobageCookies(ses);
  // Stop Windows from suspending/efficiency-throttling the process while it lives in the tray.
  // (Display is still allowed to sleep — this only blocks app suspension.)
  powerSaveBlocker.start('prevent-app-suspension');
  startPingLoop();
  setupAutoUpdate();
  wireIpc();
  createWindow();
  createTray();
  reminders = new Reminders({
    onNavigate: navigate,
    onDailiesReset: () => { sendSide('dailies-reset'); ipcMain.emit('tray:rebuild'); }
  });
  reminders.start();
  app.setLoginItemSettings({ openAtLogin: !!store.load().launchAtLogin });
  globalShortcut.register('CommandOrControl+Shift+G', showWindow);

  // Dev aid: GBF_DEBUG_SHOT=<dir> captures both views after 15s and exits.
  if (process.env.GBF_DEBUG_SHOT) {
    setTimeout(async () => {
      try {
        const dir = process.env.GBF_DEBUG_SHOT;
        fs.mkdirSync(dir, { recursive: true });
        const log = (m) => fs.appendFileSync(path.join(dir, 'log.txt'), `${new Date().toISOString()} ${m}\n`);
        log('start; game url=' + gameView.webContents.getURL());
        log('fedcm check: ' + JSON.stringify(await gameView.webContents.executeJavaScript(`({ identityCredential: 'IdentityCredential' in window, identityProvider: typeof IdentityProvider, credGet: typeof navigator.credentials?.get })`)));
        for (const f of gameView.webContents.mainFrame.framesInSubtree) {
          if (!/mobage\.jp/.test(f.url)) continue;
          try { log('frame ' + f.url.slice(0, 60) + ' → ' + JSON.stringify(await f.executeJavaScript(`({ identityCredential: 'IdentityCredential' in window, identityProvider: typeof IdentityProvider })`))); } catch (e) { log('frame err ' + e.message); }
        }
        // Poke the sidebar through the import flow so the shot shows a rendered team.
        await sideView.webContents.executeJavaScript(`document.querySelector('[data-tab=teams]').click(); document.querySelector('#team-input').value='c6WX3u'; document.querySelector('#team-import').click();`);
        log('import triggered');
        await new Promise(r => setTimeout(r, 4000));
        const dom = await sideView.webContents.executeJavaScript(`({
          timer: document.querySelector('#reset-timer').textContent,
          dailies: [...document.querySelectorAll('#dailies li label')].map(l => l.textContent),
          status: document.querySelector('#team-status').textContent,
          team: document.querySelector('#team-view .team h3')?.textContent,
          cells: [...document.querySelectorAll('#team-view .cell')].map(c => c.title),
          imgsLoaded: [...document.querySelectorAll('#team-view img')].filter(i => i.complete && i.naturalWidth > 0).length,
          imgsTotal: document.querySelectorAll('#team-view img').length
        })`);
        fs.writeFileSync(path.join(dir, 'dom.json'), JSON.stringify(dom, null, 2));
        log('dom dumped');
        // Import panel: pretend the game is on deck 93 and check the slot rows.
        await gameView.webContents.executeJavaScript(`location.hash = '#party/index/93/weapon/0'`);
        await new Promise(r => setTimeout(r, 1000));
        const slotsDom = await sideView.webContents.executeJavaScript(`({
          deck: document.querySelector('#deck-info').textContent,
          panelHidden: document.querySelector('#import-panel').classList.contains('hidden'),
          rows: [...document.querySelectorAll('#slot-list .slot')].map(r => r.querySelector('.sl').textContent + ' | ' + r.querySelector('.sn').textContent.trim() + ' | ' + r.querySelector('.open').title)
        })`);
        fs.writeFileSync(path.join(dir, 'slots.json'), JSON.stringify(slotsDom, null, 2));
        log('slots: ' + slotsDom.rows.length + ' rows, deck=' + slotsDom.deck);
        try {
          await gameView.webContents.executeJavaScript(`location.hash = '#authentication'`);
          await new Promise(r => setTimeout(r, 8000));
          const gdom = await gameView.webContents.executeJavaScript(`({
            url: location.href, title: document.title,
            iframes: [...document.querySelectorAll('iframe')].map(f => f.src),
            btns: [...document.querySelectorAll('[class*=btn], [class*=login], [class*=auth], a')].slice(0,60).map(a => ({tag:a.tagName, href:a.getAttribute('href'), dataHref:a.getAttribute('data-href'), cls:a.className, text:(a.textContent||'').trim().slice(0,40), attrs:[...a.attributes].map(x=>x.name+'='+x.value.slice(0,60)).join(' ')})),
            scripts: [...document.scripts].map(s => s.src).filter(Boolean).slice(0,30),
            bodySnippet: document.body.innerText.slice(0,600)
          })`);
          fs.writeFileSync(path.join(dir, 'game-dom.json'), JSON.stringify(gdom, null, 2));
        } catch (e) { log('game dom failed ' + e.message); }
        if (process.env.GBF_DEBUG_MF) {
          await sideView.webContents.executeJavaScript(`document.querySelector('[data-tab=settings]').click(); true`);
          await new Promise(r => setTimeout(r, 3000));
          log('MF: ' + await sideView.webContents.executeJavaScript(`document.querySelector('#mf-status').textContent + ' | port=' + document.querySelector('#mf-port').value + ' | open.disabled=' + document.querySelector('#mf-open').disabled + ' | launch.disabled=' + document.querySelector('#mf-launch').disabled`));
          await sideView.webContents.executeJavaScript(`document.querySelector('#mf-user').value='debug@example.com'; document.querySelector('#mf-pass').value='hunter2-debug'; document.querySelector('#mf-save').click(); true`);
          await new Promise(r => setTimeout(r, 1000));
          const mconf = store.load().mudfish;
          const creds = mudfishCreds();
          log('MF creds: hint=' + await sideView.webContents.executeJavaScript(`document.querySelector('#mf-creds-hint').textContent`) +
              ' | passEnc looks encrypted=' + (!!mconf.passEnc && !mconf.passEnc.includes('hunter2')) +
              ' | decrypt roundtrip=' + (creds && creds.pass === 'hunter2-debug') + ' | user=' + (creds && creds.user));
        }
        if (process.env.GBF_DEBUG_ACC) {
          await sideView.webContents.executeJavaScript(`document.querySelector('[data-tab=settings]').click(); document.querySelector('#acc-name').value='Alt'; document.querySelector('#acc-add').click(); true`);
          await new Promise(r => setTimeout(r, 800));
          await sideView.webContents.executeJavaScript(`(() => { const s=document.querySelector('#acc-select'); s.value='2'; s.dispatchEvent(new Event('change')); })(); true`);
          await new Promise(r => setTimeout(r, 5000));
          log('ACC: active=' + store.load().activeAccountId + ' partition-match=' + (gameView.webContents.session === session.fromPartition('persist:gbf-2')) + ' url=' + gameView.webContents.getURL().slice(0, 60) + ' accounts=' + JSON.stringify(store.load().accounts));
          await sideView.webContents.executeJavaScript(`(() => { const s=document.querySelector('#acc-select'); s.value='1'; s.dispatchEvent(new Event('change')); })(); true`);
          await new Promise(r => setTimeout(r, 4000));
          log('ACC back: active=' + store.load().activeAccountId + ' partition-match=' + (gameView.webContents.session === session.fromPartition('persist:gbf')));
        }
        if (process.env.GBF_DEBUG_NET) {
          await new Promise(r => setTimeout(r, 9000)); // let a ping cycle land
          const probes = await gameView.webContents.executeJavaScript(`performance.getEntriesByType('resource').filter(r => /microad|datadog|google-analytics/.test(r.name)).map(r => ({ n: r.name.replace(/^https?:\\/\\//,'').slice(0, 55), size: r.transferSize, dur: Math.round(r.duration) }))`);
          log('NET trackers: ' + JSON.stringify(probes));
          log('NET ping shown: ' + await sideView.webContents.executeJavaScript(`document.querySelector('#ping-ms').textContent`));
        }
        if (process.env.GBF_DEBUG_SL) {
          // Flip SkyLeap mode through the real UI path and verify UA + pinned layout after reload.
          await sideView.webContents.executeJavaScript(`document.querySelector('[data-tab=settings]').click(); const c = document.querySelector('#sl-enabled'); c.checked = true; c.dispatchEvent(new Event('change')); const w = document.querySelector('#sl-width'); w.value = 642; w.dispatchEvent(new Event('change')); true`);
          await new Promise(r => setTimeout(r, 6000));
          const ua = await gameView.webContents.executeJavaScript('navigator.userAgent');
          log('SL: ua=' + ua);
          log('SL: bounds=' + JSON.stringify(gameView.getBounds()) + ' win=' + JSON.stringify(win.getContentBounds()));
        }
        if (process.env.GBF_DEBUG_BG) {
          // Hide to tray, then measure setInterval + rAF rates in the hidden game page.
          win.hide();
          await new Promise(r => setTimeout(r, 1500));
          const bg = await gameView.webContents.executeJavaScript(`new Promise(res => {
            let ticks = 0, rafs = 0; const iv = setInterval(() => ticks++, 100);
            const raf = () => { rafs++; requestAnimationFrame(raf); }; requestAnimationFrame(raf);
            setTimeout(() => { clearInterval(iv); res({ ticks, rafs, hidden: document.hidden, visState: document.visibilityState }); }, 5000);
          })`);
          log('bg test (hidden 5s): ' + JSON.stringify(bg) + ' — expect ticks≈50 unthrottled, ≈5 throttled');
          win.show();
        }
        if (process.env.GBF_DEBUG_LAYOUT) {
          // Sidebar geometry: every topbar button must sit inside the sidebar; checklist checkboxes must be box-sized.
          await sideView.webContents.executeJavaScript(`document.querySelector('[data-tab=dailies]').click(); document.querySelector('#btn-rec').textContent = '● 12:34'; true`);
          for (const width of [340, 260]) {
            store.save({ sidebarWidth: width }); layout();
            await new Promise(r => setTimeout(r, 400));
            const g = await sideView.webContents.executeJavaScript(`(() => {
              const vw = document.documentElement.clientWidth;
              const btns = [...document.querySelectorAll('.topbar button')].map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), right: Math.round(r.right), top: Math.round(r.top), visible: r.right <= vw && r.width > 0 }; });
              const li = document.querySelector('#dailies li');
              const cb = li && li.querySelector('input[type=checkbox]'), lb = li && li.querySelector('label');
              return { vw, hidden: btns.filter(b => !b.visible).map(b => b.t), rows: [...new Set(btns.map(b => b.top))].length, topbarH: Math.round(document.querySelector('.topbar').getBoundingClientRect().height),
                       checkboxW: cb && Math.round(cb.getBoundingClientRect().width), labelX: lb && Math.round(lb.getBoundingClientRect().left), labelLines: lb && Math.round(lb.getBoundingClientRect().height / parseFloat(getComputedStyle(lb).lineHeight || 16)) };
            })()`);
            log(`LAYOUT @${width}px: ` + JSON.stringify(g));
          }
          store.save({ sidebarWidth: 340 }); layout();
        }
        if (process.env.GBF_DEBUG_REC) {
          store.save({ recording: { ...store.load().recording, folder: path.join(dir, 'rec') } }); // never the real Videos folder
          const w = await ensureRecorder();
          log('REC support: ' + JSON.stringify(await w.webContents.executeJavaScript(`({ pick: pickMime(), mp4: MediaRecorder.isTypeSupported('video/mp4'), vp9: MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') })`)));
          const check = (label) => {
            const f = rec.lastFile;
            if (!f || !fs.existsSync(f)) return log(`REC ${label}: NO FILE`);
            const b = fs.readFileSync(f);
            const head = b.subarray(0, 12);
            const kind = head.subarray(4, 8).toString('ascii') === 'ftyp' ? 'mp4(ftyp)' : (head.readUInt32BE(0) === 0x1A45DFA3 ? 'webm(EBML)' : 'UNKNOWN ' + head.toString('hex'));
            log(`REC ${label}: ${path.basename(f)} size=${b.length} container=${kind}`);
          };
          const runOnce = async (label, hide) => {
            if (hide) win.hide();
            const st = await startRecording();
            rec.lastFile = rec.file;
            log(`REC ${label} started: active=${st.active} file=${st.file}`);
            const samples = [];
            for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 2000)); samples.push(rec.bytes); }
            log(`REC ${label} bytes on disk every 2s: ${samples.join(' → ')}`);
            stopRecording();
            await new Promise(r => setTimeout(r, 3000));
            log(`REC ${label} after stop: active=${rec.active} stopping=${rec.stopping}`);
            check(label);
            if (hide) win.show();
          };
          await runOnce('visible', false);
          await runOnce('tray-hidden', true);
          // Decode check: play the last file back in a throwaway window (debug only).
          const pw = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } });
          await pw.loadURL('about:blank');
          const url = 'file:///' + rec.lastFile.replace(/\\/g, '/');
          const meta = await pw.webContents.executeJavaScript(`new Promise(res => {
            const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = ${JSON.stringify(url)};
            v.onerror = () => res({ error: v.error && v.error.message });
            v.onloadedmetadata = () => { v.currentTime = 1e6; };
            v.onseeked = () => res({ w: v.videoWidth, h: v.videoHeight, duration: +v.duration.toFixed(2) });
            setTimeout(() => res({ timeout: true, w: v.videoWidth, h: v.videoHeight }), 8000);
          })`);
          log('REC decode: ' + JSON.stringify(meta));
          pw.destroy();
        }
        if (process.env.GBF_DEBUG_TILE) {
          const bounds = () => JSON.stringify([win.getBounds(), ...gameWindows.filter(w => !w.isDestroyed()).map(w => w.getBounds())]);
          const before = win.getBounds();
          const w1 = openGameWindow(); const w2 = openGameWindow();
          await new Promise(r => setTimeout(r, 1200));
          log('TILE 3-up: ' + bounds());
          w2.close();
          await new Promise(r => setTimeout(r, 800));
          log('TILE 2-up: ' + bounds());
          w1.close();
          await new Promise(r => setTimeout(r, 800));
          const after = win.getBounds();
          log('TILE restore: before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after) + ' match=' + (JSON.stringify(before) === JSON.stringify(after)));
        }
        if (process.env.GBF_DEBUG_BM) {
          const rows = () => sideView.webContents.executeJavaScript(`[...document.querySelectorAll('#bookmarks li .bm-go')].map(g => g.textContent + ' → ' + g.parentElement.querySelector('.bm-hash').textContent)`);
          await sideView.webContents.executeJavaScript(`document.querySelector('[data-tab=bookmarks]').click(); true`);
          await new Promise(r => setTimeout(r, 400));
          log('BM default count (expect 0): ' + store.load().bookmarks.length);
          // Put the game on a GW-like page, then "+ current page".
          await gameView.webContents.executeJavaScript(`location.hash = '#quest/assist_entry_id/12345'`);
          await new Promise(r => setTimeout(r, 700));
          await sideView.webContents.executeJavaScript(`document.querySelector('#bm-current').click(); true`);
          await new Promise(r => setTimeout(r, 500));
          log('BM +current captured: ' + JSON.stringify(store.load().bookmarks) + ' | rows=' + JSON.stringify(await rows()));
        }
        if (process.env.GBF_DEBUG_AR) {
          store.save({ autoRefresh: { ...store.load().autoRefresh, attack: true, pauseDuringFA: true } });
          // FA detection expression must evaluate cleanly and report not-auto outside a battle.
          log('AR: FA detect (no battle) = ' + JSON.stringify(await gameView.webContents.executeJavaScript(FA_DETECT_JS, true)));

          const fireAttack = () => gameView.webContents.executeJavaScript(`location.hash = '#raid/TEST'; fetch('/rest/raid/normal_attack_result.json?_=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status).catch(e => 'ERR ' + e.message)`);

          // Case 1: not in FA → should reload.
          let reloaded = false;
          const onNav = (_e, url, inPlace, isMain) => { if (isMain && !inPlace) { reloaded = true; } };
          gameView.webContents.on('did-start-navigation', onNav);
          await fireAttack();
          await new Promise(r => setTimeout(r, 3000));
          log('AR case1 (FA off): reloaded=' + reloaded + ' (expect true)');

          // Case 2: simulate FA active via the same flag the detector reads → should skip.
          gameView.webContents.removeListener('did-start-navigation', onNav);
          await gameView.webContents.executeJavaScript(`window.auto_flag = true; true`);
          let reloaded2 = false;
          const onNav2 = (_e, url, inPlace, isMain) => { if (isMain && !inPlace) { reloaded2 = true; } };
          gameView.webContents.on('did-start-navigation', onNav2);
          await fireAttack();
          await new Promise(r => setTimeout(r, 3000));
          gameView.webContents.removeListener('did-start-navigation', onNav2);
          log('AR case2 (FA on): reloaded=' + reloaded2 + ' (expect false)');
        }
        if (process.env.GBF_DEBUG_OPENER) {
          // Does a popup opened by the game page keep window.opener?
          const res = await new Promise((resolve) => {
            gameView.webContents.once('did-create-window', (child, details) => {
              log('did-create-window ' + details.url);
              child.webContents.on('did-fail-load', (_e, code, desc) => log('child fail ' + code + ' ' + desc));
              child.webContents.once('dom-ready', async () => {
                log('child dom-ready ' + child.webContents.getURL());
                try {
                  const r = await child.webContents.executeJavaScript(`(() => { document.cookie = 'gbfwrap_test=1; SameSite=None; Secure; path=/'; document.cookie = 'gbfwrap_part=1; SameSite=None; Secure; Partitioned; path=/'; return { hasOpener: !!window.opener, popupCookieNames: document.cookie.split(';').map(s => s.trim().split('=')[0]).filter(Boolean).join(','), cookieSet: document.cookie.includes('gbfwrap_test=1'), partSet: document.cookie.includes('gbfwrap_part=1') }; })()`);
                  // Now read it back from the third-party mobage iframes embedded in the game page.
                  await gameView.webContents.executeJavaScript(`location.hash = '#authentication'`);
                  await new Promise(r2 => setTimeout(r2, 5000));
                  r.frames = [];
                  for (const f of gameView.webContents.mainFrame.framesInSubtree) {
                    if (!/mobage\.jp/.test(f.url)) continue;
                    try {
                      const c = await f.executeJavaScript(`({ names: document.cookie.split(';').map(s => s.trim().split('=')[0]).filter(Boolean).join(','), cookie: document.cookie.includes('gbfwrap_test=1'), partCookie: document.cookie.includes('gbfwrap_part=1'), canWrite: (function(){ document.cookie='gbfwrap_ifr=1; SameSite=None; Secure; path=/'; return document.cookie.includes('gbfwrap_ifr=1'); })(), ls: (function(){ try { localStorage.setItem('gbfwrap','1'); return localStorage.getItem('gbfwrap')==='1'; } catch(e){ return 'ERR '+e.message; } })() })`);
                      r.frames.push({ url: f.url.slice(0, 90), ...c });
                    } catch (e) { r.frames.push({ url: f.url.slice(0, 90), err: e.message }); }
                  }
                  resolve(r);
                } catch (e) { resolve({ err: e.message }); }
                child.close();
              });
            });
            gameView.webContents.executeJavaScript(`window.__p = window.open('https://connect.mobage.jp/', 'authorize_consent_window'); !!window.__p`).then(v => log('window.open returned ' + v));
            setTimeout(() => resolve({ timeout: true }), 30000);
          });
          log('opener test: ' + JSON.stringify(res));
          // CHIPS rewrite test: load a response with "Set-Cookie: ...; Partitioned" through the unpartitioner
          // in a top-level popup, then inspect partition keys via CDP.
          try {
            const w = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:gbf' } });
            await w.loadURL('https://httpbin.org/response-headers?Set-Cookie=' + encodeURIComponent('gbfwrap_srv=1; Path=/; SameSite=None; Secure; Partitioned'));
            await new Promise(r => setTimeout(r, 1500));
            const viaElectron = await session.fromPartition('persist:gbf').cookies.get({});
            log('electron cookies: ' + JSON.stringify(viaElectron.filter(c => /gbfwrap/.test(c.name)).map(c => ({ name: c.name, domain: c.domain, keys: Object.keys(c).join('|') }))));
            gameView.webContents.debugger.attach('1.3');
            const { cookies } = await gameView.webContents.debugger.sendCommand('Network.getAllCookies');
            gameView.webContents.debugger.detach();
            log('cdp cookies: ' + JSON.stringify(cookies.filter(c => /gbfwrap/.test(c.name)).map(c => ({ name: c.name, domain: c.domain, partitionKey: c.partitionKey || null }))));
            w.destroy();
          } catch (e) { log('chips test error ' + e.message); }
        }
        if (process.env.GBF_DEBUG_NOSHOT) { quitting = true; app.quit(); return; }
        const shot = async (wc, file) => {
          log('shot ' + file);
          wc.debugger.attach('1.3');
          const { data } = await Promise.race([
            wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('capture timeout')), 8000))
          ]);
          wc.debugger.detach();
          fs.writeFileSync(path.join(dir, file), Buffer.from(data, 'base64'));
          log('wrote ' + file);
        };
        await shot(sideView.webContents, 'side.png');
        await shot(gameView.webContents, 'game.png');
        fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({ gameUrl: gameView.webContents.getURL(), gameTitle: gameView.webContents.getTitle(), bounds: win.getContentBounds() }));
      } catch (e) { fs.writeFileSync(path.join(process.env.GBF_DEBUG_SHOT, 'error.txt'), String(e.stack || e)); }
      quitting = true; app.quit();
    }, 15000);
  }
});
