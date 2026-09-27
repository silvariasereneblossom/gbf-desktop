// Tiny JSON-file settings store (no native deps).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Resolve lazily: main.js may call app.setPath('userData', …) (debug profile isolation) AFTER this
// module is required, so computing the path at require-time would pin it to the wrong directory.
let _file = null;
function filePath() {
  if (!_file) _file = path.join(app.getPath('userData'), 'settings.json');
  return _file;
}

const DEFAULTS = {
  sidebarWidth: 340,
  sidebarVisible: true,
  closeToTray: true,
  launchAtLogin: false,
  notifications: {
    reset: true,          // 05:00 JST daily reset
    resetLeadMinutes: 30, // warn N minutes before reset if dailies incomplete
    halfElixir: false,    // hourly AP/EP "use your half elixirs" nag (off by default)
    customTimes: []       // ["12:00", "19:30"] local-time reminders
  },
  dailies: [
    { id: 'free-draw',   label: 'Free daily draw',          hash: '#gacha',               done: false },
    { id: 'missions',    label: 'Daily missions',           hash: '#mission/index/daily', done: false },
    { id: 'casino',      label: 'Casino daily',             hash: '#casino',              done: false },
    { id: 'arcarum',     label: 'Arcarum / Sandbox',        hash: '#arcarum2',            done: false },
    { id: 'coop-daily',  label: 'Co-op daily mission',      hash: '#coopraid',            done: false },
    { id: 'event',       label: 'Event dailies',            hash: '#event',               done: false },
    { id: 'shop',        label: 'Shop: daily trades',       hash: '#shop/exchange/list',  done: false }
  ],
  multiwindow: { autoTile: true }, // auto-tile main + extra game windows as they open/close
  recording: {             // built-in recorder (captures the game view only, via tab capture)
    fps: 30,
    quality: 'high',       // 'standard' ≈ 6 Mbps, 'high' ≈ 12 Mbps
    audio: true,           // game audio only (not system audio); you still hear it while recording
    folder: ''             // '' = Videos\GBF Desktop
  },
  bookmarks: [],          // user quick-jump links (GW raid pages etc.) — the common destinations
                          // already live in the Dailies quick-nav, so nothing is seeded here
  accounts: [{ id: 1, name: 'Account 1' }], // each account = its own isolated cookie jar (session partition)
  activeAccountId: 1,
  blockTrackers: true,     // block ad/analytics beacons the game waits on at raid start (faster joins)
  proxy: {                 // route ONLY the game session through a proxy (e.g. Mudfish SOCKS5 mode)
    enabled: false,
    rules: ''              // e.g. "socks5://127.0.0.1:8288" or "http://127.0.0.1:8888"
  },
  mudfish: {               // Mudfish web console (its local dashboard)
    port: 8282,
    user: '',              // account email/username (shown in UI)
    passEnc: ''            // password encrypted via Electron safeStorage (Windows DPAPI), base64
  },
  skyleap: {               // SkyLeap user-agent mode (community trick: points on desktop, no game sidebar)
    enabled: false,
    width: 0               // fixed game width in px when enabled (0 = fill); SkyLeap layout scales to width
  },
  autoRefresh: {           // reload the game view as soon as a battle action's result arrives
    attack: false,
    summon: false,
    skill: false,
    delayMs: 0,            // fixed floor before firing (ms)
    jitterMs: 0,           // + a random human-shaped amount on top (0 = machine-exact)
    pauseDuringFA: true    // don't reload while Full Auto is running (so it doesn't stop FA)
  },
  dailiesResetStamp: null, // YYYY-MM-DD (JST) of last auto-uncheck
  savedTeams: []           // imported granblue.team parties
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(filePath(), 'utf8')) };
    cache.notifications = { ...DEFAULTS.notifications, ...(cache.notifications || {}) };
    cache.autoRefresh = { ...DEFAULTS.autoRefresh, ...(cache.autoRefresh || {}) };
    cache.skyleap = { ...DEFAULTS.skyleap, ...(cache.skyleap || {}) };
    cache.proxy = { ...DEFAULTS.proxy, ...(cache.proxy || {}) };
    cache.mudfish = { ...DEFAULTS.mudfish, ...(cache.mudfish || {}) };
    cache.multiwindow = { ...DEFAULTS.multiwindow, ...(cache.multiwindow || {}) };
    cache.recording = { ...DEFAULTS.recording, ...(cache.recording || {}) };
    if (!Array.isArray(cache.bookmarks)) cache.bookmarks = [];
    // Migration: drop the briefly-shipped seed bookmarks (they duplicate the Dailies quick-nav);
    // anything the user added themselves is kept.
    if ((cache.bookmarksSchema || 0) < 2) {
      const seedIds = ['b-home', 'b-quest', 'b-pending', 'b-backups', 'b-raidid', 'b-party', 'b-gacha'];
      cache.bookmarks = cache.bookmarks.filter(b => !seedIds.includes(b.id));
      cache.bookmarksSchema = 2;
    }
    if (!Array.isArray(cache.accounts) || !cache.accounts.length) cache.accounts = [...DEFAULTS.accounts];
    if (!cache.accounts.some(a => a.id === cache.activeAccountId)) cache.activeAccountId = cache.accounts[0].id;
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return cache;
}

function save(partial) {
  const next = { ...load(), ...partial };
  cache = next;
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { load, save, DEFAULTS, filePath };
