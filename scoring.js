// Scoring: offense 10-0 = 30, 9-1 = 10, anything else 0; each defense win = 20.
// Everything else (first to 10-0, new offense tech, corrections) is a manual row in `bonuses`.
//
// Rounds store RAW own-guild stats keyed by in-game wizard_id. Who that account counts for is
// resolved here: manual wizard map (by id) first, then name/alias match. Name swaps then exchange
// two players' stats for one round.
(function (root) {
  // Lowercase, unify unicode forms, drop decoration (『』, ☆, dots, dashes, invisible chars).
  const norm = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

  // Suggestions only (an admin confirms): Cyrillic/Greek look-alikes, i/l/I/|/1 → "l", trailing numbers dropped.
  const FOLD = { "ø": "o", "е": "e", "о": "o", "а": "a", "і": "l", "τ": "t", "λ": "a", "ι": "l", "ο": "o", "α": "a", "ε": "e", "ρ": "p", "|": "l", "i": "l", "1": "l", "0": "o" };
  const fold = (s) => norm([...String(s).normalize("NFKC").toLowerCase().replace(/\d+\W*$/, "")].map((c) => FOLD[c] || c).join(""));
  function suggest(name, players) {
    const n = fold(name);
    if (n.length < 2) return null;
    const hit = players.find((p) => [p.name, ...(p.aliases || [])].some((x) => { const m = fold(x); return m.length > 1 && (n.startsWith(m) || m.startsWith(n)); }));
    return hit ? hit.name : null;
  }

  // Name swaps: an account always counts as its EARLIEST known name (Paul's rule), never its current one.
  // rounds: {n: {wizards: raw}} → {wizard_id: earliest name}
  function firstNames(rounds) {
    const first = {};
    for (const r of Object.keys(rounds).map(Number).sort((a, b) => a - b)) {
      for (const [id, rec] of Object.entries((rounds[r] && rounds[r].wizards) || {})) first[id] ??= rec.name;
    }
    return first;
  }

  // win_lose: 1 = win, 2 = loss. log_type 1 = that wizard attacking, 2 = defending.
  // Own guild = guild of the account whose client made the request (reqData.wizard_id).
  function tallyWizards(summary, reqData) {
    const info = summary.wizard_info_list || [];
    const me = info.find((w) => w.wizard_id === (reqData && reqData.wizard_id));
    if (!me) throw new Error("own guild not identifiable from request wizard_id");
    const raw = {};
    for (const w of info) {
      if (w.guild_id === me.guild_id) raw[w.wizard_id] = { name: w.wizard_name, off: { w: 0, l: 0 }, def: { w: 0, l: 0 } };
    }
    for (const e of summary.wizard_battle_log_list || []) {
      const rec = e.guild_id === me.guild_id && raw[e.wizard_id];
      if (!rec) continue;
      const side = e.log_type === 1 ? rec.off : rec.def;
      if (e.win_lose === 1) side.w++;
      else side.l++;
    }
    return raw;
  }

  function nameIndex(players) {
    const map = new Map();
    for (const p of players) for (const n of [p.name, ...(p.aliases || [])]) map.set(norm(n), p.name);
    return map;
  }

  // raw: {wizard_id: {name, off, def}}, wizardMap: {wizard_id: player}, swaps: [{player_a, player_b}]
  function resolveRound(raw, players, wizardMap, swaps, index = nameIndex(players), first = {}) {
    const wizards = {};
    const accounts = {}; // player -> in-game names that counted for them
    const unmatched = [];
    for (const [id, rec] of Object.entries(raw || {})) {
      const player = wizardMap[id] || index.get(norm(first[id] || rec.name));
      if (!player) { unmatched.push({ id, name: rec.name }); continue; }
      const acc = (wizards[player] ||= { off: { w: 0, l: 0 }, def: { w: 0, l: 0 } });
      acc.off.w += rec.off.w; acc.off.l += rec.off.l; acc.def.w += rec.def.w; acc.def.l += rec.def.l;
      (accounts[player] ||= []).push(rec.name);
    }
    for (const s of swaps || []) {
      [wizards[s.player_a], wizards[s.player_b]] = [wizards[s.player_b], wizards[s.player_a]];
      if (!wizards[s.player_a]) delete wizards[s.player_a];
      if (!wizards[s.player_b]) delete wizards[s.player_b];
    }
    return { wizards, accounts, unmatched };
  }

  const offensePoints = (o) => (o.w === 10 && o.l === 0 ? 30 : o.w === 9 && o.l === 1 ? 10 : 0);

  function playerRoundPoints(wizards, bonuses, player) {
    const rec = wizards && wizards[player];
    const offense = rec ? offensePoints(rec.off) : 0;
    const defense = rec ? rec.def.w * 20 : 0;
    const bonus = bonuses.filter((b) => b.player === player).reduce((s, b) => s + b.points, 0);
    return { offense, defense, bonus, total: offense + defense + bonus };
  }

  function rosterForRound(team, roundNo) {
    let roster = [];
    for (const h of [...team.history].sort((a, b) => a.from_round - b.from_round)) {
      if (h.from_round <= roundNo) roster = h.roster;
    }
    return roster;
  }

  // state: { players, rounds: {n:{wizards: raw}}, wizardMap, swaps:[{round_no,player_a,player_b}],
  //          teams:[{owner, history}], bonuses:[{round_no,player,points}], currentRound }
  function scoreAll(state) {
    const costOf = new Map(state.players.map((p) => [p.name, p.cost]));
    const index = nameIndex(state.players);
    const wizardMap = state.wizardMap || {};
    const swaps = state.swaps || [];
    const roundNos = [...new Set([...Object.keys(state.rounds).map(Number), ...state.bonuses.map((b) => b.round_no)])].sort((a, b) => a - b);
    const first = firstNames(state.rounds);
    const resolved = {};
    for (const r of roundNos) {
      resolved[r] = resolveRound(state.rounds[r] && state.rounds[r].wizards, state.players, wizardMap, swaps.filter((s) => s.round_no === r), index, first);
    }
    const pts = {}; // pts[round][player]
    const players = state.players.map((p) => ({
      name: p.name, cost: p.cost, offense: 0, defense: 0, bonus: 0, total: 0, offW: 0, offL: 0, defW: 0, defL: 0,
    }));
    for (const r of roundNos) {
      pts[r] = {};
      const bonuses = state.bonuses.filter((b) => b.round_no === r);
      for (const pl of players) {
        const x = (pts[r][pl.name] = playerRoundPoints(resolved[r].wizards, bonuses, pl.name));
        pl.offense += x.offense; pl.defense += x.defense; pl.bonus += x.bonus; pl.total += x.total;
        const rec = resolved[r].wizards[pl.name];
        if (rec) { pl.offW += rec.off.w; pl.offL += rec.off.l; pl.defW += rec.def.w; pl.defL += rec.def.l; }
      }
    }
    const teams = state.teams.map((t) => {
      const perRound = roundNos.map((r) => {
        const roster = rosterForRound(t, r);
        return { round: r, roster, points: roster.reduce((s, p) => s + pts[r][p].total, 0) };
      });
      const roster = rosterForRound(t, state.currentRound);
      const playerPts = {};
      for (const r of perRound) for (const p of r.roster) playerPts[p] = (playerPts[p] || 0) + pts[r.round][p].total;
      return {
        owner: t.owner, roster, perRound, playerPts,
        cost: roster.reduce((s, p) => s + (costOf.get(p) || 0), 0),
        total: perRound.reduce((s, r) => s + r.points, 0),
      };
    });
    teams.sort((a, b) => b.total - a.total || a.cost - b.cost); // tiebreak: lower total cost
    const defRate = (p) => (p.defW + p.defL ? p.defW / (p.defW + p.defL) : 0);
    players.sort((a, b) => b.total - a.total || defRate(b) - defRate(a)); // approximates the def-win-rate tiebreak
    return { teams, players, resolved };
  }

  const api = { norm, suggest, firstNames, tallyWizards, resolveRound, offensePoints, playerRoundPoints, rosterForRound, scoreAll };
  if (typeof module !== "undefined") module.exports = api;
  else root.Scoring = api;
})(typeof self !== "undefined" ? self : this);
