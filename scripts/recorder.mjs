import { ATTRIBUTION_WINDOW, MOD, SAVES, now } from "./constants.mjs";
import { refreshOpenApps } from "./dashboard.mjs";
import { isRecorder, recording } from "./lead.mjs";
import { activeSession } from "./sessions.mjs";
import { Store } from "./store.mjs";
import { actorFromUuid, degree, isPersistent, natD20, twice, who } from "./util.mjs";

/* Recording from chat cards: rolls, damage and healing applied, and a card's Revert. */

const Rec = {
  encounter: null,
  hp: new Map(),
  res: new Map(),
  lastHit: new Map(),
  lastHeal: new Map(),
  lastCheck: new Map(),
  lastAbility: new Map(),
  recent: new Map(),
  pdSource: new Map(), // "<target uuid>|<damage type>" -> { w, t }: who put that persistent damage on them
  pdTick: new Map(),   // target uuid -> { by, t } from the last persistent-damage roll
  seen: new Map(),     // message keys already handled -> when
  thSlots: new Map(),  // "<message>|<token>|<save>" -> { key, t }: the save last seen in that slot
  lastReroll: new Map(),  // who.k -> time of their last reroll message
  heroPending: new Map(), // who.k -> { ev, t }: a Hero Point that went down with no reroll yet
  lastCard: new Map(),    // target uuid -> { m, t }: the last damage card on them
  dying: new Map(),       // actor uuid -> their Dying value as last seen
  undos: new Set(),       // a player's Revert waiting for its card to be marked (see watchUndo)
  reverted: new Map(),    // "<actor uuid>|<amount>" -> when a card for that much on them was last marked reverted
  revertAsks: new Map(),  // card id -> { user, t }: a player's client saying which card its Revert was for
  idSeq: new Map(),       // an event's source key -> { n, t }: how many events that key has given (see eventId)
  lastMod: new Map(),     // document uuid -> the change time last seen on it (see changeSrc)

  /**
   * Forget what was remembered up to `before` (a session's end), keeping anything newer. Cards already seen are kept
   * one session longer: a Target Helper card from the session that just ended can still change, and its saves mustn't
   * be counted again.
   */
  seenCut: -Infinity,
  forget(before) {
    const old = (t) => !(t > before);
    for (const map of [this.lastHit, this.lastHeal, this.lastCheck, this.recent, this.pdSource, this.pdTick, this.thSlots, this.heroPending, this.lastCard, this.revertAsks, this.idSeq]) {
      for (const [k, v] of map) if (old(v?.t)) map.delete(k);
    }
    for (const map of [this.lastAbility, this.lastReroll, this.reverted]) for (const [k, t] of map) if (old(t)) map.delete(k);
    // Forgetting the same session twice (the lead's own index write, then End session) moves the cut once
    if (before > this.seenCut) {
      for (const [k, t] of this.seen) if (!(t > this.seenCut)) this.seen.delete(k);
      this.seenCut = before;
    }
  },

  /** A target's persistent damage sources: one damage type, or all of them. */
  dropPersistent(uuid, type = null) {
    for (const k of this.pdSource.keys()) if (type ? k === `${uuid}|${type}` : k.startsWith(`${uuid}|`)) this.pdSource.delete(k);
  },
};

/**
 * An event's id from what caused it (`src`: a chat message, an actor update at its server time, an item), so two GM
 * tabs that both recorded the same hook (one was busy while the other took over) give it the same id and the files
 * merge it once. The nth event with the same source, kind and people gets n in its key. No source: a random id.
 */
function eventId(src, evt, taken = null) {
  if (!src) return foundry.utils.randomID(8);
  const base = `${src}|${evt.k}|${evt.a?.k ?? ""}|${evt.tg?.k ?? evt.v?.k ?? ""}`;
  // An id the session took back (a Revert, an objective unmarked) is never given again (the count starts over after a reload)
  let n = Rec.idSeq.get(base)?.n ?? 0;
  let id;
  do {
    n++;
    const key = `${base}|${n}`;
    id = `e${hashOf(key)}${hashOf(`~${key}`)}`;
  } while (taken?.has(id));
  Rec.idSeq.set(base, { n, t: now() });
  return id;
}

