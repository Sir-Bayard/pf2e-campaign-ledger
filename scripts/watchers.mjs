import { MOD, now } from "./constants.mjs";
import { refreshOpenApps } from "./dashboard.mjs";
import { isRecorder, recording } from "./lead.mjs";
import { Rec, attribution, changeSrc, claimEvent, hashOf, heroReroll, hpSnap, onDamageReverted, record, recordAbility, resSnap, saveSource, watchUndo } from "./recorder.mjs";
import { activeSession } from "./sessions.mjs";
import { Store } from "./store.mjs";
import { actorFromUuid, degree, who } from "./util.mjs";

/* Recording from changes to documents: Target Helper saves, HP and resources, conditions, quests and combat. */

/**
 * Saves rolled through PF2e Toolbelt's Target Helper don't post their own message. Toolbelt writes
 * them into the spell or damage card's flags instead, so they're picked up here. Each save is keyed
 * to its card and token, so a reroll updates the earlier result instead of counting twice.
 */
async function onUpdateChatMessage(msg, changes) {
  if (!recording() || !(await isRecorder())) return;
  if (changes.flags?.pf2e?.appliedDamage?.isReverted === true) return onDamageReverted(msg);

  const tagged = changes.flags?.[MOD]?.ability;
  if (tagged && !Rec.seen.has(`ability|${msg.id}`)) {
    Rec.seen.set(`ability|${msg.id}`, now());
    await recordAbility(msg.actor, msg.token, tagged, msg.id);
  }

  if (!changes.flags?.["pf2e-toolbelt"]?.targetHelper) return;
  const variants = msg.flags?.["pf2e-toolbelt"]?.targetHelper?.saveVariants ?? {};
  // A Target Helper update with no saves in it (targets picked, a card moved) isn't play to record
  if (!Object.values(variants).some((v) => Object.keys(v?.saves ?? {}).length)) return;
  const scene = game.scenes.get(msg.speaker?.scene) ?? canvas.scene;
  const s = await activeSession();
  if (!s) return;
  const data = await Store.load(s.id);
  const WINDOW = 10 * 60 * 1000;
  const COPY_WINDOW = 3 * 60 * 1000;
  const recent = (e) => now() - (e.t ?? 0) < WINDOW;
  const source = saveSource(msg);
  for (const v of Object.values(variants)) {
    for (const [tokenId, save] of Object.entries(v?.saves ?? {})) {
      const tok = scene?.tokens.get(tokenId);
      if (!tok?.actor) continue;
      const stat = save.statistic ?? v.statistic ?? null;
      // Toolbelt copies a spell card's saves onto its damage card. A copy is the same roll (Toolbelt keeps the roll's
      // JSON) for the same source and author, seen on another card within COPY_WINDOW, or on the same card at any
      // age. Two real saves are taken for one only if the same creature recasts the same spell on the same target
      // within that window.
      const key = `${tokenId}|${stat}|${hashOf(`${source.item}|${source.author}|${save.roll ?? `${save.die}|${save.value}`}`)}`;
      const oldKey = `${tokenId}|${stat}|${save.die}|${save.value}`; // the older key format, for saves recorded with it
      const has = (e, k) => e.src === k || e.alt?.includes(k);
      const onCard = (e) => e.m === msg.id || e.ms?.includes(msg.id);
      const known = (e) => e.k === "save" && ((has(e, key) && (onCard(e) || now() - (e.t ?? 0) < COPY_WINDOW)) || (!e.m && recent(e) && has(e, oldKey)));
      if (Rec.seen.has(`${msg.id}|${key}`)) continue;
      Rec.seen.set(`${msg.id}|${key}`, now());
      const seenBefore = data.events.find(known);
      if (seenBefore) {
        // A copy on another card: that card is remembered too, so a later update of it matches at any age.
        if (!onCard(seenBefore) && seenBefore.m) {
          (seenBefore.ms ??= []).push(msg.id);
          Store.scheduleSave(s.id);
        }
        continue;
      }
      const o = degree(save.success);
      const nat = save.die ?? null;
      const slot = `${msg.id}|${tokenId}|${stat}`;
      const earlier = Rec.thSlots.get(slot)?.key;
      Rec.thSlots.set(slot, { key, t: now() });
      // The slot remembers the exact earlier save; the prefix search is only for a reroll of a save seen before a reload
      const prev = (save.rerolled || earlier)
        ? data.events.findLast((e) => e.k === "save" && recent(e) && (earlier ? e.src === earlier || e.alt?.includes(earlier) : e.src?.startsWith(`${tokenId}|${stat}|`)))
        : null;
      if (prev) {
        const paid = heroReroll(prev.a);
        await record({ k: "reroll", a: prev.a, from: prev.o, to: o, hero: paid || save.rerolled === "hero", nat }, `${msg.id}|${key}`);
        prev.nat0 ??= prev.nat;
        (prev.alt ??= []).push(prev.src);
        prev.src = key;
        prev.o = o;
        prev.nat = nat;
        prev.rr = true;
        Store.scheduleSave(s.id);
      } else {
        // The card's speaker cast the spell or used the ability that forced the save.
        const caster = msg.actor && msg.actor.uuid !== tok.actor.uuid ? who(msg.actor, msg.token) : null;
        await record({ k: "save", a: who(tok.actor, tok), s: stat, o, nat, src: key, m: msg.id, ...(caster ? { by: caster } : {}) }, `${msg.id}|${key}`);
      }
    }
  }
}

