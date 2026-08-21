// Tiny JSON-file settings store (no native deps).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'settings.json');

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
  bookmarks: [            // quick-jump links (seeded from the gbf.wiki common-bookmarks list)
    { id: 'b-home',    label: 'Home',            hash: '#mypage' },
    { id: 'b-quest',   label: 'Quest Results',   hash: '#quest' },
    { id: 'b-pending', label: 'Pending raids',   hash: '#quest/assist/unclaimed/0/0' },
    { id: 'b-backups', label: 'Backup Requests', hash: '#quest/assist' },
    { id: 'b-raidid',  label: 'Raid ID',         hash: '#quest/assist_entry_id/0' },
    { id: 'b-party',   label: 'Party',           hash: '#party/index/0/npc/0' },
    { id: 'b-gacha',   label: 'Draw',            hash: '#gacha' }
  ],
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
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    cache.notifications = { ...DEFAULTS.notifications, ...(cache.notifications || {}) };
    cache.autoRefresh = { ...DEFAULTS.autoRefresh, ...(cache.autoRefresh || {}) };
    cache.skyleap = { ...DEFAULTS.skyleap, ...(cache.skyleap || {}) };
    cache.proxy = { ...DEFAULTS.proxy, ...(cache.proxy || {}) };
    cache.mudfish = { ...DEFAULTS.mudfish, ...(cache.mudfish || {}) };
    if (!Array.isArray(cache.bookmarks)) cache.bookmarks = DEFAULTS.bookmarks.map(b => ({ ...b }));
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
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { load, save, DEFAULTS, FILE };