/**
 * A document's change as a source for eventId: its uuid at the server's time for that change. Read at once in the hook,
 * before any wait. Null for an unlinked token's actor or item (they carry the base actor's time) and when the time
 * didn't move since the last change seen on it, so that change gets a random id.
 */
function changeSrc(doc) {
  const t = doc?._stats?.modifiedTime;
  if (!doc?.uuid || !t || doc.isToken || doc.actor?.isToken) return null;
  const moved = Rec.lastMod.get(doc.uuid) !== t;
  Rec.lastMod.set(doc.uuid, t);
  return moved ? `${doc.uuid}@${t}` : null;
}

async function record(evt, src = null) {
  if (!recording() || !(await isRecorder())) return null;
  const s = await activeSession();
  if (!s) return null;
  const data = await Store.load(s.id);
  if (!evt.id && src) {
    const taken = new Set([...(Array.isArray(data.dropped) ? data.dropped : []), ...(Store.dropped.get(s.id) ?? [])]);
    evt.id = eventId(src, evt, taken);
    // The same change, already recorded by this GM's other tab or before a reload, is kept once (and later steps,
    // such as a reroll, go on from that copy)
    const had = data.events.find((e) => e.id === evt.id);
    if (had) return had;
  }
  evt.id ??= foundry.utils.randomID(8);
  evt.t ??= now();
  const combat = Rec.encounter ? game.combats.get(Rec.encounter) : null;
  if (combat?.started) {
    evt.e = Rec.encounter;
    evt.r = combat.round;
  }
  data.events.push(evt);
  Store.scheduleSave(s.id);
  refreshOpenApps();
  return evt;
}

/**
 * A reroll message from a character. A Hero Point that went down just before it (PF2e takes the point, then
 * posts the reroll) was spent on it; one that came down with no reroll within 10 seconds stays "lost" (a
 * reset by the GM or by Workbench's Hero Point Handler) and isn't counted as spent. Returns true when the
 * reroll paid with a Hero Point.
 */
function heroReroll(w) {
  if (!w?.k) return false;
  Rec.lastReroll.set(w.k, now());
  const pend = Rec.heroPending.get(w.k);
  if (!pend) return false;
  Rec.heroPending.delete(w.k);
  if (now() - pend.t > 10000) return false;
  delete pend.ev.lost;
  return true;
}

/**
 * The { item, author } uuids behind a Target Helper card, the same on a spell card and on the damage card Toolbelt
 * copies its saves to. Toolbelt's flags can be empty (both on a spell card, the author on a damage card), so the
 * card's spell (or a scroll's or wand's embedded spell) and its speaker fill in.
 */
function saveSource(msg) {
  const th = msg.flags?.["pf2e-toolbelt"]?.targetHelper ?? {};
  let spell = null;
  try {
    const it = msg.item;
    spell = it?.isOfType?.("spell") ? it : it?.isOfType?.("consumable") ? it.embeddedSpell : null;
  } catch (e) {
    spell = null;
  }
  return { item: th.item ?? spell?.uuid ?? "", author: th.author ?? msg.actor?.uuid ?? "" };
}

/** A short, stable hash of a string (FNV-1a), to keep save keys small. */
function hashOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * Who gets the credit for a change to a creature's HP: the last one to hit (or heal) it within the window, else
 * whoever's turn it is, but only from the other side for damage and the same side for healing. Otherwise nobody:
 * unattributed is better than wrong in a window players read.
 */
function attribution(actor, map) {
  const entry = map.get(actor.uuid);
  if (entry && now() - entry.t < ATTRIBUTION_WINDOW) return entry.w;
  const c = game.combat?.combatant;
  if (!c?.actor || c.actor.uuid === actor.uuid) return null;
  const by = who(c.actor, c.token);
  const v = who(actor);
  if (!by || !v) return null;
  const heal = map === Rec.lastHeal;
  return (heal ? by.p === v.p : by.p !== v.p) ? by : null;
}

function hpSnap(actor) {
  const hp = actor?.system?.attributes?.hp;
  if (!hp) return null;
  return { v: Number(hp.value ?? 0), t: Number(hp.temp ?? 0), m: Number(hp.max ?? 0) };
}