async function onUpdateActor(actor, changes, options = {}, userId = null) {
  const prevHp = Rec.hp.get(actor.uuid);
  const prevRes = Rec.res.get(actor.uuid);
  const hp = hpSnap(actor);
  const res = resSnap(actor);
  Rec.hp.set(actor.uuid, hp);
  Rec.res.set(actor.uuid, res);
  const src = changeSrc(actor);
  if (!recording() || !(await isRecorder())) return;
  const w = who(actor);
  if (!w) return;

  // An undo from a card's Revert button isn't healing or damage: the revert takes back what the card recorded.
  if (prevHp && hp && changes.system?.attributes?.hp && options.damageUndo) watchUndo(actor, w, prevHp, hp, userId);
  if (prevHp && hp && changes.system?.attributes?.hp && !options.damageUndo) {
    // Only a change to HP itself counts. Temporary HP that went with it is part of the same hit (temp);
    // temporary HP cleared on its own (expired) isn't damage, and HP that rose with the maximum (a level,
    // a rest that raised it) isn't healing.
    const lostHp = prevHp.v - hp.v;
    const lostTemp = Math.max(0, prevHp.t - hp.t);
    const gained = hp.v - prevHp.v;
    const maxChanged = hp.m !== prevHp.m;
    // Kept briefly so the "takes X damage" card that follows can name the real attacker or healer. Dying recorded a
    // moment before an HP loss comes along with it.
    const before = Rec.recent.get(actor.uuid);
    const recent = { t: now(), evs: before?.dyingOnly && lostHp > 0 && now() - before.t <= 5000 ? [...before.evs] : [] };
    Rec.recent.set(actor.uuid, recent);
    const keep = (ev) => {
      if (!ev) return;
      recent.evs.push(ev);
      // The card came first (it claimed this change while its events were being recorded)
      if (recent.claim) claimEvent(recent.claim, ev);
    };
    if (lostHp > 0) keep(await record({ k: "taken", a: w, amt: lostHp + lostTemp, ...(lostTemp ? { temp: lostTemp } : {}), by: attribution(actor, Rec.lastHit) }, src));
    if (gained > 0 && !maxChanged) keep(await record({ k: "healed", a: w, amt: gained, by: attribution(actor, Rec.lastHeal) }, src));
    if (prevHp.v > 0 && hp.v <= 0) {
      const by = attribution(actor, Rec.lastHit);
      if (w.p) keep(await record({ k: "down", a: w, by }, src));
      else keep(await record({ k: "kill", a: by, v: w }, src));
    }
    if (prevHp.v <= 0 && hp.v > 0 && w.p && !maxChanged) keep(await record({ k: "up", a: w, by: attribution(actor, Rec.lastHeal) }, src));
  }

  if (prevRes && w.p) {
    if (prevRes.hero !== null && res.hero !== null && res.hero < prevRes.hero) {
      // Hero Points are spent one at a time on a reroll (PF2e takes the point, then posts the reroll), or all at once
      // to stabilize while dying. Any other decrease is a reset, recorded as lost and not counted.
      const n = prevRes.hero - res.hero;
      const last = Rec.lastReroll.get(w.k);
      const dying = actor.itemTypes?.condition?.some((c) => c.slug === "dying");
      if (n === 1 && last && now() - last < 10000) await record({ k: "hero", a: w, n }, src);
      else if (n > 1 && dying) await record({ k: "hero", a: w, n }, src);
      else {
        const ev = await record({ k: "hero", a: w, n, lost: true }, src);
        if (ev && n === 1) Rec.heroPending.set(w.k, { ev, t: now() });
      }
    }
    if (prevRes.focus !== null && res.focus !== null && res.focus < prevRes.focus) await record({ k: "focus", a: w, n: prevRes.focus - res.focus }, src);
  }
}

