// granblue.team importer. Uses the public hensei-api (https://github.com/jedmund/hensei-api).
const API = 'https://api.granblue.team/v1';
const CDN = 'https://prd-game-a-granbluefantasy.akamaized.net/assets_en/img/sp/assets';

const ELEMENTS = ['Any', 'Wind', 'Fire', 'Water', 'Earth', 'Dark', 'Light'];

function shortcodeFrom(input) {
  const s = String(input || '').trim();
  const m = s.match(/granblue\.team\/(?:teams|p)\/([A-Za-z0-9_-]+)/) || s.match(/^([A-Za-z0-9_-]{4,12})$/);
  return m ? m[1] : null;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'gbf-desktop/0.1' } });
  if (!res.ok) throw new Error(`granblue.team returned ${res.status}`);
  return res.json();
}

/** Normalize a party into a compact, renderable shape. */
function normalize(raw) {
  const p = raw.party || raw;
  const n = (o) => (o && o.name && (o.name.en || o.name.ja)) || '';
  return {
    shortcode: p.shortcode,
    name: p.name || '(untitled)',
    url: `https://granblue.team/teams/${p.shortcode}`,
    description: p.description || '',
    user: p.user ? (p.user.display_name || p.user.username) : 'anonymous',
    raid: p.raid ? n(p.raid) : '',
    element: ELEMENTS[p.element] || '',
    fullAuto: !!p.full_auto,
    chargeAttack: !!p.charge_attack,
    buttonCount: p.button_count, turnCount: p.turn_count, chainCount: p.chain_count,
    clearTime: p.clear_time,
    job: p.job ? { name: n(p.job), id: p.job.granblue_id, img: `${CDN}/leader/m/${p.job.granblue_id}_01.jpg` } : null,
    jobSkills: Object.values(p.job_skills || {}).filter(Boolean).map(s => n(s)),
    characters: (p.characters || []).sort((a, b) => a.position - b.position).map(c => ({
      position: c.position,
      name: n(c.character),
      id: c.character && c.character.granblue_id,
      elementId: c.character ? c.character.element : null,
      rarity: c.character ? c.character.rarity : null,
      uncap: c.uncap_level,
      transcendence: c.transcendence_step || 0,
      perpetuity: !!c.perpetuity,
      awakening: c.awakening && c.awakening.type ? `${n(c.awakening.type)} ${c.awakening.level || ''}`.trim() : '',
      img: c.character ? `${CDN}/npc/m/${c.character.granblue_id}_01.jpg` : ''
    })),
    weapons: (p.weapons || []).sort((a, b) => a.position - b.position).map(w => ({
      position: w.position,
      mainhand: !!w.mainhand,
      name: n(w.weapon),
      id: w.weapon && w.weapon.granblue_id,
      uncap: w.uncap_level,
      transcendence: w.transcendence_step || 0,
      element: w.element != null ? ELEMENTS[w.element] : (w.weapon ? ELEMENTS[w.weapon.element] : ''),
      elementId: w.element != null ? w.element : (w.weapon ? w.weapon.element : null),
      rarity: w.weapon ? w.weapon.rarity : null,
      keys: (w.weapon_keys || []).filter(Boolean).map(k => n(k)),
      ax: (w.ax || []).filter(Boolean),
      awakening: w.awakening && w.awakening.type ? `${n(w.awakening.type)} ${w.awakening.level || ''}`.trim() : '',
      img: w.weapon ? `${CDN}/weapon/m/${w.weapon.granblue_id}.jpg` : ''
    })),
    summons: (p.summons || []).sort((a, b) => a.position - b.position).map(s => ({
      position: s.position,
      main: !!s.main, friend: !!s.friend, quick: !!s.quick_summon,
      name: n(s.summon),
      id: s.summon && s.summon.granblue_id,
      elementId: s.summon ? s.summon.element : null,
      rarity: s.summon ? s.summon.rarity : null,
      uncap: s.uncap_level,
      transcendence: s.transcendence_step || 0,
      img: s.summon ? `${CDN}/summon/m/${s.summon.granblue_id}.jpg` : ''
    })),
    importedAt: new Date().toISOString()
  };
}

async function fetchParty(input) {
  const code = shortcodeFrom(input);
  if (!code) throw new Error('Paste a granblue.team URL or shortcode (e.g. c6WX3u)');
  return normalize(await getJSON(`${API}/parties/${code}`));
}

/** Explore list (same data behind granblue.team/teams/explore). */
async function explore({ page = 1, element, raid, recency } = {}) {
  const q = new URLSearchParams({ page });
  if (element != null && element !== '') q.set('element', element);
  if (raid) q.set('raid', raid);
  if (recency) q.set('recency', recency);
  const data = await getJSON(`${API}/parties?${q}`);
  const n = (o) => (o && o.name && (o.name.en || o.name.ja)) || '';
  return {
    meta: data.meta,
    results: (data.results || []).map(p => ({
      shortcode: p.shortcode,
      name: p.name || '(untitled)',
      user: p.user ? (p.user.display_name || p.user.username) : 'anonymous',
      job: p.job ? n(p.job) : '',
      raid: p.raid ? n(p.raid) : '',
      element: ELEMENTS[p.element] || '',
      fullAuto: !!p.full_auto,
      updated: p.last_updated
    }))
  };
}

module.exports = { fetchParty, explore, shortcodeFrom, normalize };