function resSnap(actor) {
  const r = actor?.system?.resources;
  return { hero: r?.heroPoints?.value ?? null, focus: r?.focus?.value ?? null };
}

function primeCaches() {
  const actors = [...game.actors, ...(canvas.scene?.tokens ?? []).map((t) => t.actor).filter(Boolean)];
  for (const a of actors) {
    Rec.hp.set(a.uuid, hpSnap(a));
    Rec.res.set(a.uuid, resSnap(a));
    const dying = a.itemTypes?.condition?.find((c) => c.slug === "dying");
    if (dying) Rec.dying.set(a.uuid, dying.value ?? dying.system?.value?.value ?? 1);
  }
}

/**
 * Ability use. Recorded from action and feat cards posted to chat, and from any message carrying
 * flags["pf2e-campaign-ledger"].ability = "<name>" (for macros that post their own message).
 * The same character using the same ability twice within 5 seconds counts once, so a macro that
 * also posts the ability card isn't counted double.
 */
async function recordAbility(actor, tokenDoc, name, src = null) {
  if (!actor || !name) return;
  const w = who(actor, tokenDoc);
  const key = `${w.k}|${name}`;
  const last = Rec.lastAbility.get(key);
  if (last && now() - last < 5000) return;
  Rec.lastAbility.set(key, now());
  await record({ k: "ability", a: w, it: name }, src);
}

