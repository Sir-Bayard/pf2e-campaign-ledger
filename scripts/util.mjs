import { L, MOD, OUTCOMES } from "./constants.mjs";

/* Small helpers: degrees of success, dice, dates, and who a creature is. */

function degree(outcome) {
  const i = OUTCOMES.indexOf(outcome);
  return i < 0 ? null : i;
}

function natD20(roll) {
  const die = roll?.dice?.find((d) => d.faces === 20);
  const r = die?.results?.find((r) => r.active && !r.discarded);
  return r?.result ?? null;
}

/** True when the d20 was rolled more than once and one kept (fortune or misfortune). */
function twice(roll) {
  const die = roll?.dice?.find((d) => d.faces === 20);
  return (die?.results?.length ?? 0) > 1 || undefined;
}

function pct(a, b) {
  return b ? `${Math.round((a / b) * 100)}%` : "–";
}

function fmtDate(t) {
  return t ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return "–";
  const m = Math.round(ms / 60000);
  return m < 60 ? L("Minutes", { m }) : L("HoursMinutes", { h: Math.floor(m / 60), m: String(m % 60).padStart(2, "0") });
}

function titleCase(s) {
  return String(s).replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function skillLabel(slug) {
  const c = CONFIG.PF2E?.skills?.[slug];
  if (c) return game.i18n.localize(c.label ?? c);
  if (slug === "perception") return L("Perception");
  if (slug === "initiative") return L("Initiative");
  return titleCase(slug);
}

/** A saving throw's name (fortitude, reflex, will) as the system shows it. */
function saveLabel(slug) {
  const c = CONFIG.PF2E?.saves?.[slug];
  return c ? game.i18n.localize(c.label ?? c) : titleCase(slug);
}

/**
 * How an actor is identified in the ledger. Party members by actor, everyone else by token name: the token on
 * the map, any token of theirs on any scene, or the prototype token. The actor's own name (the stat block) is
 * never used for them, so a stand-in's name can't reach the players. p is the side: PCs and allied NPCs
 * (alliance "party") are party, everyone else is a foe.
 */
function who(actor, tokenDoc = null) {
  if (!actor) return null;
  const base = actor.isToken ? (game.actors.get(actor.id) ?? actor) : actor;
  const inParty = game.actors.party?.members?.some((m) => m.id === base.id);
  if (actor.hasPlayerOwner || inParty) return { k: `a:${base.id}`, n: base.name, p: true };
  let name = tokenDoc?.name ?? actor.token?.name ?? actor.getActiveTokens?.(true, true)[0]?.name
    ?? actor.getDependentTokens?.({ linked: true })[0]?.name ?? actor.prototypeToken?.name;
  if (!name) {
    console.warn(MOD, `no token name for ${actor.name}; using the actor's name`);
    name = actor.name;
  }
  return { k: `n:${name}`, n: name, p: actor.alliance === "party" };
}

/**
 * A party row that isn't a player character (an actor of type "character"): a companion, familiar or summon, or an
 * NPC fighting on the party's side. Still counted with the party; shown in a group of its own. Worked out when shown, so older sessions
 * group the same way.
 */
function isAlly(row) {
  if (!row?.p) return false;
  if (!String(row.k).startsWith("a:")) return true;
  const actor = game.actors.get(row.k.slice(2));
  return !!actor && actor.type !== "character";
}

/** A persistent-damage roll: PF2e rolls it from the condition, with the creature itself as origin. */
function isPersistent(msg, flags) {
  const ctx = flags?.context ?? {};
  if (flags?.origin?.type === "condition") return true;
  if ((ctx.domains ?? []).some((d) => /persistent/.test(d))) return true;
  const roll = msg.rolls?.[0];
  if (roll?.options?.evaluatePersistent && (roll.instances ?? []).some((i) => i.persistent)) return true;
  if ((ctx.options ?? []).some((o) => /^(?:self:)?persistent-damage|damage:persistent|persistent-damage/.test(o))) return true;
  return /persistent damage/i.test(String(msg.flavor ?? "")) && !msg.item;
}

function actorFromUuid(uuid) {
  if (!uuid) return null;
  const d = fromUuidSync(uuid);
  if (!d) return null;
  return d.documentName === "Actor" ? d : (d.actor ?? null);
}


export { degree, natD20, twice, pct, fmtDate, fmtDuration, titleCase, skillLabel, saveLabel, who, isAlly, isPersistent, actorFromUuid };