async function onDying(item, changes = null) {
  if (item.type !== "condition" || item.slug !== "dying") return;
  // An update that didn't change the value (a badge shown or hidden) isn't a new step toward dead
  if (changes && changes.system?.value?.value === undefined) return;
  const actor = item.actor;
  if (!actor?.hasPlayerOwner) return;
  const v = item.value ?? item.system?.value?.value ?? 1;
  // A new condition starts from 0; a value never seen (a reload while dying) counts as a step up
  const was = changes ? Rec.dying.get(actor.uuid) : 0;
  Rec.dying.set(actor.uuid, v);
  const src = changeSrc(item);
  if (!recording() || !(await isRecorder())) return;
  // Dying that went down (a successful recovery check) isn't a step toward dead
  if (was !== undefined && v <= was) return;
  const evs = [await record({ k: "dying", a: who(actor), v }, src)];
  const max = actor.system?.attributes?.dying?.max ?? 4;
  if (v >= max && !(await alreadyDead(who(actor)))) evs.push(await record({ k: "dead", a: who(actor) }, src));
  tagToCard(actor, evs.filter(Boolean));
}

/**
 * Campaign Trackers' quests as they stand: per quest, whether it's revealed and each objective's and step's state, with
 * whether players can see it. Null when the module isn't there.
 */
function questState() {
  const mod = game.modules.get("pf2e-campaign-trackers");
  if (!mod?.active || typeof mod.api?.list !== "function") return null;
  const quests = new Map();
  for (const q of mod.api.list() ?? []) {
    if (q?.kind !== "quest" || !q.id) continue;
    const goals = new Map();
    for (const o of q.objectives ?? []) {
      if (o?.id) goals.set(o.id, { state: o.state, shown: !!o.revealed });
      for (const st of o?.steps ?? []) if (st?.id) goals.set(st.id, { state: st.state, shown: !!o.revealed && !!st.revealed });
    }
    quests.set(q.id, { name: q.name ?? "", revealed: !!q.revealed, goals });
  }
  return quests;
}
let questSnap = null;
/** The GM's first look at the quests, which the first change is compared with. */
function primeQuests(again = true) {
  if (game.user.isGM && (again || !questSnap)) questSnap = questState();
}

/**
 * Trackers changed: a quest revealed, or an objective or step players can see marked done or failed, goes into the
 * running session (Trackers keeps no time for these). Unmarked again, it comes back out. A quest that's new to this
 * client (created, imported) isn't news.
 */
async function onTrackersChanged() {
  if (!game.user.isGM) return;
  const before = questSnap;
  const after = questState();
  questSnap = after;
  if (!before || !after || !recording() || !(await isRecorder())) return;
  const s = await activeSession({ create: false });
  if (!s) return;
  for (const [qid, q] of after) {
    const was = before.get(qid);
    if (!was) continue;
    if (q.revealed && !was.revealed) await record({ k: "quest", q: q.name, qid }, `quest|${qid}`);
    if (!q.revealed) continue;
    for (const [gid, g] of q.goals) {
      const old = was.goals.get(gid);
      if (!old || old.state === g.state) continue;
      // Done then failed (or back to open): what was recorded for it goes, and the new state is recorded if it counts
      await takeBackGoal(s.id, gid);
      if ((g.state === "done" || g.state === "failed") && g.shown) await record({ k: "goal", q: q.name, qid, gid, v: g.state }, `goal|${gid}|${g.state}`);
    }
  }
}

/** An objective or step whose state changed: what the running session recorded for it goes. */
async function takeBackGoal(sid, gid) {
  const data = await Store.load(sid);
  const gone = data.events.filter((e) => e.k === "goal" && e.gid === gid);
  if (!gone.length) return;
  data.events = data.events.filter((e) => !gone.includes(e));
  Store.drop(sid, gone);
  Store.scheduleSave(sid);
  refreshOpenApps();
}

/** Dead in the running session and not back up since, so a second sign of the same death isn't counted again. */
async function alreadyDead(w) {
  const s = await activeSession({ create: false });
  if (!s || !w) return false;
  const data = await Store.load(s.id);
  return data.events.findLast((e) => e.a?.k === w.k && (e.k === "dead" || e.k === "up"))?.k === "dead";
}

/**
 * A party member marked dead (Foundry's dead status, from the token or the combat tracker) without Dying reaching its
 * maximum: a death effect, or the GM's ruling.
 */
async function onDeadStatus(effect) {
  if (!effect?.statuses?.has?.("dead")) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor" || !recording() || !(await isRecorder())) return;
  const w = who(actor);
  if (!w?.p || (await alreadyDead(w))) return;
  const ev = await record({ k: "dead", a: w }, effect.uuid);
  if (ev) tagToCard(actor, [ev]);
}

/**
 * Dying and dead that follow a damage card within a few seconds belong to that card, so its Revert takes them back
 * too. Before the card has come, they wait with the HP change it will claim (or on their own, when HP didn't move).
 */