async function onChatMessage(msg) {
  if (!recording() || !(await isRecorder())) return;
  const tagged = msg.flags?.[MOD]?.ability;
  if (tagged) {
    Rec.seen.set(`ability|${msg.id}`, now());
    return recordAbility(msg.actor, msg.token, tagged, msg.id);
  }
  const flags = msg.flags?.pf2e;
  const actor = msg.actor;
  if (!flags || !actor) return;
  const ctx = flags.context;
  const type = ctx?.type;
  const w = who(actor, msg.token);
  const roll = msg.rolls?.[0];

  // A reroll replaces the earlier check: record the change and update the earlier event.
  if (ctx?.isReroll) {
    const key = `${w.k}|${type}`;
    const prev = Rec.lastCheck.get(key);
    const to = degree(ctx.outcome);
    const paid = heroReroll(w);
    const hero = paid || (ctx.options ?? []).includes("check:reroll:hero-points");
    await record({ k: "reroll", a: w, from: prev?.o ?? null, to, hero, nat: natD20(roll), fx: twice(roll) }, msg.id);
    // A miss turned into a hit makes the attacker the last to hit the target; a hit turned into a miss undoes that
    const tActor = type === "attack-roll" || type === "spell-attack-roll" ? actorFromUuid(ctx.target?.actor) : null;
    if (tActor) {
      if (to === null || to >= 2) Rec.lastHit.set(tActor.uuid, { w, t: now() });
      else if (Rec.lastHit.get(tActor.uuid)?.w?.k === w.k) Rec.lastHit.delete(tActor.uuid);
    }
    if (prev) {
      prev.nat0 ??= prev.nat;
      prev.o = to;
      prev.nat = natD20(roll);
      prev.rr = true;
    }
    return;
  }

  if (type === "attack-roll" || type === "spell-attack-roll") {
    const tActor = actorFromUuid(ctx.target?.actor);
    const tTok = ctx.target?.token ? fromUuidSync(ctx.target.token) : null;
    const tw = tActor ? who(tActor, tTok) : null;
    const o = degree(ctx.outcome);
    // Only a hit counts as the last hit on the target (a miss shouldn't take the credit for hand-applied damage)
    if (tActor && (o === null || o >= 2)) Rec.lastHit.set(tActor.uuid, { w, t: now() });
    const ev = await record({ k: "atk", a: w, tg: tw, o, nat: natD20(roll), fx: twice(roll), it: msg.item?.name ?? null }, msg.id);
    if (ev) Rec.lastCheck.set(`${w.k}|${type}`, ev);
    return;
  }

  if (type === "saving-throw") {
    const s = ctx.statistic ?? (ctx.domains ?? []).find((d) => SAVES.includes(d));
    // The creature whose spell or ability forced the save, when PF2e says (saves rolled from a card).
    const src = actorFromUuid(ctx.origin?.actor ?? null);
    const by = src && src.uuid !== actor.uuid ? who(src) : null;
    const ev = await record({ k: "save", a: w, s, o: degree(ctx.outcome), nat: natD20(roll), fx: twice(roll), ...(by ? { by } : {}) }, msg.id);
    if (ev) Rec.lastCheck.set(`${w.k}|${type}`, ev);
    return;
  }

  if (type === "skill-check" || type === "perception-check" || type === "initiative") {
    let s = type === "perception-check" ? "perception" : type === "initiative" ? "initiative" : ctx.statistic;
    if (!s || s === "skill-check") s = (ctx.domains ?? []).find((d) => CONFIG.PF2E?.skills?.[d] || d.endsWith("-lore")) ?? "skill";
    const ev = await record({ k: "skill", a: w, s, o: degree(ctx.outcome), nat: natD20(roll), fx: twice(roll) }, msg.id);
    if (ev) Rec.lastCheck.set(`${w.k}|${type}`, ev);
    return;
  }

  // PF2e's own recovery check uses "dying-recovery-check"; some macros use "dying-recovery".
  if (type === "flat-check" && (ctx.domains ?? []).some((d) => d.startsWith("dying-recovery"))) {
    const ev = await record({ k: "rec", a: w, o: degree(ctx.outcome), nat: natD20(roll), fx: twice(roll) }, msg.id);
    if (ev) Rec.lastCheck.set(`${w.k}|${type}`, ev);
    return;
  }

  if (type === "damage-taken") return onDamageApplied(msg, flags);

  if (type === "damage-roll" || msg.isDamageRoll) {
    if (!roll) return;
    const kinds = roll.kinds ?? new Set();
    const heal = kinds.has?.("healing") && !kinds.has?.("damage");
    const tActor = actorFromUuid(ctx?.target?.actor);
    const tTok = ctx?.target?.token ? fromUuidSync(ctx.target.token) : null;
    // Persistent damage is rolled by the creature taking it. It belongs to whoever put that damage type on
    // them (an acid flask's acid, a spell's fire): each persistent instance of a damage roll remembers its
    // roller by target and type. Failing that, whoever last hit them within the attribution window.
    const persistent = isPersistent(msg, flags);
    const types = [...new Set((roll.instances ?? []).map((i) => i.type).filter(Boolean))];
    let by = w;
    if (persistent) {
      const last = Rec.lastHit.get(actor.uuid);
      const src = types.map((t) => Rec.pdSource.get(`${actor.uuid}|${t}`)?.w).find((x) => x && x.k !== w.k) ?? (last && now() - last.t < ATTRIBUTION_WINDOW ? last.w : null);
      if (src && src.k !== w.k) by = src;
      Rec.pdTick.set(actor.uuid, { by, t: now() });
    } else if (tActor) {
      (heal ? Rec.lastHeal : Rec.lastHit).set(tActor.uuid, { w, t: now() });
      for (const inst of roll.instances ?? []) if (inst.persistent && inst.type) Rec.pdSource.set(`${tActor.uuid}|${inst.type}`, { w, t: now() });
    }
    await record({ k: heal ? "heal" : "dmg", a: by, amt: Number(roll.total) || 0, it: persistent ? `persistent ${types.join("/") || "damage"}` : (msg.item?.name ?? null), tg: persistent ? w : tActor ? who(tActor, tTok) : null, ...(persistent ? { pd: true } : {}) }, msg.id);
    return;
  }

  if (type === "spell-cast" || (!ctx && flags.origin?.type === "spell")) {
    const item = msg.item;
    await record({ k: "spell", a: w, it: item?.name ?? "Spell", rk: item?.rank ?? null, fo: !!item?.isFocusSpell, ca: !!item?.isCantrip }, msg.id);
    return;
  }

  if ((!type || type === "self-effect") && ["action", "feat"].includes(flags.origin?.type)) {
    await recordAbility(actor, msg.token, msg.item?.name ?? null, msg.id);
  }
}

/**
 * Damage and healing as applied. PF2e posts a "takes X damage" or "is healed" card when damage is
 * applied from a roll, naming the target, the source actor and the HP and temporary HP that changed.
 * That gives the true amount after resistances and shields (overkill isn't counted), and the real
 * attacker, which also corrects who gets credit for a kill or a revive recorded a moment earlier.
 */
