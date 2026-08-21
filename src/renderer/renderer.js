/* global gbf */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let settings = null;

// ---------- tabs / topbar ----------
$$('.tabs button').forEach(b => b.addEventListener('click', () => {
  $$('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
}));
$('#btn-reload').onclick = () => gbf.nav.reload();
$('#btn-zoom-in').onclick = () => gbf.nav.zoom(+0.5);
$('#btn-zoom-out').onclick = () => gbf.nav.zoom(-0.5);
$('#btn-hide').onclick = () => gbf.toggleSidebar();
$$('[data-go]').forEach(b => b.addEventListener('click', () => gbf.nav.go(b.dataset.go)));
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-ext]');
  if (a) { e.preventDefault(); gbf.openExternal(a.dataset.ext); }
});

// ---------- reset timer ----------
async function tickReset() {
  const ms = await gbf.resetMs();
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
  $('#reset-timer').textContent = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  $('.resetbox').classList.toggle('soon', ms < 30 * 60000);
}
setInterval(tickReset, 1000);

// ---------- dailies ----------
function renderDailies() {
  const ul = $('#dailies');
  ul.innerHTML = '';
  settings.dailies.forEach((d, i) => {
    const li = document.createElement('li');
    li.className = d.done ? 'done' : '';
    li.draggable = true; li.dataset.idx = i;
    li.innerHTML = `<input type="checkbox" ${d.done ? 'checked' : ''}><label>${esc(d.label)}</label>` +
      (d.hash ? `<button class="go" title="${esc(d.hash)}">→</button>` : '') + `<button class="rm" title="Remove">×</button>`;
    li.querySelector('input').onchange = async () => { settings.dailies = await gbf.dailies.toggle(d.id); renderDailies(); };
    li.querySelector('label').onclick = () => li.querySelector('input').click();
    const go = li.querySelector('.go'); if (go) go.onclick = () => gbf.nav.go(d.hash);
    li.querySelector('.rm').onclick = async () => {
      settings.dailies = await gbf.dailies.set(settings.dailies.filter(x => x.id !== d.id)); renderDailies();
    };
    li.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', i));
    li.addEventListener('dragover', e => { e.preventDefault(); li.classList.add('dragover'); });
    li.addEventListener('dragleave', () => li.classList.remove('dragover'));
    li.addEventListener('drop', async e => {
      e.preventDefault(); li.classList.remove('dragover');
      const from = +e.dataTransfer.getData('text/plain'), to = i;
      if (from === to) return;
      const arr = [...settings.dailies]; const [mv] = arr.splice(from, 1); arr.splice(to, 0, mv);
      settings.dailies = await gbf.dailies.set(arr); renderDailies();
    });
    ul.appendChild(li);
  });
  const left = settings.dailies.filter(d => !d.done).length;
  $('#dailies-left').textContent = left ? `${left} left` : 'all done ✓';
}
$('#add-daily').onclick = async () => {
  const label = $('#new-daily-label').value.trim(); if (!label) return;
  const hash = $('#new-daily-hash').value.trim();
  const id = 'c' + Date.now().toString(36);
  settings.dailies = await gbf.dailies.set([...settings.dailies, { id, label, hash, done: false }]);
  $('#new-daily-label').value = ''; $('#new-daily-hash').value = '';
  renderDailies();
};
$('#new-daily-label').addEventListener('keydown', e => e.key === 'Enter' && $('#add-daily').click());
gbf.on('dailies-reset', async () => { settings = await gbf.settings.get(); renderDailies(); });
gbf.on('settings-changed', async () => { settings = await gbf.settings.get(); renderSettings(); renderDailies(); renderBookmarks(); });