function tagToCard(actor, evs) {
  if (!evs.length) return;
  const recent = Rec.recent.get(actor.uuid);
  if (recent && now() - recent.t <= 5000) {
    recent.evs.push(...evs);
    return;
  }
  const card = Rec.lastCard.get(actor.uuid);
  if (card && now() - card.t <= 5000) {
    for (const ev of evs) ev.m ??= card.m;
    return;
  }
  Rec.recent.set(actor.uuid, { t: now(), evs, dyingOnly: true });
}

/**
 * Persistent damage put on by an effect (a spell's lingering effect, an aura) rather than a damage roll: when no roll
 * named a source for that damage type, the creature the granting effect came from is the source.
 */
function onPersistentGranted(item) {
  if (item?.type !== "condition" || item.slug !== "persistent-damage" || !item.actor) return;
  const type = item.system?.persistent?.damageType;
  if (!type || Rec.pdSource.has(`${item.actor.uuid}|${type}`)) return;
  const grantedBy = item.flags?.pf2e?.grantedBy?.id;
  const effect = grantedBy ? item.actor.items.get(grantedBy) : null;
  const originUuid = effect?.system?.context?.origin?.actor ?? effect?.origin?.uuid ?? null;
  const origin = originUuid ? actorFromUuid(originUuid) : null;
  if (!origin || origin.uuid === item.actor.uuid) return;
  const w = who(origin);
  if (w) Rec.pdSource.set(`${item.actor.uuid}|${type}`, { w, t: now() });
}

/** The condition went: the next Dying starts from 0, and the persistent damage it was no longer has a source. */
function onDeleteItem(item) {
  if (item.type !== "condition" || !item.actor) return;
  if (item.slug === "dying") Rec.dying.delete(item.actor.uuid);
  if (item.slug === "persistent-damage") {
    const left = item.actor.itemTypes?.condition?.some((c) => c.slug === "persistent-damage" && c.id !== item.id);
    Rec.dropPersistent(item.actor.uuid, left ? item.system?.persistent?.damageType ?? null : null);
  }
}

/** A combatant's HP as it is now, so the first change to a creature on a scene the GM isn't viewing is seen. */
function snapCombatant(c) {
  const a = c?.actor;
  if (!a || Rec.hp.has(a.uuid)) return;
  Rec.hp.set(a.uuid, hpSnap(a));
  Rec.res.set(a.uuid, resSnap(a));
}

async function findEncounter(id) {
  const s = await activeSession({ create: false });
  if (!s) return null;
  const data = await Store.load(s.id);
  return { data, enc: data.encounters.find((e) => e.id === id), sid: s.id };
}

async function onCombatStart(combat) {
  for (const c of combat.combatants) snapCombatant(c);
  if (!recording() || !(await isRecorder())) return;
  const s = await activeSession();
  if (!s) return;
  const data = await Store.load(s.id);
  Rec.encounter = combat.id;
  if (!data.encounters.find((e) => e.id === combat.id)) {
    data.encounters.push({
      id: combat.id,
      // The navigation name is the one players see; the GM can rename the encounter from the Encounters tab (name)
      scene: combat.scene?.navName || combat.scene?.name || "",
      start: now(),
      end: null,
      rounds: 1,
    });
  }
  Store.scheduleSave(s.id);
  refreshOpenApps();
}

async function onUpdateCombat(combat, changes) {
  if (changes.round === undefined || !recording() || !(await isRecorder())) return;
  const f = await findEncounter(combat.id);
  if (!f?.enc) return;
  f.enc.rounds = Math.max(f.enc.rounds, combat.round);
  Store.scheduleSave(f.sid);
  // The end of a round is a good moment to save
  Store.saveSoon().catch((e) => console.error(MOD, e));
}

/** A creature joining a fight: its HP as it comes in, so its first change counts from there. */
function onCreateCombatant(combatant) {
  snapCombatant(combatant);
}

async function onDeleteCombat(combat) {
  // Closes the encounter even with recording paused, so a pause mid-fight doesn't leave it open.
  if (!(await isRecorder())) return;
  // Persistent damage from this fight no longer has a source
  for (const c of combat.combatants) if (c.actor) Rec.dropPersistent(c.actor.uuid);
  const f = await findEncounter(combat.id);
  if (Rec.encounter === combat.id) Rec.encounter = null;
  if (!f?.enc) return;
  f.enc.end = now();
  f.enc.rounds = Math.max(f.enc.rounds, combat.round ?? 1);
  Store.scheduleSave(f.sid);
  Store.saveSoon().catch((e) => console.error(MOD, e));
  refreshOpenApps();
}


export { onUpdateChatMessage, onUpdateActor, onDying, questState, questSnap, primeQuests, onTrackersChanged, takeBackGoal, alreadyDead, onDeadStatus, tagToCard, onPersistentGranted, onDeleteItem, snapCombatant, findEncounter, onCombatStart, onUpdateCombat, onCreateCombatant, onDeleteCombat };