async function onDamageApplied(msg, flags) {
  const applied = flags.appliedDamage;
  if (!applied || applied.isReverted) return;
  const target = msg.actor;
  const src = actorFromUuid(flags.origin?.actor);
  if (!target) return;
  // The HP change recorded a moment ago belongs to this card only if the card changed HP (a card can be all shield
  // or only persistent damage), and to one card only.
  const hpPath = (applied.updates ?? []).some((u) => u.path === "system.attributes.hp.value" || u.path === "system.attributes.hp.temp");
  // Dying recorded just before a damage card (with no HP change of its own) is the card's too; a heal never claims it
  let recent = Rec.recent.get(target.uuid) ?? null;
  if (recent && (now() - recent.t > 5000 || !(hpPath || recent.dyingOnly) || (recent.dyingOnly && applied.isHealing))) recent = null;
  if (recent) Rec.recent.delete(target.uuid);
  // Dying or dead that comes just after a card that hurt (or hit a creature already at 0 HP) is tagged with it (tagToCard)
  if (!applied.isHealing && (hpPath || recent || (target.system?.attributes?.hp?.value ?? 1) <= 0)) Rec.lastCard.set(target.uuid, { m: msg.id, t: now() });
  if (!src) {
    // No source on the card: nothing to credit, but what it changed is still the card's, for its Revert button.
    if (recent) claimRecent(recent, { m: msg.id, a: null, heal: !!applied.isHealing });
    return;
  }
  const amt = (applied.updates ?? [])
    .filter((u) => u.path === "system.attributes.hp.value" || u.path === "system.attributes.hp.temp")
    .reduce((x, u) => x + Math.abs(Number(u.value) || 0), 0);
  const heal = !!applied.isHealing;
  let a = who(src);
  const tg = who(target, msg.token);
  const item = flags.origin?.uuid ? fromUuidSync(flags.origin.uuid) : null;
  // Damage the creature did to itself (persistent damage, a backfiring ability) goes to the persistent tick it just
  // rolled (within 15 seconds), else to whoever last hit it within the attribution window; otherwise it stays its own.
  let pd = false;
  if (!heal && a.k === tg.k) {
    const tick = Rec.pdTick.get(target.uuid);
    const last = Rec.lastHit.get(target.uuid);
    const src = tick && now() - tick.t <= 15000 ? tick.by : last && now() - last.t < ATTRIBUTION_WINDOW ? last.w : null;
    // With nobody to credit it's unattributed, not the creature's own damage dealt (or friendly fire)
    if (src && src.k !== a.k) {
      a = src;
      pd = true;
    } else a = null;
  }
  // Each event this card accounts for carries its message id (m), so the card's Revert button can take them back. The
  // claim comes first: the HP change's own events may still be on their way.
  if (recent) claimRecent(recent, { m: msg.id, a, heal });
  if (amt > 0) await record({ k: heal ? "healdone" : "dealt", a, tg, amt, it: pd ? "persistent damage" : (item?.name ?? null), ...(pd ? { pd: true } : {}), m: msg.id }, msg.id);
}

/**
 * A card's claim on an HP change recorded a moment before it: its id on each event (for its Revert), and the real
 * attacker or healer. Events of that change still being recorded take the claim as they arrive (see onUpdateActor).
 */
function claimRecent(recent, claim) {
  recent.claim = claim;
  for (const ev of recent.evs) claimEvent(claim, ev);
  const s = Store.index.active;
  if (s) Store.scheduleSave(s);
}

function claimEvent(claim, ev) {
  ev.m ??= claim.m;
  if (!claim.a) return;
  if (!claim.heal && (ev.k === "taken" || ev.k === "down")) ev.by = claim.a;
  if (!claim.heal && ev.k === "kill") ev.a = claim.a;
  if (claim.heal && (ev.k === "healed" || ev.k === "up")) ev.by = claim.a;
}

/**
 * PF2e's Revert button on a "takes X damage" or "is healed" card puts the HP back (an actor update marked
 * damageUndo, which onUpdateActor leaves alone) and then marks the card reverted. Everything recorded for that
 * card goes: the damage or healing dealt, the damage or healing taken, and a kill, down or revive it caused.
 */
