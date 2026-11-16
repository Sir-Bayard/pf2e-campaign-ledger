import { L, MOD } from "./constants.mjs";

/* Totals per character from a list of events, as the dashboard, the recap and the API count them. */

function blank(w) {
  return {
    k: w.k, n: w.n, p: w.p,
    atk: 0, atkKnown: 0, hit: 0, crit: 0, critFail: 0, weapons: {},
    dmg: 0, dmgBest: 0, dmgBestIt: null, dmgRolls: 0,
    dealt: 0, dealtBest: 0, dealtBestIt: null, ff: 0, healDone: 0,
    heal: 0, healBest: 0,
    taken: 0, takenBest: 0, takenBestBy: null, critTaken: 0, healed: 0,
    kills: 0, killed: {}, down: 0, dyingMax: 0, dead: 0, revived: 0, revivedBy: 0,
    saves: { fortitude: [0, 0, 0, 0], reflex: [0, 0, 0, 0], will: [0, 0, 0, 0] },
    skills: {}, spells: {}, abilities: {}, abilityN: 0, skillN: 0, skillKnown: 0, skillPass: 0, forced: 0, forcedFail: 0, focus: 0, hero: 0, rerolls: 0, rerollsBetter: 0,
    nat20: 0, nat1: 0, rec: 0, recPass: 0, encounters: new Set(),
  };
}

function weaponRow() {
  return { n: 0, known: 0, hit: 0, crit: 0, dmg: 0, dealt: 0 };
}