// ---------- bookmarks ----------
const openBookmark = (b) => (/^https?:\/\//.test(b.hash) ? gbf.openExternal(b.hash) : gbf.nav.go(b.hash));
const saveBookmarks = async (list) => { settings = await gbf.settings.set({ bookmarks: list }); renderBookmarks(); };

function renderBookmarks() {
  const ul = $('#bookmarks'); ul.innerHTML = '';
  const list = settings.bookmarks || [];
  if (!list.length) { ul.innerHTML = '<li class="hint">No bookmarks yet. Navigate the game to a page (e.g. a GW NM summon-select), then hit “+ current page”.</li>'; return; }
  list.forEach((b, i) => {
    const li = document.createElement('li');
    li.draggable = true; li.dataset.idx = i;
    li.innerHTML = `<label class="bm-go">${esc(b.label)}</label><small class="bm-hash">${esc(b.hash)}</small><button class="rm" title="Remove">×</button>`;
    li.querySelector('.bm-go').onclick = () => openBookmark(b);
    li.querySelector('.rm').onclick = () => saveBookmarks(settings.bookmarks.filter(x => x.id !== b.id));
    li.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', i));
    li.addEventListener('dragover', e => { e.preventDefault(); li.classList.add('dragover'); });
    li.addEventListener('dragleave', () => li.classList.remove('dragover'));
    li.addEventListener('drop', e => {
      e.preventDefault(); li.classList.remove('dragover');
      const from = +e.dataTransfer.getData('text/plain'); if (from === i) return;
      const arr = [...settings.bookmarks]; const [mv] = arr.splice(from, 1); arr.splice(i, 0, mv);
      saveBookmarks(arr);
    });
    ul.appendChild(li);
  });
}
const addBookmark = (label, hash) => saveBookmarks([...(settings.bookmarks || []), { id: 'b' + Date.now().toString(36), label, hash }]);
$('#add-bm').onclick = () => {
  const label = $('#new-bm-label').value.trim(); const hash = $('#new-bm-hash').value.trim();
  if (!label || !hash) return;
  addBookmark(label, hash);
  $('#new-bm-label').value = ''; $('#new-bm-hash').value = '';
};
$('#new-bm-hash').addEventListener('keydown', e => e.key === 'Enter' && $('#add-bm').click());
$('#bm-current').onclick = async () => {
  const url = await gbf.nav.currentUrl();
  const hash = (url.split('#')[1] || '').trim();
  if (!hash) { alert('The game is on its front page — open the screen you want to bookmark first.'); return; }
  const label = $('#new-bm-label').value.trim() || ('#' + hash).slice(0, 24);
  addBookmark(label, '#' + hash);
  $('#new-bm-label').value = '';
};
$('#bm-clear').onclick = () => { if ((settings.bookmarks || []).length && confirm('Remove all bookmarks? (Handy to wipe last GW’s stale raid links.)')) saveBookmarks([]); };

// ---------- teams ----------
const status = (msg, err) => { const el = $('#team-status'); el.textContent = msg || ''; el.classList.toggle('err', !!err); };

function cell(x, { wide = false, extraClass = '', tag = '', sub = '' } = {}) {
  const uc = x.uncap != null ? `<span class="uc">★${x.uncap}${x.transcendence ? `+${x.transcendence}` : ''}</span>` : '';
  const img = x.img ? `<img src="${esc(x.img)}" loading="lazy" onerror="this.style.display='none'">` : '';
  return `<div class="cell ${wide ? 'wide' : ''} ${extraClass}" title="${esc(x.name)}">${img}${uc}${tag ? `<span class="tag">${esc(tag)}</span>` : ''}<span class="nm">${esc(x.name) || '—'}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>`;
}

function renderTeam(t, { saved = false } = {}) {
  const mh = t.weapons.find(w => w.mainhand);
  const grid = t.weapons.filter(w => !w.mainhand);
  const mainS = t.summons.find(s => s.main), friendS = t.summons.find(s => s.friend);
  const subS = t.summons.filter(s => !s.main && !s.friend);
  const html = `
  <div class="team" data-code="${esc(t.shortcode)}">
    <h3>${esc(t.name)} <span class="elem ${esc(t.element)}">${esc(t.element)}</span></h3>
    <div class="meta">by <b>${esc(t.user)}</b>${t.raid ? ` · <b>${esc(t.raid)}</b>` : ''}${t.fullAuto ? ' · Full Auto' : ''}${t.turnCount ? ` · ${t.turnCount}T` : ''}${t.buttonCount ? ` · ${t.buttonCount}B` : ''}${t.clearTime ? ` · ${Math.floor(t.clearTime / 60)}:${String(t.clearTime % 60).padStart(2, '0')}` : ''}</div>
    <div class="grid chars">
      ${t.job ? cell({ name: t.job.name, img: t.job.img }, { tag: 'MC' }) : '<div class="cell"><span class="nm">No job</span></div>'}
      ${t.characters.map(c => cell(c, { sub: c.awakening })).join('')}
    </div>
    ${t.jobSkills.length ? `<div class="skills">Skills: ${t.jobSkills.map(esc).join(' · ')}</div>` : ''}
    <div class="sect-h"><span>Weapons</span></div>
    <div class="grid weps">
      ${mh ? cell(mh, { wide: true, extraClass: 'main', tag: 'MH', sub: [mh.keys.join(', '), mh.awakening].filter(Boolean).join(' · ') }) : ''}
      ${grid.map(w => cell(w, { wide: true, sub: [w.keys.join(', '), w.awakening].filter(Boolean).join(' · ') })).join('')}
    </div>
    <div class="sect-h"><span>Summons</span></div>
    <div class="grid sums">
      ${mainS ? cell(mainS, { wide: true, extraClass: 'main', tag: 'Main' }) : ''}
      ${friendS ? cell(friendS, { wide: true, tag: 'Friend' }) : ''}
      ${subS.map(s => cell(s, { wide: true, tag: s.quick ? 'Quick' : '' })).join('')}
    </div>
    ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ''}
    <div class="acts">
      <button data-act="party">Open Party in game</button>
      <button data-act="ext">granblue.team ↗</button>
      ${saved ? '<button data-act="unsave">Remove</button>' : '<button data-act="save">Save</button>'}
    </div>
  </div>`;
  const view = $('#team-view'); view.innerHTML = html;
  currentTeam = t; renderSlots();
  $('[data-act=party]', view).onclick = () => gbf.nav.go(currentDeck ? `#party/index/${currentDeck}/weapon/0` : '#party/index/0/npc/0');
  $('[data-act=ext]', view).onclick = () => gbf.openExternal(t.url);
  const sv = $('[data-act=save]', view); if (sv) sv.onclick = async () => { settings.savedTeams = await gbf.teams.save(t); renderSaved(); renderTeam(t, { saved: true }); };
  const us = $('[data-act=unsave]', view); if (us) us.onclick = async () => { settings.savedTeams = await gbf.teams.remove(t.shortcode); renderSaved(); renderTeam(t); };
}

// ---------- import panel (assisted + auto-equip) ----------
let currentTeam = null, currentDeck = null, currentSlots = [], autoRunning = false;
const doneKey = (t) => 'slots-done:' + t.shortcode;
const loadDone = (t) => { try { return new Set(JSON.parse(localStorage.getItem(doneKey(t)) || '[]')); } catch { return new Set(); } };
const saveDone = (t, set) => localStorage.setItem(doneKey(t), JSON.stringify([...set]));
const slotId = (s) => `${s.kind}:${s.setNum ?? ''}:${s.setSubNum ?? ''}:${s.id}`;

async function refreshDeck() {
  currentDeck = await gbf.party.deck();
  $('#deck-info').textContent = currentDeck ? `deck #${currentDeck}` : 'no deck detected';
  $('#deck-hint').classList.toggle('hidden', !!currentDeck);
  if (currentTeam) renderSlots();
}
gbf.on('game-url', () => refreshDeck());

async function renderSlots() {
  const panel = $('#import-panel');
  if (!currentTeam) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const box = $('#slot-list');
  if (!currentDeck) { box.innerHTML = ''; currentSlots = []; $('#slots-auto-all').classList.add('hidden'); return; }
  currentSlots = await gbf.party.slots(currentTeam, currentDeck);
  const done = loadDone(currentTeam);
  const auto = !!settings.autoEquipAccepted;
  box.innerHTML = currentSlots.map((s, i) => `
    <div class="slot ${done.has(slotId(s)) ? 'done' : ''}" data-i="${i}">
      <input type="checkbox" ${done.has(slotId(s)) ? 'checked' : ''} title="Mark done">
      ${s.img ? `<img src="${esc(s.img)}" onerror="this.style.visibility='hidden'">` : ''}
      <span class="si"><span class="sl">${esc(s.label)}</span><span class="sn" title="${esc(s.name)}">${esc(s.name)}${s.uncap != null ? ` <small>★${s.uncap}</small>` : ''}</span></span>
      <button class="open" title="Open this slot's picker in-game (${esc(s.route)})">Open</button>
      ${auto && s.kind !== 'job' ? `<button class="auto" title="Auto-equip this slot">⚡</button>` : ''}
    </div>`).join('');
  $$('.slot', box).forEach(row => {
    const s = currentSlots[+row.dataset.i];
    row.querySelector('input').onchange = (e) => { const d = loadDone(currentTeam); e.target.checked ? d.add(slotId(s)) : d.delete(slotId(s)); saveDone(currentTeam, d); row.classList.toggle('done', e.target.checked); };
    row.querySelector('.open').onclick = () => gbf.nav.go(s.route);
    const a = row.querySelector('.auto'); if (a) a.onclick = () => runAuto([s]);
  });
  $('#slots-auto-all').classList.toggle('hidden', !auto);
}

async function runAuto(list) {
  if (autoRunning) return;
  if (!settings.autoEquipAccepted) return;
  if (!confirm(`Auto-equip ${list.length} slot(s) into deck #${currentDeck}?\n\nThis operates the game client for you (ToS grey area — your risk). Keep the game visible and hands off until it finishes.`)) return;
  autoRunning = true;
  const st = $('#auto-status'); st.classList.remove('err');
  const done = loadDone(currentTeam);
  try {
    for (const s of list) {
      const row = $$('.slot', $('#slot-list')).find(r => currentSlots[+r.dataset.i] === s);
      row && row.classList.add('running');
      st.textContent = `Equipping ${s.label}: ${s.name}…`;
      const r = await gbf.party.autoEquip(s);
      row && row.classList.remove('running');
      if (!r.ok) {
        st.textContent = `Stopped at ${s.label} (${s.name}): ${r.message}`; st.classList.add('err');
        row && row.classList.add('failed');
        break;
      }
      done.add(slotId(s)); saveDone(currentTeam, done);
      row && (row.classList.add('done'), row.querySelector('input').checked = true);
      st.textContent = `${s.label}: ${r.message}`;
    }
    if (!st.classList.contains('err')) st.textContent = 'Done.';
  } finally { autoRunning = false; }
}
$('#slots-auto-all').onclick = () => { const d = loadDone(currentTeam); runAuto(currentSlots.filter(s => s.kind !== 'job' && !d.has(slotId(s)))); };
$('#slots-reset').onclick = () => { if (currentTeam) { saveDone(currentTeam, new Set()); renderSlots(); } };
$('#auto-accept').onchange = async (e) => { settings = await gbf.settings.set({ autoEquipAccepted: e.target.checked }); renderSlots(); };

function renderSaved() {
  const ul = $('#saved-teams'); ul.innerHTML = '';
  if (!settings.savedTeams.length) { ul.innerHTML = '<li class="hint">None yet — import one above.</li>'; return; }
  settings.savedTeams.forEach(t => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="elem ${esc(t.element)}">${esc(t.element)}</span><span class="t">${esc(t.name)}<small>${esc(t.raid || '')} · ${esc(t.user)}</small></span><button class="rm ghost">×</button>`;
    li.querySelector('.t').onclick = () => renderTeam(t, { saved: true });
    li.querySelector('.rm').onclick = async () => { settings.savedTeams = await gbf.teams.remove(t.shortcode); renderSaved(); };
    ul.appendChild(li);
  });
}

async function importTeam(input) {
  status('Fetching…');
  try {
    const t = await gbf.teams.fetch(input);
    status('');
    const saved = settings.savedTeams.some(s => s.shortcode === t.shortcode);
    renderTeam(t, { saved });
  } catch (e) { status(e.message.replace(/^Error invoking remote method '[^']+': Error: /, ''), true); }
}
$('#team-import').onclick = () => importTeam($('#team-input').value);
$('#team-input').addEventListener('keydown', e => e.key === 'Enter' && importTeam(e.target.value));

let explorePage = 1;
async function loadExplore(page = 1) {
  explorePage = page;
  const box = $('#explore-list'); box.classList.remove('hidden'); box.innerHTML = '<div class="hint">Loading…</div>';
  try {
    const { results, meta } = await gbf.teams.explore({ page, element: $('#explore-element').value });
    box.innerHTML = results.map(r => `<div class="it" data-code="${esc(r.shortcode)}"><span class="elem ${esc(r.element)}">${esc(r.element || '?')}</span><span class="n">${esc(r.name)}<small>${esc(r.raid)}${r.job ? ' · ' + esc(r.job) : ''} · ${esc(r.user)}${r.fullAuto ? ' · FA' : ''}</small></span></div>`).join('') +
      `<div class="pager"><button class="ghost" data-pg="${page - 1}" ${page <= 1 ? 'disabled' : ''}>‹</button><span>${page} / ${meta.total_pages}</span><button class="ghost" data-pg="${page + 1}" ${page >= meta.total_pages ? 'disabled' : ''}>›</button></div>`;
    $$('.it', box).forEach(el => el.onclick = () => importTeam(el.dataset.code));
    $$('[data-pg]', box).forEach(b => b.onclick = () => loadExplore(+b.dataset.pg));
  } catch (e) { box.innerHTML = `<div class="status err">${esc(e.message)}</div>`; }
}
$('#team-explore').onclick = () => $('#explore-list').classList.contains('hidden') ? loadExplore(1) : $('#explore-list').classList.add('hidden');
$('#explore-element').onchange = () => loadExplore(1);

// ---------- settings ----------
function renderAutoRefresh() {
  const a = settings.autoRefresh || {};
  $('#ar-attack').checked = !!a.attack; $('#ar-summon').checked = !!a.summon; $('#ar-skill').checked = !!a.skill;
  $('#ar-delay').value = a.delayMs || 0;
  $('#ar-jitter').value = a.jitterMs || 0;
  $('#ar-pausefa').checked = a.pauseDuringFA !== false;
  $('#btn-ar').classList.toggle('on', !!a.attack);
  $('#btn-ar').title = `Auto-refresh on attack: ${a.attack ? 'ON' : 'off'} (click to toggle)`;
}
async function saveAutoRefresh(patch) {
  settings = await gbf.settings.set({ autoRefresh: { ...settings.autoRefresh, ...patch } });
  renderAutoRefresh();
}
$('#btn-ar').onclick = () => saveAutoRefresh({ attack: !settings.autoRefresh.attack });
$('#ar-attack').onchange = e => saveAutoRefresh({ attack: e.target.checked });
$('#ar-summon').onchange = e => saveAutoRefresh({ summon: e.target.checked });
$('#ar-skill').onchange = e => saveAutoRefresh({ skill: e.target.checked });
$('#ar-delay').onchange = e => saveAutoRefresh({ delayMs: Math.max(0, Math.min(3000, +e.target.value || 0)) });
$('#ar-jitter').onchange = e => saveAutoRefresh({ jitterMs: Math.max(0, Math.min(3000, +e.target.value || 0)) });
$('#ar-pausefa').onchange = e => saveAutoRefresh({ pauseDuringFA: e.target.checked });

$('#btn-newwin').onclick = () => gbf.newGameWindow();
gbf.on('ping', (ms) => {
  const box = $('#pingbox');
  $('#ping-ms').textContent = ms == null ? '—' : ms + 'ms';
  box.classList.remove('good', 'mid', 'bad');
  if (ms != null) box.classList.add(ms < 120 ? 'good' : ms < 250 ? 'mid' : 'bad');
});

function renderNetwork() {
  $('#opt-trackers').checked = !!settings.blockTrackers;
  const p = settings.proxy || {};
  $('#px-enabled').checked = !!p.enabled;
  $('#px-rules').value = p.rules || '';
}
$('#opt-trackers').onchange = async (e) => { settings = await gbf.settings.set({ blockTrackers: e.target.checked }); };
$('#px-enabled').onchange = async (e) => { settings = await gbf.proxyApply({ enabled: e.target.checked }); renderNetwork(); };
$('#px-rules').onchange = async (e) => { settings = await gbf.proxyApply({ rules: e.target.value.trim() }); renderNetwork(); };

function renderAccounts() {
  const sel = $('#acc-select');
  sel.innerHTML = (settings.accounts || []).map(a =>
    `<option value="${a.id}" ${a.id === settings.activeAccountId ? 'selected' : ''}>${esc(a.name)}${a.id === settings.activeAccountId ? ' (active)' : ''}</option>`).join('');
}
$('#acc-select').onchange = async (e) => { settings = await gbf.accounts.switch(+e.target.value); renderAccounts(); };
$('#acc-add').onclick = async () => { settings = await gbf.accounts.add($('#acc-name').value); $('#acc-name').value = ''; renderAccounts(); };
$('#acc-rename').onclick = async () => { settings = await gbf.accounts.rename(+$('#acc-select').value, $('#acc-name').value); $('#acc-name').value = ''; renderAccounts(); };
$('#acc-remove').onclick = async () => {
  const id = +$('#acc-select').value;
  const name = (settings.accounts.find(a => a.id === id) || {}).name || id;
  if (!confirm(`Remove account "${name}" and wipe its saved login?`)) return;
  const r = await gbf.accounts.remove(id);
  if (r.error) { alert(r.error); return; }
  settings = r; renderAccounts();
};

async function renderMudfish() {
  const s = await gbf.mudfish.status();
  $('#mf-port').value = s.port;
  $('#mf-status').textContent = !s.installed ? 'not installed' : s.running ? 'running ✓' : 'installed, not running';
  $('#mf-open').disabled = !s.installed && !s.running;
  $('#mf-launch').disabled = !s.installed || s.running;
  const m = settings.mudfish || {};
  $('#mf-user').value = m.user || '';
  $('#mf-creds-hint').textContent = m.user && m.passEnc ? `Sign-in saved for ${m.user} (encrypted) — auto-fills the console.` : 'No sign-in saved — you can also just log in inside the console window (it remembers).';
}
$('#mf-save').onclick = async () => {
  const u = $('#mf-user').value.trim(), p = $('#mf-pass').value;
  const r = await gbf.mudfish.saveCreds(u, p);
  if (!r.ok) { $('#mf-creds-hint').textContent = 'Could not save: ' + r.message; return; }
  $('#mf-pass').value = '';
  settings = await gbf.settings.get();
  renderMudfish();
};
gbf.on('mudfish-up', renderMudfish);
$('#mf-open').onclick = () => gbf.mudfish.open();
$('#mf-launch').onclick = async () => { await gbf.mudfish.launch(); $('#mf-status').textContent = 'starting…'; setTimeout(renderMudfish, 6000); };
$('#mf-port').onchange = async (e) => { settings = await gbf.mudfish.setPort(+e.target.value); renderMudfish(); };
$$('.tabs button').forEach(b => b.addEventListener('click', () => { if (b.dataset.tab === 'settings') renderMudfish(); }));

function renderSkyleap() {
  const sl = settings.skyleap || {};
  $('#sl-enabled').checked = !!sl.enabled;
  $('#sl-width').value = sl.width || 0;
}
$('#sl-enabled').onchange = async (e) => { settings = await gbf.skyleapApply({ enabled: e.target.checked }); renderSkyleap(); };
$('#sl-width').onchange = async (e) => { settings = await gbf.skyleapApply({ width: Math.max(0, Math.min(2000, +e.target.value || 0)) }); renderSkyleap(); };

function renderSettings() {
  renderAutoRefresh();
  renderSkyleap();
  renderNetwork();
  renderAccounts();
  const n = settings.notifications;
  $('#opt-reset').checked = n.reset; $('#opt-lead').value = n.resetLeadMinutes; $('#opt-halfelixir').checked = n.halfElixir;
  $('#opt-custom').value = (n.customTimes || []).join(', ');
  $('#opt-tray').checked = settings.closeToTray; $('#opt-login').checked = settings.launchAtLogin; $('#opt-width').value = settings.sidebarWidth;
}
async function saveSettings() {
  const customTimes = $('#opt-custom').value.split(',').map(s => s.trim()).filter(s => /^\d{1,2}:\d{2}$/.test(s)).map(s => s.padStart(5, '0'));
  settings = await gbf.settings.set({
    notifications: { ...settings.notifications, reset: $('#opt-reset').checked, resetLeadMinutes: +$('#opt-lead').value || 0, halfElixir: $('#opt-halfelixir').checked, customTimes },
    closeToTray: $('#opt-tray').checked, launchAtLogin: $('#opt-login').checked,
    sidebarWidth: Math.max(260, Math.min(600, +$('#opt-width').value || 340))
  });
  renderSettings();
}
$$('#tab-settings input:not([id^=ar-]):not([id^=sl-]):not([id^=px-]):not([id^=mf-]):not([id^=acc-]):not(#opt-trackers)').forEach(i => i.addEventListener('change', saveSettings));
$('#btn-clear-session').onclick = () => { if (confirm('Clear all game cookies and reload? You will need to log in again.')) gbf.clearSession(); };
$('#btn-open-ext').onclick = () => gbf.openCurrentExternal();
$('#btn-data-folder').onclick = () => gbf.openDataFolder();

// ---------- boot ----------
(async () => {
  settings = await gbf.settings.get();
  $('#auto-accept').checked = !!settings.autoEquipAccepted;
  renderDailies(); renderBookmarks(); renderSaved(); renderSettings(); tickReset(); refreshDeck(); renderMudfish();
})();