async function onDamageReverted(msg) {
  const applied = msg.flags?.pf2e?.appliedDamage;
  const uuid = applied?.uuid ?? msg.actor?.uuid;
  const amt = (applied?.updates ?? []).filter((u) => u.path === "system.attributes.hp.value" || u.path === "system.attributes.hp.temp").reduce((x, u) => x + Math.abs(Number(u.value) || 0), 0);
  if (uuid) Rec.reverted.set(`${uuid}|${amt}`, now());
  const s = await activeSession({ create: false });
  if (!s) return;
  const data = await Store.load(s.id);
  const gone = data.events.filter((e) => e.m === msg.id);
  if (!gone.length) return;
  data.events = data.events.filter((e) => e.m !== msg.id);
  Store.drop(s.id, gone);
  Store.scheduleSave(s.id);
  refreshOpenApps();
}

/**
 * PF2e's Revert puts HP back, then marks its card reverted, which takes back what the card recorded. A player can
 * only mark a card they posted, so after a player's Revert of anyone else's card the mark never comes. The player's
 * client says which card was clicked (see the Revert listener at ready); if no mark has come 3 seconds after the HP
 * came back, that card is taken back. A client that didn't say (an older version) gets the newest card on this
 * creature for the same amount. A GM's Revert always marks its card.
 */
function watchUndo(actor, w, prevHp, hp, userId) {
  if (!w || game.users.get(userId)?.isGM) return;
  const change = hp.v + hp.t - (prevHp.v + prevHp.t);
  if (!change) return;
  const max = actor.system?.attributes?.hp?.max;
  const undo = { actor: actor.uuid, k: w.k, amt: Math.abs(change), heal: change < 0, atMax: change > 0 && hp.v >= max, user: userId, t: now() };
  Rec.undos.add(undo);
  setTimeout(() => {
    Rec.undos.delete(undo);
    takeBackCard(undo).catch((e) => console.error(MOD, e));
  }, 3000);
}

async function takeBackCard(undo) {
  const ix = Store.index;
  const s = ix.sessions.find((x) => x.id === ix.active);
  // A card from the session that just ended keeps its Revert button too
  const prev = [...ix.sessions].filter((x) => x.end).sort((a, b) => b.end - a.end)[0];
  const asked = [...Rec.revertAsks].filter(([, a]) => a.user === undo.user && Math.abs(a.t - undo.t) <= 5000).map(([m]) => m);
  const about = (e) => e.a?.k === undo.k || e.tg?.k === undo.k;
  for (const sess of [s, prev]) {
    if (!sess) continue;
    const data = await Store.load(sess.id);
    let card = null;
    if (asked.length) {
      // The card the player clicked; gone already means it was marked (a player who posted it)
      card = asked.find((m) => data.events.some((e) => e.m === m && about(e))) ?? null;
    } else if (sess === s) {
      // No word from the player's client: a mark for this amount just now means it was marked
      if ((Rec.reverted.get(`${undo.actor}|${undo.amt}`) ?? -Infinity) >= undo.t - 3000) return;
      const [dealt, took] = undo.heal ? ["healdone", "healed"] : ["dealt", "taken"];
      const line = (e) => e.m && e.t > undo.t - 30 * 60000 && ((e.k === dealt && e.tg?.k === undo.k) || (e.k === took && e.a?.k === undo.k));
      // HP clamped at its maximum came back short of the card's amount
      card = data.events.findLast((e) => line(e) && e.amt === undo.amt)?.m ?? (undo.atMax ? data.events.findLast((e) => line(e) && e.amt > undo.amt)?.m : null) ?? null;
    }
    if (!card) continue;
    Store.drop(sess.id, data.events.filter((e) => e.m === card));
    data.events = data.events.filter((e) => e.m !== card);
    Store.scheduleSave(sess.id);
    refreshOpenApps();
    return;
  }
}


export { Rec, eventId, changeSrc, record, heroReroll, saveSource, hashOf, attribution, hpSnap, resSnap, primeCaches, recordAbility, onChatMessage, onDamageApplied, claimRecent, claimEvent, onDamageReverted, watchUndo, takeBackCard };
