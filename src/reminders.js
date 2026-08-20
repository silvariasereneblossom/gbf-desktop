// Reset / dailies reminder scheduler. Everything keyed off JST (UTC+9).
const { Notification } = require('electron');
const store = require('./store');

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const RESET_HOUR_JST = 5;

function jstNow() { return new Date(Date.now() + JST_OFFSET_MS); }

/** YYYY-MM-DD of the current "GBF day" (a day rolls over at 05:00 JST). */
function gbfDayStamp() {
  const j = jstNow();
  if (j.getUTCHours() < RESET_HOUR_JST) j.setUTCDate(j.getUTCDate() - 1);
  return j.toISOString().slice(0, 10);
}

/** ms until the next 05:00 JST. */
function msUntilReset() {
  const j = jstNow();
  const next = new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate(), RESET_HOUR_JST, 0, 0));
  if (next <= j) next.setUTCDate(next.getUTCDate() + 1);
  return next - j;
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
}

class Reminders {
  constructor({ onNavigate, onDailiesReset }) {
    this.onNavigate = onNavigate;
    this.onDailiesReset = onDailiesReset;
    this.timers = [];
    this.firedCustomToday = new Set();
    this.firedLead = false;
  }

  start() {
    this.stop();
    this.checkDailiesRollover();
    // One lightweight tick per 30s handles everything; cheap and survives sleep/wake.
    this.timers.push(setInterval(() => this.tick(), 30 * 1000));
    this.tick();
  }

  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  checkDailiesRollover() {
    const s = store.load();
    const stamp = gbfDayStamp();
    if (s.dailiesResetStamp !== stamp) {
      const dailies = s.dailies.map(d => ({ ...d, done: false }));
      store.save({ dailies, dailiesResetStamp: stamp });
      this.firedCustomToday.clear();
      this.firedLead = false;
      this.onDailiesReset && this.onDailiesReset();
      if (s.dailiesResetStamp && s.notifications.reset) {
        notify('Granblue Fantasy — Daily reset', 'It is 05:00 JST. Dailies have been reset.',
          () => this.onNavigate('#mypage'));
      }
    }
  }

  tick() {
    const s = store.load();
    this.checkDailiesRollover();

    // Lead warning before reset if anything is unchecked.
    const lead = (s.notifications.resetLeadMinutes || 0) * 60 * 1000;
    const remaining = msUntilReset();
    if (s.notifications.reset && lead > 0 && !this.firedLead && remaining <= lead) {
      const pending = s.dailies.filter(d => !d.done);
      this.firedLead = true;
      if (pending.length) {
        notify(`Reset in ${Math.round(remaining / 60000)} min`,
          `Unfinished: ${pending.map(d => d.label).join(', ')}`,
          () => this.onNavigate(pending[0].hash));
      }
    }

    // Custom local-time reminders ("HH:MM").
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    for (const t of s.notifications.customTimes || []) {
      if (t === hhmm && !this.firedCustomToday.has(t)) {
        this.firedCustomToday.add(t);
        const pending = s.dailies.filter(d => !d.done);
        notify('Granblue Fantasy reminder',
          pending.length ? `Still to do: ${pending.map(d => d.label).join(', ')}` : 'All dailies done — nice.',
          () => this.onNavigate('#mypage'));
      }
    }

    // Hourly half-elixir nag, on the hour.
    if (s.notifications.halfElixir && now.getMinutes() === 0 && !this.firedCustomToday.has('hx' + now.getHours())) {
      this.firedCustomToday.add('hx' + now.getHours());
      notify('AP check', 'Hourly nudge: spend your AP / half elixirs.', () => this.onNavigate('#quest'));
    }
  }
}

module.exports = { Reminders, msUntilReset, gbfDayStamp, notify };