function aggregate(events) {
  const initNat = game.settings.get(MOD, "initiativeNat") !== false;
  const by = new Map();
  const get = (w) => {
    if (typeof w?.k !== "string" || !w.k) return null;
    if (!by.has(w.k)) by.set(w.k, blank(w));
    const row = by.get(w.k);
    // Events come oldest first: a character renamed since shows under the newer name
    if (w.n) row.n = w.n;
    return row;
  };
  let bad = 0;
  for (const e of events) {
    // Quests revealed and objectives marked belong to the party as a whole, not to a character
    if (e.k === "goal" || e.k === "quest") continue;
    const a = get(e.a);
    // Only dealt, healdone and kill can lack an actor; anything else without one (an import, a hand-edited file) is
    // skipped rather than stopping every tab from drawing
    if (!a && !["dealt", "healdone", "kill"].includes(e.k)) {
      bad++;
      continue;
    }
    if (a && e.e) a.encounters.add(e.e);
    // Initiative, which everyone rolls, counts toward natural 20s and 1s only when the GM's setting says so
    const counts = a && e.k !== "reroll" && (initNat || !(e.k === "skill" && e.s === "initiative"));
    if (e.nat === 20 && counts) a.nat20++;
    if (e.nat === 1 && counts) a.nat1++;
    switch (e.k) {
      case "atk": {
        const known = e.o !== null && e.o !== undefined;
        a.atk++;
        if (known) a.atkKnown++;
        if (e.o >= 2) a.hit++;
        if (e.o === 3) a.crit++;
        if (e.o === 0) a.critFail++;
        const wpn = (a.weapons[e.it ?? L("Strike")] ??= weaponRow());
        wpn.n++;
        if (known) wpn.known++;
        if (e.o >= 2) wpn.hit++;
        if (e.o === 3) wpn.crit++;
        const tg = e.o === 3 ? get(e.tg) : null;
        if (tg) tg.critTaken++;
        break;
      }
      case "dmg": {
        a.dmg += e.amt;
        a.dmgRolls++;
        if (e.amt > a.dmgBest) {
          a.dmgBest = e.amt;
          a.dmgBestIt = e.it;
        }
        if (e.it) (a.weapons[e.it] ??= weaponRow()).dmg += e.amt;
        break;
      }
      case "dealt": {
        if (!a) break;
        // Damage a creature did to itself (sessions before 1.2.0 credited unattributed persistent ticks to the victim)
        // is nobody's: neither dealt nor friendly fire
        if (e.tg?.k && e.tg.k === a.k) break;
        // Damage to their own side (an ally caught in a blast) is friendly fire, not damage dealt
        if (e.tg?.k && !!e.tg.p === !!a.p) {
          a.ff += e.amt;
          break;
        }
        a.dealt += e.amt;
        if (e.amt > a.dealtBest) {
          a.dealtBest = e.amt;
          a.dealtBestIt = e.it;
        }
        if (e.it) (a.weapons[e.it] ??= weaponRow()).dealt += e.amt;
        break;
      }
      case "healdone":
        if (a) a.healDone += e.amt;
        break;
      case "heal":
        a.heal += e.amt;
        a.healBest = Math.max(a.healBest, e.amt);
        break;
      case "taken":
        a.taken += e.amt;
        if (e.amt > a.takenBest) {
          a.takenBest = e.amt;
          a.takenBestBy = e.by?.n ?? null;
        }
        break;
      case "healed":
        a.healed += e.amt;
        break;
      case "kill":
        if (a) {
          a.kills++;
          a.killed[e.v?.n ?? "?"] = (a.killed[e.v?.n ?? "?"] ?? 0) + 1;
        }
        break;
      case "down":
        a.down++;
        break;
      case "dying":
        a.dyingMax = Math.max(a.dyingMax, e.v ?? 0);
        break;
      case "dead":
        a.dead++;
        break;
      case "up": {
        a.revived++;
        const reviver = get(e.by);
        if (reviver) reviver.revivedBy++;
        break;
      }
      case "save": {
        // [rolls, passed, critical failures, rolls with a known DC]
        const s = a.saves[e.s] ?? (a.saves[e.s] = [0, 0, 0, 0]);
        s[0]++;
        if (e.o !== null && e.o !== undefined) s[3]++;
        if (e.o >= 2) s[1]++;
        if (e.o === 0) s[2]++;
        // Credit the caster with saves forced on the other side (not on their own allies).
        const c = e.by && e.a && e.by.p !== e.a.p ? get(e.by) : null;
        if (c) {
          c.forced++;
          if (e.o === 0 || e.o === 1) c.forcedFail++;
        }
        break;
      }
      case "skill": {
        const s = (a.skills[e.s] ??= { n: 0, known: 0, pass: 0, nat20: 0, nat1: 0 });
        s.n++;
        if (e.o !== null && e.o !== undefined) {
          s.known++;
          if (e.o >= 2) s.pass++;
        }
        if (e.nat === 20) s.nat20++;
        if (e.nat === 1) s.nat1++;
        // Skill use as a contribution: everything but initiative, which everyone rolls.
        if (e.s !== "initiative") {
          a.skillN++;
          if (e.o !== null && e.o !== undefined) {
            a.skillKnown++;
            if (e.o >= 2) a.skillPass++;
          }
        }
        break;
      }
      case "rec":
        a.rec++;
        if (e.o >= 2) a.recPass++;
        break;
      case "ability":
        (a.abilities[e.it] ??= { n: 0 }).n++;
        a.abilityN++;
        break;
      case "spell": {
        const s = (a.spells[e.it] ??= { n: 0, rk: e.rk, fo: e.fo, ca: e.ca });
        s.n++;
        break;
      }
      case "focus":
        a.focus += e.n ?? 1;
        break;
      case "hero":
        if (!e.lost) a.hero += e.n ?? 1;
        break;
      case "reroll":
        a.rerolls++;
        if (e.from !== null && e.to !== null && e.to > e.from) a.rerollsBetter++;
        break;
    }
  }
  if (bad) console.warn(`${MOD} | ${bad === 1 ? "1 event without the character it needs was" : `${bad} events without the character they need were`} left out of the totals`);
  for (const a of by.values()) {
    // A party character is shown under its name today
    if (a.k.startsWith("a:")) a.n = game.actors.get(a.k.slice(2))?.name ?? a.n;
    const sv = Object.values(a.saves);
    a.saveN = sv.reduce((x, s) => x + s[3], 0);
    a.savePass = sv.reduce((x, s) => x + s[1], 0);
    a.hitRate = a.atkKnown ? a.hit / a.atkKnown : -1;
    a.saveRate = a.saveN ? a.savePass / a.saveN : -1;
    a.spellN = Object.values(a.spells).reduce((x, s) => x + s.n, 0);
  }
  return by;
}


export { blank, weaponRow, aggregate };
