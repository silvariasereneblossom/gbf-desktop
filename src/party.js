// Party import helpers.
//  - routes(): assisted mode — hash routes that open the game's own picker for a slot, pre-filtered.
//  - autoEquipScript(): UI-level automation — a script run inside the game page that drives the
//    game's own views (navigate → find owned copy in the list the game loaded → tap → tap Equip).
//    No private API calls are made by us; the game's own handlers do what a click would do.
//
// Game conventions (from router/party-router.js + view/party/*.js):
//   #party/index/{deck}/{npc|weapon|summon}/0
//   #party/list_weapon/pc/{deck}/{set_num}(/{page}/{returnHash}/{rarity}/{attribute})   set_num 1=MH, 2-10 grid, 11-13 extra
//   #party/list_summon/pc/{deck}/{set_num}/{set_sub_num}(/{page}/{returnHash}/{rarity}/{attribute})  1=main, 2-5 sub, sub-aura: set_sub_num 1/2
//   #party/list_npc/{deck}/{set_num}(/{page}/{returnHash}/{rarity}/{attribute})          1-3 front, 4-5 back
//   #party/list_job/{deck}
// Element ids: game 1 Fire 2 Water 3 Earth 4 Wind 5 Light 6 Dark; hensei 1 Wind 2 Fire 3 Water 4 Earth 5 Dark 6 Light.

const HENSEI_TO_GAME_ELEMENT = { 1: 4, 2: 1, 3: 2, 4: 3, 5: 6, 6: 5 };
const gameElement = (henseiId) => HENSEI_TO_GAME_ELEMENT[henseiId] || 0;
const gameRarity = (henseiRarity) => (henseiRarity ? henseiRarity + 1 : 0); // hensei 3 (SSR) → game 4

/** Build the list of slots for a normalized team: {kind, label, name, id, img, setNum, setSubNum, route}. */
function slots(team, deck) {
  const out = [];
  const filt = (rarity, elementId) => {
    const r = gameRarity(rarity), a = gameElement(elementId);
    return r && a ? `/1/null/${r}/${a}` : '';
  };
  if (team.job) out.push({ kind: 'job', label: 'Job', name: team.job.name, id: team.job.id, img: team.job.img, route: `#party/list_job/${deck}` });
  for (const c of team.characters) {
    const setNum = (c.position | 0) + 1;
    out.push({ kind: 'npc', label: setNum <= 3 ? `Char ${setNum}` : `Back ${setNum - 3}`, name: c.name, id: c.id, img: c.img, uncap: c.uncap, setNum,
      route: `#party/list_npc/${deck}/${setNum}${filt(c.rarity, c.elementId)}` });
  }
  for (const w of team.weapons) {
    const setNum = w.mainhand ? 1 : (w.position | 0) + 2;
    out.push({ kind: 'weapon', label: w.mainhand ? 'Mainhand' : (setNum <= 10 ? `Grid ${setNum - 1}` : `Extra ${setNum - 10}`), name: w.name, id: w.id, img: w.img, uncap: w.uncap, setNum,
      route: `#party/list_weapon/pc/${deck}/${setNum}${filt(w.rarity, w.elementId)}` });
  }
  for (const s of team.summons) {
    if (s.friend) continue;
    let setNum, setSubNum = 0, label;
    if (s.main) { setNum = 1; label = 'Main summon'; }
    else if ((s.position | 0) <= 3) { setNum = (s.position | 0) + 2; label = `Sub summon ${setNum - 1}`; }
    else { setNum = 0; setSubNum = (s.position | 0) - 3; label = `Sub-aura ${setSubNum}`; }
    out.push({ kind: 'summon', label, name: s.name, id: s.id, img: s.img, uncap: s.uncap, setNum, setSubNum,
      route: `#party/list_summon/pc/${deck}/${setNum}/${setSubNum}${filt(s.rarity, s.elementId)}` });
  }
  return out;
}

/**
 * Script executed in the game page (main world). Resolves to {ok, message}.
 * slot: {kind:'weapon'|'summon'|'npc', route, id, uncap}
 */
function autoEquipScript(slot) {
  const cfg = JSON.stringify({ kind: slot.kind, route: slot.route, id: String(slot.id), uncap: slot.uncap | 0 });
  return `(async () => {
    const cfg = ${cfg};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const jitter = (a, b) => sleep(a + Math.random() * (b - a));
    const until = async (fn, ms, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(120); } throw new Error('timeout waiting for ' + what); };
    const $ = window.jQuery || window.$;
    if (!$ || !window.Game) return { ok: false, message: 'game not ready' };
    const modelName = { weapon: 'weapon', summon: 'summon', npc: 'npcs' }[cfg.kind];
    const itemSel = { weapon: '.lis-weapon', summon: '.lis-summon', npc: '.lis-npc' }[cfg.kind];
    const listHash = { weapon: 'list_weapon', summon: 'list_summon', npc: 'list_npc' }[cfg.kind];
    const detailHash = { weapon: 'detail_weapon', summon: 'detail_summon', npc: 'detail_npc' }[cfg.kind];
    const prevView = window.Game.view;
    location.hash = cfg.route;
    await until(() => location.hash.includes(listHash) && Game.view && Game.view !== prevView && Game.view[modelName] && Game.view[modelName].attributes && Game.view[modelName].attributes.list && document.querySelectorAll(itemSel).length, 12000, 'list to load');
    await jitter(500, 900);
    let pages = 0;
    while (true) {
      const m = Game.view[modelName].toJSON();
      const list = m.list || [];
      const cands = list.map((it, key) => ({ key, it })).filter(x => String(x.it.master && x.it.master.id) === cfg.id);
      if (cands.length) {
        cands.sort((a, b) => (Math.abs((+a.it.param.evolution || 0) - cfg.uncap) - Math.abs((+b.it.param.evolution || 0) - cfg.uncap)) || ((+b.it.param.level || 0) - (+a.it.param.level || 0)));
        const el = document.querySelector(itemSel + '[key="' + cands[0].key + '"]');
        if (!el) return { ok: false, message: 'list item element missing' };
        await jitter(300, 700);
        $(el).trigger('tap');
        await until(() => location.hash.includes(detailHash) && document.querySelector('.btn-equip'), 12000, 'detail screen');
        await jitter(600, 1100);
        $('.btn-equip').first().trigger('tap');
        await until(() => location.hash.includes('party/index') || document.querySelector('.pop-usual, .pop-weapon-limitover, .pop-multi-chara, .pop-force-include'), 12000, 'equip to finish');
        if (!location.hash.includes('party/index')) return { ok: false, message: 'game showed a dialog — handle it in-game, then continue' };
        await jitter(700, 1200);
        return { ok: true, message: 'equipped ' + (cands[0].it.master.name || cfg.id) };
      }
      const cur = +m.current || 1, last = +m.last || cur;
      if (cur >= last || ++pages > 20) return { ok: false, message: 'not found in your list (is the filter hiding it? do you own it?)' };
      const before = cur;
      await jitter(400, 800);
      $('.btn-forward').first().trigger('tap');
      await until(() => Game.view[modelName] && (+Game.view[modelName].toJSON().current || 1) !== before, 12000, 'next page');
      await jitter(300, 600);
    }
  })()`;
}

module.exports = { slots, autoEquipScript, gameElement, gameRarity };
