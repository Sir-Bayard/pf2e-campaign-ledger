/**
 * PF2e Campaign Ledger
 * Long-term table statistics for Pathfinder 2e, grouped by session, arc and encounter.
 *
 * Recording runs on the active GM's client only. Each session's events are kept in a JSON file in
 * worlds/<world>/pf2e-campaign-ledger/, and the list of sessions and arcs lives in a world setting.
 * Enemies are recorded by token name only, which players can already see on the map.
 * Archived chat goes into its own files there too, listed on a GM-only journal entry (see "Chat archive").
 */

const MOD = "pf2e-campaign-ledger";
const OUTCOMES = ["criticalFailure", "failure", "success", "criticalSuccess"];
const SAVES = ["fortitude", "reflex", "will"];
const ATTRIBUTION_WINDOW = 60 * 1000;

/* ------------------------------------------------------------------ */
/* Utilities                                                          */
/* ------------------------------------------------------------------ */

const FP = () => foundry.applications.apps.FilePicker.implementation;
const now = () => Date.now();
const uid = () => foundry.utils.randomID(10);
const fileDir = () => `worlds/${game.world.id}/${MOD}`;
const isRecorder = () => game.user.isGM && game.users.activeGM?.id === game.user.id;
const recording = () => game.settings.get(MOD, "recording");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

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
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

function titleCase(s) {
  return String(s).replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function skillLabel(slug) {
  const c = CONFIG.PF2E?.skills?.[slug];
  if (c) return game.i18n.localize(c.label ?? c);
  return titleCase(slug);
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

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_INDEX = { version: 1, arcs: [], sessions: [], active: null, currentArc: null, updated: 0 };

const Store = {
  cache: new Map(),
  timer: null,
  dirReady: false,
  rev: 0, // bumped whenever the data the dashboard shows may have changed; open windows re-render only when it moved

  get index() {
    return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_INDEX), game.settings.get(MOD, "index") ?? {});
  },

  async setIndex(ix) {
    return this.mutateIndex(() => ix);
  },

  // Index writes run one at a time; fn gets the index as it is once the write before it has landed
  indexChain: Promise.resolve(),
  mutateIndex(fn) {
    const run = this.indexChain.then(async () => {
      const ix = fn(this.index) ?? this.index;
      ix.updated = now();
      await game.settings.set(MOD, "index", ix);
    });
    this.indexChain = run.catch((e) => console.error(MOD, e));
    return run;
  },

  // Foundry lowercases uploaded file names, so the file name is always the lowercased id.
  file(id) {
    return `${id.toLowerCase()}.json`;
  },

  path(id) {
    return `${fileDir()}/${this.file(id)}`;
  },

  async load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    let data = { id, events: [], encounters: [] };
    // Only a clean read (the file, or a 404 for a session that hasn't been saved yet) is cached. Anything else
    // (server down, a half-written file) would be cached as an empty session and the next save would overwrite
    // the real one.
    const fail = (why) => {
      if (!this.readFailed++) ui.notifications?.error(`Campaign Ledger: couldn't read the session file (${why}). Nothing is recorded until it can be read, so the file isn't overwritten.`, { permanent: true });
      throw new Error(`Campaign Ledger: couldn't read session ${id} (${why})`);
    };
    const res = await fetch(`${this.path(id)}?t=${now()}`, { cache: "no-store" }).catch((e) => fail(e.message));
    if (res.ok) {
      try { data = await res.json(); } catch (e) { fail(`${this.file(id)} is unreadable: ${e.message}`); }
    } else if (res.status !== 404) {
      fail(`HTTP ${res.status}`);
    }
    this.readFailed = 0;
    data.events ??= [];
    data.encounters ??= [];
    this.cache.set(id, data);
    return data;
  },

  forget(id) {
    this.cache.delete(id);
  },

  async ensureDir() {
    if (this.dirReady) return;
    try {
      await FP().createDirectory("data", fileDir());
    } catch (e) {
      /* already exists */
    }
    this.dirReady = true;
  },

  failed: 0,
  readFailed: 0,
  async save(id) {
    const data = this.cache.get(id);
    if (!data) return;
    await this.ensureDir();
    const file = new File([JSON.stringify(data)], this.file(id), { type: "application/json" });
    let ok = false;
    try {
      const res = await FP().upload("data", fileDir(), file, {}, { notify: false });
      ok = !!res && res !== false;
    } catch (e) {
      console.error(MOD, e);
    }
    if (!ok) {
      // Keep the data in memory and tell the GM once; the next event schedules another try
      if (!this.failed++) ui.notifications?.error("Campaign Ledger: couldn't save the session file. Events are kept in memory; it will try again after the next roll. Check the server's Data/worlds folder.", { permanent: true });
    } else if (this.failed) {
      this.failed = 0;
      ui.notifications?.info("Campaign Ledger: the session file saved.");
    }
  },

  // Save 4 seconds after the last event, but never wait more than 20 seconds during a busy fight.
  firstPending: 0,
  scheduleSave(id) {
    clearTimeout(this.timer);
    this.firstPending ||= now();
    const wait = Math.max(0, Math.min(4000, this.firstPending + 20000 - now()));
    this.timer = setTimeout(async () => {
      this.firstPending = 0;
      await this.save(id);
      await this.mutateIndex((ix) => ix);
    }, wait);
  },

  async flushNow() {
    clearTimeout(this.timer);
    this.firstPending = 0;
    const id = this.index.active;
    if (id && this.cache.has(id)) await this.save(id);
  },

  async loadScope(scope) {
    const ix = this.index;
    let sessions = ix.sessions;
    if (scope?.startsWith("arc:")) sessions = sessions.filter((s) => s.arc === scope.slice(4));
    else if (scope === "arc:none") sessions = sessions.filter((s) => !s.arc);
    else if (scope?.startsWith("session:")) sessions = sessions.filter((s) => s.id === scope.slice(8));
    const datas = await Promise.all(sessions.map((s) => this.load(s.id)));
    return {
      sessions,
      events: datas.flatMap((d) => d.events.map((e) => ({ ...e, sid: d.id }))),
      encounters: datas.flatMap((d) => d.encounters.map((e) => ({ ...e, sid: d.id }))),
    };
  },
};

/* ------------------------------------------------------------------ */
/* Sessions                                                           */
/* ------------------------------------------------------------------ */

let starting = null;
let expiring = null;

async function activeSession({ create = true } = {}) {
  const ix = Store.index;
  const s = ix.sessions.find((s) => s.id === ix.active);
  if (s && create) {
    expiring ??= expireStale(s).finally(() => (expiring = null));
    if (await expiring) return activeSession({ create });
  }
  if (s || !create) return s ?? null;
  if (starting) return starting;
  starting = (async () => {
    const fresh = Store.index;
    const session = { id: uid(), name: `Session ${fresh.sessions.length + 1}`, arc: fresh.currentArc ?? null, start: now(), end: null };
    fresh.sessions.push(session);
    fresh.active = session.id;
    await Store.setIndex(fresh);
    Store.cache.set(session.id, { id: session.id, events: [], encounters: [] });
    ui.notifications.info(`Campaign Ledger: recording ${session.name}. Rename or end it from the ledger.`);
    await startNotice(session, fresh);
    return session;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/**
 * A session nobody ended is ended by itself when the next event arrives more than the "Hours between sessions"
 * setting after its last event (as of that last event, not now), so the next evening doesn't land in it.
 * Returns true when the session was ended.
 */
async function expireStale(s) {
  const gap = Number(game.settings.get(MOD, "sessionGap")) * 3600000;
  if (!(gap > 0)) return false;
  const data = await Store.load(s.id);
  const last = data.events.at(-1)?.t ?? s.start;
  if (now() - last < gap) return false;
  await endSession({ quiet: true, at: last });
  ui.notifications.info(`Campaign Ledger: ${s.name} was still running from ${fmtDate(last)}; it has been ended and a new session starts now.`);
  await whisperGM(`<h3><i class="fa-solid fa-circle-stop"></i> Ended ${esc(s.name)}</h3><p>It was still running from ${esc(fmtDate(last))}, so it has been ended as of its last event and a new session starts with this one. If that evening isn't over yet, use "Resume last session" in the ledger.</p>`, { notice: "expired", session: s.id });
  return true;
}

async function whisperGM(html, flags) {
  try {
    await ChatMessage.create({
      content: `<div class="pcl-recap">${html}</div>`,
      speaker: { alias: "Campaign Ledger" },
      whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
      flags: { [MOD]: flags },
    });
  } catch (e) {
    console.warn(MOD, "couldn't whisper the GM", e);
  }
}

/** A whisper to the GMs that a session has started recording (setting "Whisper when recording starts"). */
async function startNotice(session, ix) {
  if (!game.settings.get(MOD, "startNotice")) return;
  const arc = ix.arcs?.find((a) => a.id === session.arc)?.name;
  const when = new Date(session.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  await whisperGM(
    `<h3><i class="fa-solid fa-circle-dot"></i> Recording ${esc(session.name)}</h3><p class="pcl-recap-sub">${[arc ? esc(arc) : null, `started ${esc(when)}`].filter(Boolean).join(" · ")}</p><p>Rolls, damage and combat from now on go into this session. Rename it, or end it, from the ledger.</p>`,
    { notice: "start", session: session.id },
  );
}

async function startSession() {
  await endSession({ quiet: true });
  starting = null;
  const ix = Store.index;
  ix.active = null;
  await Store.setIndex(ix);
  return activeSession();
}

async function endSession({ quiet = false, at = null, archive = false } = {}) {
  await Store.flushNow();
  const ix = Store.index;
  const s = ix.sessions.find((s) => s.id === ix.active);
  if (!s) return;
  s.end = at ?? now();
  ix.active = null;
  await Store.setIndex(ix);
  if (!quiet) ui.notifications.info(`Campaign Ledger: ended ${s.name}.`);
  // Archived (and cleared) before the recap, so the recap is the first thing in the fresh chat
  if (archive) await archiveChat(s.id, { clear: true });
  if (game.settings.get(MOD, "recap") !== "off") await postRecap(s.id);
}

/** Reopens the most recently ended session as the active one (for an evening that was ended too soon). */
async function resumeSession() {
  const ix = Store.index;
  if (ix.active) return null;
  const s = [...ix.sessions].filter((s) => s.end).sort((a, b) => b.end - a.end)[0];
  if (!s) return null;
  s.end = null;
  ix.active = s.id;
  await Store.setIndex(ix);
  ui.notifications.info(`Campaign Ledger: resumed ${s.name}.`);
  return s;
}

/* ------------------------------------------------------------------ */
/* Chat archive                                                       */
/* ------------------------------------------------------------------ */
// The chat log is copied into a file next to the session files, then (by default) cleared, so a long campaign doesn't
// slow Foundry down. Archives hold GM whispers and blind rolls, so the files get random names (players can fetch a
// file by its URL but can't browse the folder), and the list of them lives on a GM-only journal entry ("Campaign
// Ledger (GM data)") rather than in the index setting the ledger shows players. That keeps them out of the players'
// view, not out of a determined player's console: Foundry sends every journal entry, compendium and setting to every
// client (checked in Foundry 14), so this is the same protection GM journals and stat blocks have. Chat whispers are
// the only thing the server itself withholds.

/** The GM-only journal entry that records which archive files belong to which session. */
function gmStore() {
  return game.journal?.find((j) => j.flags?.[MOD]?.gmStore) ?? null;
}

async function ensureGmStore() {
  return gmStore() ?? JournalEntry.create({
    name: "Campaign Ledger (GM data)",
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: { [MOD]: { gmStore: true, chat: {} } },
  });
}

/** The archives of one session: [{ file, n, from, to, at }], oldest first (stored keyed by file, so writes merge). */
function archivesOf(sessionId) {
  const v = gmStore()?.flags?.[MOD]?.chat?.[sessionId] ?? {};
  return Object.values(foundry.utils.deepClone(v)).filter((a) => a?.file).sort((a, b) => a.from - b.from || a.at - b.at);
}

const fileKey = (file) => file.replace(/^chat-/, "").replace(/\.json$/, "");

/** One message as it looked in chat (rendered for the GM), with what the archive window filters on. */
const UNKNOWN_NAME = "Unknown";

/** Whether the players saw this message's speaker as nameless. */
function nameHidden(m) {
  try {
    if (!game.settings.get("pf2e", "metagame_tokenSetsNameVisibility")) return false;
  } catch (e) {
    return false;
  }
  const tok = m.speaker?.token ? game.scenes.get(m.speaker.scene)?.tokens.get(m.speaker.token) : null;
  return !!tok && tok.actor?.type !== "character" && tok.playersCanSeeName === false;
}

async function archiveRow(m) {
  let html, pubHtml = null, pubSpeaker = null;
  try {
    const el = await m.renderHTML();
    el.classList.remove("dsn-hide");
    el.querySelectorAll("script").forEach((s) => s.remove());
    // The relative time ("5 minutes ago") would be frozen; show the date and time instead
    const time = el.querySelector(".message-timestamp");
    if (time) time.textContent = new Date(m.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    html = el.outerHTML;
    // The players' copy of a public message: without what PF2e shows the GM only (DCs, modifiers, roll formulas)
    if (isPublic(m)) {
      const pub = el.cloneNode(true);
      pub.querySelectorAll('[data-visibility="gm"], [data-visibility="owner"], [data-visibility="none"]').forEach((x) => x.remove());
      pub.querySelectorAll("[data-pf2-dc]").forEach((x) => x.removeAttribute("data-pf2-dc"));
      // A speaker whose name the players couldn't see (PF2e's "Tokens determine NPC name visibility")
      if (nameHidden(m)) {
        for (const x of pub.querySelectorAll(".message-header *")) {
          if (!x.children.length && x.textContent.trim() === m.alias) x.textContent = UNKNOWN_NAME;
          for (const at of ["alt", "title", "aria-label", "data-tooltip"]) {
            const v = x.getAttribute(at);
            if (m.alias && v?.includes(m.alias)) x.setAttribute(at, v.replaceAll(m.alias, UNKNOWN_NAME));
          }
        }
        pubSpeaker = UNKNOWN_NAME;
      }
      pubHtml = pub.outerHTML;
    }
  } catch (e) {
    html = `<li class="chat-message message flexcol"><header class="message-header"><h4 class="message-sender">${esc(m.alias ?? "")}</h4></header><div class="message-content">${m.content ?? ""}</div></li>`;
  }
  const names = (ids) => [...(ids ?? [])].map((id) => game.users.get(id)?.name ?? "?");
  return { id: m.id, t: m.timestamp, author: m.author?.name ?? null, speaker: m.alias ?? null, whisper: names(m.whisper), blind: !!m.blind, roll: (m.rolls?.length ?? 0) > 0, html, pubHtml, pubSpeaker };
}

/** A message everyone at the table saw: not whispered (gmroll, selfroll, whispers) and not blind. */
const isPublic = (m) => !(m.whisper?.length) && !m.blind;

/**
 * Messages carry the server's clock and sessions this client's. The gap between the two is sampled as messages
 * arrive (server timestamp minus the moment this client hears of it, which is the gap less a little latency).
 */
const clockGap = [];
function sampleClock(msg) {
  const d = (msg?.timestamp ?? 0) - Date.now();
  if (!Number.isFinite(d) || Math.abs(d) > 86400000) return;
  clockGap.push(d);
  if (clockGap.length > 21) clockGap.shift();
}
function serverGap() {
  if (!clockGap.length) return 0;
  const sorted = [...clockGap].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The session a message posted at server time t belongs to: the last session started before it (a recap posted
 * after a session ended stays with that session), with a few seconds' grace for the roll that starts a session,
 * which is posted just before the session exists.
 */
function sessionAt(t) {
  const local = t - serverGap();
  let best = null;
  for (const s of Store.index.sessions) if ((s.start ?? 0) - 5000 <= local && (!best || s.start > best.start)) best = s;
  return best?.id ?? null;
}

let archiving = null;
/**
 * Copies every message in the chat log into a new archive file for the session, checks the file reads back whole,
 * records it on the GM store, and then (clear) deletes those messages. Messages that arrive meanwhile are left.
 * Each message is filed with the session it was posted in. Runs on the active GM only. Returns the archive entries
 * made (one per session), or null when nothing was archived.
 */
async function archiveChat(sessionId, { clear = true } = {}) {
  if (!game.user.isGM) return null;
  if (!isRecorder()) {
    ui.notifications.warn(`Campaign Ledger: only the active GM (${game.users.activeGM?.name ?? "?"}) can archive the chat.`);
    return null;
  }
  if (archiving) {
    ui.notifications.warn("Campaign Ledger: the chat is already being archived.");
    await archiving.catch(() => null);
    return null;
  }
  let bar = null;
  const done = () => { try { bar?.update?.({ pct: 1 }); } catch (e) { /* ignore */ } };
  const run = (async () => {
    const msgs = game.messages.contents.slice().sort((a, b) => a.timestamp - b.timestamp);
    if (!msgs.length) return null;
    try { bar = ui.notifications.info(`Campaign Ledger: archiving ${msgs.length} chat message${msgs.length === 1 ? "" : "s"}`, { progress: true }); } catch (e) { /* older notification API */ }
    const rows = [];
    for (let i = 0; i < msgs.length; i++) {
      rows.push(await archiveRow(msgs[i]));
      if (i % 25 === 0) try { bar?.update?.({ pct: (i / msgs.length) * 0.9 }); } catch (e) { /* ignore */ }
    }
    // Each message goes with the session it was posted in: the last one started before it (a recap posted after a
    // session ended stays with that session). Messages from before any session go with the one being archived.
    const groups = new Map();
    for (const r of rows) {
      const sid = sessionAt(r.t) ?? sessionId;
      if (!groups.has(sid)) groups.set(sid, []);
      groups.get(sid).push(r);
    }
    const newName = () => `chat-${foundry.utils.randomID(16).toLowerCase()}.json`;
    const save = async (name, body) => {
      const res = await FP().upload("data", fileDir(), new File([JSON.stringify(body)], name, { type: "application/json" }), {}, { notify: false });
      if (!res) throw new Error("the archive file couldn't be saved");
      const back = await fetch(`${fileDir()}/${name}?t=${now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (back?.messages?.length !== body.messages.length) throw new Error("the saved archive didn't read back whole");
    };
    await Store.ensureDir();
    // Every file is saved and checked before anything is listed, so a failure leaves no half-listed archive
    const made = [];
    for (const [sid, list] of groups) {
      // Two files: the whole log for the GM, and the public messages as players saw them
      const gmRows = list.map(({ pubHtml, pubSpeaker, ...r }) => r);
      const pubRows = list.filter((r) => r.pubHtml).map(({ pubHtml, pubSpeaker, ...r }) => ({ ...r, html: pubHtml, speaker: pubSpeaker ?? r.speaker, author: null, whisper: [], blind: false }));
      const file = newName();
      const pub = pubRows.length ? newName() : null;
      const session = { id: sid, name: Store.index.sessions.find((x) => x.id === sid)?.name ?? null };
      await save(file, { module: MOD, kind: "chat-archive", version: 2, world: game.world.id, session, archived: now(), count: gmRows.length, pub, messages: gmRows });
      if (pub) await save(pub, { module: MOD, kind: "chat-archive-public", version: 2, world: game.world.id, session, archived: now(), count: pubRows.length, messages: pubRows });
      made.push({ sid, name: session.name, entry: { file, pub, n: gmRows.length, nPub: pubRows.length, from: gmRows[0].t, to: gmRows.at(-1).t, at: now() }, pubList: pub ? { file: pub, n: pubRows.length, from: pubRows[0].t, to: pubRows.at(-1).t } : null });
    }
    const store = await ensureGmStore();
    await store.update(Object.fromEntries(made.map((m) => [`flags.${MOD}.chat.${m.sid}.${fileKey(m.entry.file)}`, m.entry])));
    for (const m of made) {
      if (!m.pubList) continue;
      try {
        await addPublicArchive(m.sid, m.pubList);
      } catch (e) {
        console.error(MOD, e);
        ui.notifications.warn("Campaign Ledger: the players' copy of the archive couldn't be listed; it will be put back the next time the GM loads the world.");
      }
    }
    const where = made.map((m) => (made.length > 1 ? `${m.entry.n} with ${m.name ?? "a session"}` : `with ${m.name ?? "the session"}`)).join(", ");
    // Saved and listed: from here on a failure only means some messages stay in chat
    let cleared = 0, left = 0;
    if (clear) {
      const ids = msgs.map((m) => m.id);
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200).filter((id) => game.messages.has(id));
        if (!batch.length) continue;
        try {
          await ChatMessage.deleteDocuments(batch);
          cleared += batch.length;
        } catch (e) {
          console.error(MOD, e);
          left += batch.length;
        }
      }
    }
    done();
    if (left) ui.notifications.warn(`Campaign Ledger: ${rows.length} chat messages archived (${where}), but ${left} couldn't be cleared from chat. They are in the archive; delete them by hand rather than archiving again.`, { permanent: true });
    else ui.notifications.info(`Campaign Ledger: ${rows.length} chat message${rows.length === 1 ? "" : "s"} archived ${made.length > 1 ? `(${where})` : where}${clear ? " and cleared from chat" : ""}.`);
    refreshOpenApps();
    return made.map((m) => ({ session: m.sid, ...m.entry }));
  })();
  archiving = run;
  try {
    return await run;
  } catch (e) {
    console.error(MOD, e);
    done();
    ui.notifications.error(`Campaign Ledger: the chat wasn't archived (${e.message}). Nothing was deleted.`, { permanent: true });
    return null;
  } finally {
    archiving = null;
  }
}

/** The players' copies of a session's archived chat: [{ file, n, from, to }], listed in the index everyone reads. */
function publicArchivesOf(sessionId) {
  return foundry.utils.deepClone(Store.index.sessions.find((s) => s.id === sessionId)?.chat ?? []);
}

async function addPublicArchive(sessionId, a) {
  if (!Store.index.sessions.some((x) => x.id === sessionId && !(x.chat ?? []).some((c) => c.file === a.file))) return false;
  await Store.mutateIndex((ix) => {
    const s = ix.sessions.find((x) => x.id === sessionId);
    if (s && !(s.chat ?? []).some((x) => x.file === a.file)) s.chat = [...(s.chat ?? []), a].sort((x, y) => x.from - y.from);
    return ix;
  });
  return true;
}

/** Puts back any players' copy the index lost (an import, a write that raced), from the GM store. Active GM only. */
async function repairPublicArchives() {
  if (!isRecorder()) return 0;
  const chat = gmStore()?.flags?.[MOD]?.chat ?? {};
  let n = 0;
  for (const [sid, v] of Object.entries(chat)) {
    for (const a of Object.values(v ?? {})) {
      if (!a?.pub || !a.nPub) continue;
      if (await addPublicArchive(sid, { file: a.pub, n: a.nPub, from: a.from, to: a.to })) n++;
    }
  }
  return n;
}

/** Players may read the archived chat (their copy) when the ledger is open to them and the setting allows it. */
const playersReadChat = () => game.settings.get(MOD, "playerView") && game.settings.get(MOD, "archivePlayers");
const canReadChat = () => game.user.isGM || playersReadChat();

/**
 * Lists again any archive file in the folder that the GM store doesn't (the journal entry was deleted, or an
 * update failed after the file was saved). Each file names its session. Returns how many were added.
 */
async function rebuildChatIndex() {
  if (!game.user.isGM) return 0;
  let files = [];
  try {
    files = (await FP().browse("data", fileDir())).files ?? [];
  } catch (e) {
    ui.notifications.error("Campaign Ledger: couldn't list the ledger folder.");
    return 0;
  }
  const store = await ensureGmStore();
  const listed = new Set(Object.values(store.flags?.[MOD]?.chat ?? {}).flatMap((v) => Object.values(v ?? {}).map((a) => a.file)));
  let added = 0;
  for (const path of files) {
    const file = path.split("/").pop();
    if (!/^chat-[a-z0-9]+\.json$/.test(file) || listed.has(file)) continue;
    const data = await fetch(`${fileDir()}/${file}?t=${now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const sid = data?.session?.id;
    if (data?.kind !== "chat-archive" || !sid || !data.messages?.length) continue;
    const entry = { file, pub: data.pub ?? null, n: data.messages.length, from: data.messages[0].t, to: data.messages.at(-1).t, at: data.archived ?? now() };
    await store.update({ [`flags.${MOD}.chat.${sid}.${fileKey(file)}`]: entry });
    if (data.pub) {
      const p = await fetch(`${fileDir()}/${data.pub}?t=${now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (p?.messages?.length) {
        entry.nPub = p.messages.length;
        await store.update({ [`flags.${MOD}.chat.${sid}.${fileKey(file)}.nPub`]: entry.nPub });
        await addPublicArchive(sid, { file: data.pub, n: p.messages.length, from: p.messages[0].t, to: p.messages.at(-1).t });
      }
    }
    added++;
  }
  added += await repairPublicArchives();
  if (added) refreshOpenApps();
  return added;
}

/** The session an archive made now belongs to: the running one, or else the latest. */
function archiveTarget() {
  const ix = Store.index;
  return ix.sessions.find((s) => s.id === ix.active) ?? [...ix.sessions].sort((a, b) => b.start - a.start)[0] ?? null;
}

const PAGE = 200;

/** GM-only window: a session's archived chat, oldest first, with search and filters. */
class ChatArchiveApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pcl-chat-archive",
    classes: ["pcl-app", "pcl-archive-app"],
    tag: "div",
    window: { title: "Chat Archive", icon: "fa-solid fa-comments", resizable: true },
    position: { width: 520, height: 760 },
    actions: { pclMore: ChatArchiveApp.#onMore },
  };

  static open(sessionId) {
    if (!canReadChat()) return ui.notifications.warn("The GM hasn't opened the archived chat to players.");
    const app = foundry.applications.instances.get("pcl-chat-archive") ?? new ChatArchiveApp();
    app.state = { sid: sessionId ?? app.state?.sid ?? null, q: "", who: "", rolls: false, whispers: true, shown: PAGE };
    app.rows = null;
    return app.render({ force: true });
  }

  state = { sid: null, q: "", who: "", rolls: false, whispers: true, shown: PAGE };
  rows = null;
  loadedFor = null;

  /** The archived messages of the shown session (all its archives, in order), with a lowercased text for search.
   *  The GM reads the whole log; a player reads the players' copy. */
  async load() {
    if (this.rows && this.loadedFor === this.state.sid) return this.rows;
    const rows = [];
    this.missing = 0;
    const list = game.user.isGM ? archivesOf(this.state.sid) : publicArchivesOf(this.state.sid);
    for (const a of list) {
      const data = await fetch(`${fileDir()}/${a.file}?t=${now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!data?.messages) { this.missing++; continue; }
      for (const m of data.messages) rows.push({ ...m, text: `${m.speaker ?? ""} ${m.html.replace(/<[^>]+>/g, " ")}`.replace(/\s+/g, " ").toLowerCase() });
    }
    // A session archived more than once (mid-session, then at the end) reads as one log, in time order
    rows.sort((x, y) => x.t - y.t);
    this.rows = rows;
    this.loadedFor = this.state.sid;
    return rows;
  }

  async _renderHTML() {
    const el = document.createElement("div");
    el.className = "pcl pcl-archive";
    if (!canReadChat()) {
      el.innerHTML = `<section class="pcl-body"><p class="pcl-empty">The GM hasn't opened the archived chat to players.</p></section>`;
      return el;
    }
    const gm = game.user.isGM;
    const ix = Store.index;
    this.sig = ChatArchiveApp.signature();
    const withChat = [...ix.sessions].reverse().filter((s) => (gm ? archivesOf(s.id).length : s.chat?.length));
    if (!this.state.sid || !withChat.some((s) => s.id === this.state.sid)) this.state.sid = withChat[0]?.id ?? null;
    if (!this.state.sid) {
      el.innerHTML = `<section class="pcl-body"><p class="pcl-empty">${gm ? `No chat has been archived yet. End a session with "Archive the chat" ticked, or use Archive chat in the ledger.` : "No chat has been archived yet."}</p></section>`;
      return el;
    }
    const rows = await this.load();
    const s = this.state;
    const q = s.q.trim().toLowerCase();
    const speakers = [...new Set(rows.map((m) => m.speaker).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (s.who && !speakers.includes(s.who)) s.who = "";
    const shown = rows.filter((m) => (!s.who || m.speaker === s.who) && (!s.rolls || m.roll) && (s.whispers || !m.whisper.length) && (!q || m.text.includes(q)));
    const clean = (h) => (foundry.utils.cleanHTML ? foundry.utils.cleanHTML(h) : h);
    const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(label)}</option>`;
    el.innerHTML = `<header class="pcl-head pcl-archive-head">
        <select name="sid">${withChat.map((x) => opt(x.id, `${x.name} · ${fmtDate(x.start)}`, x.id === s.sid)).join("")}</select>
        <input type="search" name="q" value="${esc(s.q)}" placeholder="Search">
        <select name="who">${opt("", "Everyone", !s.who)}${speakers.map((n) => opt(n, n, n === s.who)).join("")}</select>
        <label><input type="checkbox" name="rolls"${s.rolls ? " checked" : ""}> Rolls only</label>
        ${gm ? `<label><input type="checkbox" name="whispers"${s.whispers ? " checked" : ""}> Whispers</label>` : ""}
        <span class="pcl-archive-count">${shown.length} of ${rows.length}${this.missing ? ` · ${this.missing} archive file${this.missing === 1 ? "" : "s"} missing` : ""}</span>
      </header>
      <section class="pcl-body"><ol class="chat-log pcl-archive-log">${shown.slice(0, s.shown).map((m) => clean(m.html)).join("")}</ol>
      ${shown.length > s.shown ? `<button type="button" class="pcl-more" data-action="pclMore">Show ${Math.min(PAGE, shown.length - s.shown)} more</button>` : ""}</section>`;
    return el;
  }

  _replaceHTML(result, content) {
    // Keep the place in the list when the same session is drawn again (Show more, a filter)
    const keep = this.keepScroll ? content.querySelector(".pcl-body")?.scrollTop ?? 0 : 0;
    this.keepScroll = false;
    content.replaceChildren(result);
    if (keep) { const b = result.querySelector(".pcl-body"); if (b) b.scrollTop = keep; }
    const q = (sel) => result.querySelector(sel);
    q("select[name=sid]")?.addEventListener("change", (e) => { this.state = { ...this.state, sid: e.target.value, shown: PAGE }; this.rows = null; this.render(); });
    q("select[name=who]")?.addEventListener("change", (e) => { this.state.who = e.target.value; this.state.shown = PAGE; this.render(); });
    q("input[name=rolls]")?.addEventListener("change", (e) => { this.state.rolls = e.target.checked; this.state.shown = PAGE; this.render(); });
    q("input[name=whispers]")?.addEventListener("change", (e) => { this.state.whispers = e.target.checked; this.state.shown = PAGE; this.render(); });
    let t = null;
    q("input[name=q]")?.addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        this.state.q = e.target.value;
        this.state.shown = PAGE;
        await this.render();
        const box = this.element.querySelector("input[name=q]");
        box?.focus();
        box?.setSelectionRange(box.value.length, box.value.length);
      }, 300);
    });
  }

  static #onMore() {
    this.state.shown += PAGE;
    this.keepScroll = true;
    this.render();
  }

  /** What this window lists: who may read, and which files each session has. */
  static signature() {
    const gm = game.user.isGM;
    return JSON.stringify([canReadChat(), Store.index.sessions.map((s) => [s.id, s.name, (gm ? archivesOf(s.id) : s.chat ?? []).map((a) => a.file)])]);
  }

  /** Another archive was made, or access changed: read the files again, keeping the place in the list. */
  static refresh() {
    const app = foundry.applications.instances.get("pcl-chat-archive");
    if (!app?.rendered) return;
    const sig = ChatArchiveApp.signature();
    if (sig === app.sig) return;
    app.sig = sig;
    app.rows = null;
    app.keepScroll = true;
    app.render();
  }
}

/**
 * Restores an export (the JSON from "Export everything") into the ledger. Sessions and arcs are matched by id:
 * unknown ones are added, known ones get any events and encounters they don't have yet. Nothing is deleted.
 */
async function importLedger(text) {
  let x;
  try { x = JSON.parse(text); } catch (e) { throw new Error("that isn't a JSON file"); }
  if (x?.module !== MOD || !x.index?.sessions || !Array.isArray(x.sessions)) throw new Error("that isn't a Campaign Ledger export");
  await Store.flushNow();
  const ix = Store.index;
  for (const a of x.index.arcs ?? []) if (a?.id && !ix.arcs.some((b) => b.id === a.id)) ix.arcs.push({ id: a.id, name: String(a.name ?? "Arc") });
  let added = 0, merged = 0;
  const touched = [];
  for (const s of x.index.sessions) {
    if (!s?.id) continue;
    const file = x.sessions.find((d) => d?.id === s.id) ?? {};
    const events = Array.isArray(file.events) ? file.events : [];
    const encounters = Array.isArray(file.encounters) ? file.encounters : [];
    const mine = ix.sessions.find((m) => m.id === s.id);
    if (!mine) {
      ix.sessions.push({ id: s.id, name: String(s.name ?? "Session"), arc: s.arc ?? null, start: s.start ?? events[0]?.t ?? now(), end: s.end ?? events.at(-1)?.t ?? s.start ?? now() });
      Store.cache.set(s.id, { id: s.id, events, encounters });
      added++;
    } else {
      // Events have no id, so one is known by its whole content
      const data = await Store.load(s.id);
      const have = new Set(data.events.map((e) => JSON.stringify(e)));
      const extra = events.filter((e) => !have.has(JSON.stringify(e)));
      if (extra.length) {
        data.events.push(...extra);
        data.events.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
      }
      for (const enc of encounters) if (enc?.id && !data.encounters.some((d) => d.id === enc.id)) data.encounters.push(enc);
      merged++;
    }
    touched.push(s.id);
  }
  ix.sessions.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  await Store.setIndex(ix);
  for (const id of touched) await Store.save(id);
  return { added, merged };
}

/* ------------------------------------------------------------------ */
/* Recorder                                                           */
/* ------------------------------------------------------------------ */

const Rec = {
  encounter: null,
  hp: new Map(),
  res: new Map(),
  lastHit: new Map(),
  lastHeal: new Map(),
  lastCheck: new Map(),
  lastAbility: new Map(),
  recent: new Map(),
  pdSource: new Map(), // "<target uuid>|<damage type>" -> who put that persistent damage on them
  pdTick: new Map(),   // target uuid -> { by, t } from the last persistent-damage roll
  seen: new Set(),
  thSlots: new Map(),
  lastReroll: new Map(),  // who.k -> time of their last reroll message
  heroPending: new Map(), // who.k -> { ev, t }: a Hero Point that went down with no reroll yet
};

async function record(evt) {
  if (!isRecorder() || !recording()) return null;
  const s = await activeSession();
  const data = await Store.load(s.id);
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
 * The spell or ability and the creature behind a Target Helper card, the same on a spell card and on the damage card
 * Toolbelt copies its saves to. Toolbelt leaves both empty on a spell card and, on the damage card, sets the item to
 * the spell's uuid (the card's spell, or a scroll's or wand's embedded spell) and leaves the author empty.
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
  }
}

/**
 * Ability use. Recorded from action and feat cards posted to chat, and from any message carrying
 * flags["pf2e-campaign-ledger"].ability = "<name>" (for macros that post their own message).
 * The same character using the same ability twice within 5 seconds counts once, so a macro that
 * also posts the ability card isn't counted double.
 */
async function recordAbility(actor, tokenDoc, name) {
  if (!actor || !name) return;
  const w = who(actor, tokenDoc);
  const key = `${w.k}|${name}`;
  const last = Rec.lastAbility.get(key);
  if (last && now() - last < 5000) return;
  Rec.lastAbility.set(key, now());
  await record({ k: "ability", a: w, it: name });
}

async function onChatMessage(msg) {
  if (!isRecorder() || !recording()) return;
  const tagged = msg.flags?.[MOD]?.ability;
  if (tagged) {
    Rec.seen.add(`ability|${msg.id}`);
    return recordAbility(msg.actor, msg.token, tagged);
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
    await record({ k: "reroll", a: w, from: prev?.o ?? null, to, hero, nat: natD20(roll), fx: twice(roll) });
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
    const ev = await record({ k: "atk", a: w, tg: tw, o, nat: natD20(roll), fx: twice(roll), it: msg.item?.name ?? null });
    if (ev) Rec.lastCheck.set(`${w.k}|${type}`, ev);
    return;
  }

  if (type === "saving-throw") {
    const s = ctx.statistic ?? (ctx.domains ?? []).find((d) => SAVES.includes(d));
    // The creature whose spell or ability forced the save, when PF2e says (saves rolled from a card).
    const src = actorFromUuid(ctx.origin?.actor ?? null);
    const by = src && src.uuid !== actor.uuid ? who(src) : null;
    const ev = await record({ k: "save", a: w, s, o: degree(ctx.outcome), nat: natD20(roll), fx: twice(roll), ...(by ? { by } : {}) });
    if (ev) Rec.lastCheck.set(`${w.k}|${type}`, ev);
    return;
  }

  if (type === "skill-check" || type === "perception-check" || type === "initiative") {
    let s = type === "perception-check" ? "perception" : type === "initiative" ? "initiative" : ctx.statistic;
    if (!s || s === "skill-check") s = (ctx.domains ?? []).find((d) => CONFIG.PF2E?.skills?.[d] || d.endsWith("-lore")) ?? "skill";
    const ev = await record({ k: "skill", a: w, s, o: degree(ctx.outcome), nat: natD20(roll), fx: twice(roll) });
    if (ev) Rec.lastCheck.set(`${w.k}|${type}`, ev);
    return;
  }

  // PF2e's own recovery check uses "dying-recovery-check"; some macros use "dying-recovery".
  if (type === "flat-check" && (ctx.domains ?? []).some((d) => d.startsWith("dying-recovery"))) {
    const ev = await record({ k: "rec", a: w, o: degree(ctx.outcome), nat: natD20(roll), fx: twice(roll) });
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
    // roller by target and type. Failing that, whoever last hit them.
    const persistent = isPersistent(msg, flags);
    const types = [...new Set((roll.instances ?? []).map((i) => i.type).filter(Boolean))];
    let by = w;
    if (persistent) {
      const src = types.map((t) => Rec.pdSource.get(`${actor.uuid}|${t}`)).find((x) => x && x.k !== w.k) ?? Rec.lastHit.get(actor.uuid)?.w;
      if (src && src.k !== w.k) by = src;
      Rec.pdTick.set(actor.uuid, { by, t: now() });
    } else if (tActor) {
      (heal ? Rec.lastHeal : Rec.lastHit).set(tActor.uuid, { w, t: now() });
      for (const inst of roll.instances ?? []) if (inst.persistent && inst.type) Rec.pdSource.set(`${tActor.uuid}|${inst.type}`, w);
    }
    await record({ k: heal ? "heal" : "dmg", a: by, amt: Number(roll.total) || 0, it: persistent ? `persistent ${types.join("/") || "damage"}` : (msg.item?.name ?? null), tg: persistent ? w : tActor ? who(tActor, tTok) : null, ...(persistent ? { pd: true } : {}) });
    return;
  }

  if (type === "spell-cast" || (!ctx && flags.origin?.type === "spell")) {
    const item = msg.item;
    await record({ k: "spell", a: w, it: item?.name ?? "Spell", rk: item?.rank ?? null, fo: !!item?.isFocusSpell, ca: !!item?.isCantrip });
    return;
  }

  if ((!type || type === "self-effect") && ["action", "feat"].includes(flags.origin?.type)) {
    await recordAbility(actor, msg.token, msg.item?.name ?? null);
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
  let recent = hpPath ? Rec.recent.get(target.uuid) : null;
  if (recent && now() - recent.t > 5000) recent = null;
  if (recent) Rec.recent.delete(target.uuid);
  if (!src) {
    // No source on the card: nothing to credit, but what it changed is still the card's, for its Revert button.
    if (!recent) return;
    for (const ev of recent.evs) ev.m ??= msg.id;
    const s = await activeSession({ create: false });
    if (s) Store.scheduleSave(s.id);
    return;
  }
  const amt = (applied.updates ?? [])
    .filter((u) => u.path === "system.attributes.hp.value" || u.path === "system.attributes.hp.temp")
    .reduce((x, u) => x + Math.abs(Number(u.value) || 0), 0);
  const heal = !!applied.isHealing;
  let a = who(src);
  const tg = who(target, msg.token);
  const item = flags.origin?.uuid ? fromUuidSync(flags.origin.uuid) : null;
  // Damage the creature did to itself (persistent damage, a backfiring ability) goes to whoever last hit it, if
  // anyone did within the attribution window; otherwise it stays its own
  let pd = false;
  if (!heal && a.k === tg.k) {
    // The persistent tick just rolled (same creature, moments ago) says who it belongs to; else the last hitter
    const tick = Rec.pdTick.get(target.uuid);
    const last = Rec.lastHit.get(target.uuid);
    const src = tick && now() - tick.t <= 15000 ? tick.by : last?.w;
    if (src && src.k !== a.k) { a = src; pd = true; }
  }
  // Each event this card accounts for carries its message id (m), so the card's Revert button can take them back.
  if (amt > 0) await record({ k: heal ? "healdone" : "dealt", a, tg, amt, it: pd ? "persistent damage" : (item?.name ?? null), ...(pd ? { pd: true } : {}), m: msg.id });

  if (!recent) return;
  for (const ev of recent.evs) {
    ev.m ??= msg.id;
    if (!heal && (ev.k === "taken" || ev.k === "down")) ev.by = a;
    if (!heal && ev.k === "kill") ev.a = a;
    if (heal && (ev.k === "healed" || ev.k === "up")) ev.by = a;
  }
  const s = await activeSession({ create: false });
  if (s) Store.scheduleSave(s.id);
}

/**
 * PF2e's Revert button on a "takes X damage" or "is healed" card puts the HP back (an actor update marked
 * damageUndo, which onUpdateActor leaves alone) and then marks the card reverted. Everything recorded for that
 * card goes: the damage or healing dealt, the damage or healing taken, and a kill, down or revive it caused.
 */
async function onDamageReverted(msg) {
  const s = await activeSession({ create: false });
  if (!s) return;
  const data = await Store.load(s.id);
  const before = data.events.length;
  data.events = data.events.filter((e) => e.m !== msg.id);
  if (data.events.length === before) return;
  Store.scheduleSave(s.id);
  refreshOpenApps();
}

/**
 * Saves rolled through PF2e Toolbelt's Target Helper don't post their own message. Toolbelt writes
 * them into the spell or damage card's flags instead, so they're picked up here. Each save is keyed
 * to its card and token, so a reroll updates the earlier result instead of counting twice.
 */
async function onUpdateChatMessage(msg, changes) {
  if (!isRecorder() || !recording()) return;
  if (changes.flags?.pf2e?.appliedDamage?.isReverted === true) return onDamageReverted(msg);

  const tagged = changes.flags?.[MOD]?.ability;
  if (tagged && !Rec.seen.has(`ability|${msg.id}`)) {
    Rec.seen.add(`ability|${msg.id}`);
    await recordAbility(msg.actor, msg.token, tagged);
  }

  if (!changes.flags?.["pf2e-toolbelt"]?.targetHelper) return;
  const variants = msg.flags?.["pf2e-toolbelt"]?.targetHelper?.saveVariants ?? {};
  const scene = game.scenes.get(msg.speaker?.scene) ?? canvas.scene;
  const s = await activeSession();
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
      // Toolbelt copies the saves from a spell card onto its damage card. A copy is the same roll (Toolbelt keeps the
      // roll's JSON) for the same spell or ability and author, seen on another card within a few minutes; on the same
      // card it's the same save at any age. Two real saves that roll the same can't then be taken for one another
      // unless the same creature recasts the same spell on the same target within those minutes.
      const key = `${tokenId}|${stat}|${hashOf(`${source.item}|${source.author}|${save.roll ?? `${save.die}|${save.value}`}`)}`;
      const oldKey = `${tokenId}|${stat}|${save.die}|${save.value}`; // the key before 0.4.3, for saves recorded then
      const has = (e, k) => e.src === k || e.alt?.includes(k);
      const onCard = (e) => e.m === msg.id || e.ms?.includes(msg.id);
      const known = (e) => e.k === "save" && ((has(e, key) && (onCard(e) || now() - (e.t ?? 0) < COPY_WINDOW)) || (!e.m && recent(e) && has(e, oldKey)));
      if (Rec.seen.has(`${msg.id}|${key}`)) continue;
      Rec.seen.add(`${msg.id}|${key}`);
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
      const earlier = Rec.thSlots.get(slot);
      Rec.thSlots.set(slot, key);
      // The slot remembers the exact earlier save; the prefix search is only for a reroll of a save seen before a reload
      const prev = (save.rerolled || earlier)
        ? data.events.findLast((e) => e.k === "save" && recent(e) && (earlier ? e.src === earlier || e.alt?.includes(earlier) : e.src?.startsWith(`${tokenId}|${stat}|`)))
        : null;
      if (prev) {
        const paid = heroReroll(prev.a);
        await record({ k: "reroll", a: prev.a, from: prev.o, to: o, hero: paid || save.rerolled === "hero", nat });
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
        await record({ k: "save", a: who(tok.actor, tok), s: stat, o, nat, src: key, m: msg.id, ...(caster ? { by: caster } : {}) });
      }
    }
  }
}

async function onUpdateActor(actor, changes, options = {}) {
  const prevHp = Rec.hp.get(actor.uuid);
  const prevRes = Rec.res.get(actor.uuid);
  const hp = hpSnap(actor);
  const res = resSnap(actor);
  Rec.hp.set(actor.uuid, hp);
  Rec.res.set(actor.uuid, res);
  if (!isRecorder() || !recording()) return;
  const w = who(actor);
  if (!w) return;

  // An undo from a card's Revert button isn't healing or damage: the revert takes back what the card recorded.
  if (prevHp && hp && changes.system?.attributes?.hp && !options.damageUndo) {
    // Only a change to HP itself counts. Temporary HP that went with it is part of the same hit (temp);
    // temporary HP cleared on its own (expired) isn't damage, and HP that rose with the maximum (a level,
    // a rest that raised it) isn't healing.
    const lostHp = prevHp.v - hp.v;
    const lostTemp = Math.max(0, prevHp.t - hp.t);
    const gained = hp.v - prevHp.v;
    const maxChanged = hp.m !== prevHp.m;
    // Kept briefly so the "takes X damage" card that follows can name the real attacker or healer.
    const recent = { t: now(), evs: [] };
    Rec.recent.set(actor.uuid, recent);
    const keep = (ev) => ev && recent.evs.push(ev);
    if (lostHp > 0) keep(await record({ k: "taken", a: w, amt: lostHp + lostTemp, ...(lostTemp ? { temp: lostTemp } : {}), by: attribution(actor, Rec.lastHit) }));
    if (gained > 0 && !maxChanged) keep(await record({ k: "healed", a: w, amt: gained, by: attribution(actor, Rec.lastHeal) }));
    if (prevHp.v > 0 && hp.v <= 0) {
      const by = attribution(actor, Rec.lastHit);
      if (w.p) keep(await record({ k: "down", a: w, by }));
      else keep(await record({ k: "kill", a: by, v: w }));
    }
    if (prevHp.v <= 0 && hp.v > 0 && w.p && !maxChanged) keep(await record({ k: "up", a: w, by: attribution(actor, Rec.lastHeal) }));
  }

  if (prevRes && w.p) {
    if (prevRes.hero !== null && res.hero !== null && res.hero < prevRes.hero) {
      // Hero Points are spent one at a time on a reroll (PF2e takes the point, then posts the reroll), or all
      // at once to stabilise while dying. Any other decrease is a reset, recorded as lost and not counted.
      const n = prevRes.hero - res.hero;
      const last = Rec.lastReroll.get(w.k);
      const dying = actor.itemTypes?.condition?.some((c) => c.slug === "dying");
      if (n === 1 && last && now() - last < 10000) await record({ k: "hero", a: w, n });
      else if (n > 1 && dying) await record({ k: "hero", a: w, n });
      else {
        const ev = await record({ k: "hero", a: w, n, lost: true });
        if (ev && n === 1) Rec.heroPending.set(w.k, { ev, t: now() });
      }
    }
    if (prevRes.focus !== null && res.focus !== null && res.focus < prevRes.focus) await record({ k: "focus", a: w, n: prevRes.focus - res.focus });
  }
}

async function onDying(item, changes = null) {
  if (!isRecorder() || !recording()) return;
  if (item.type !== "condition" || item.slug !== "dying") return;
  // An update that didn't change the value (a badge shown or hidden) isn't a new step toward dead
  if (changes && changes.system?.value?.value === undefined) return;
  const actor = item.actor;
  if (!actor?.hasPlayerOwner) return;
  const v = item.value ?? item.system?.value?.value ?? 1;
  await record({ k: "dying", a: who(actor), v });
  const max = actor.system?.attributes?.dying?.max ?? 4;
  if (v >= max) await record({ k: "dead", a: who(actor) });
}

async function findEncounter(id) {
  const s = await activeSession({ create: false });
  if (!s) return null;
  const data = await Store.load(s.id);
  return { data, enc: data.encounters.find((e) => e.id === id), sid: s.id };
}

function combatantRow(c) {
  const w = who(c.actor, c.token);
  if (!w) return null;
  const hp = c.actor?.system?.attributes?.hp;
  return { ...w, hp0: hp?.value ?? null, hpMax: hp?.max ?? null, hp1: null };
}

async function onCombatStart(combat) {
  if (!isRecorder() || !recording()) return;
  const s = await activeSession();
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
      combatants: combat.combatants.map(combatantRow).filter(Boolean),
    });
  }
  Store.scheduleSave(s.id);
  refreshOpenApps();
}

async function onUpdateCombat(combat, changes) {
  if (!isRecorder() || changes.round === undefined) return;
  const f = await findEncounter(combat.id);
  if (!f?.enc) return;
  f.enc.rounds = Math.max(f.enc.rounds, combat.round);
  Store.scheduleSave(f.sid);
}

async function onCreateCombatant(combatant) {
  if (!isRecorder()) return;
  const f = await findEncounter(combatant.combat?.id);
  if (!f?.enc) return;
  const row = combatantRow(combatant);
  if (row && !f.enc.combatants.some((c) => c.k === row.k)) f.enc.combatants.push(row);
  Store.scheduleSave(f.sid);
}

async function onDeleteCombat(combat) {
  if (!isRecorder()) return;
  const f = await findEncounter(combat.id);
  if (Rec.encounter === combat.id) Rec.encounter = null;
  if (!f?.enc) return;
  f.enc.end = now();
  f.enc.rounds = Math.max(f.enc.rounds, combat.round ?? 1);
  for (const c of combat.combatants) {
    const w = who(c.actor, c.token);
    const row = w && f.enc.combatants.find((r) => r.k === w.k);
    if (row) row.hp1 = c.actor?.system?.attributes?.hp?.value ?? null;
  }
  Store.scheduleSave(f.sid);
  refreshOpenApps();
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                        */
/* ------------------------------------------------------------------ */

function blank(w) {
  return {
    k: w.k, n: w.n, p: w.p,
    atk: 0, atkKnown: 0, hit: 0, crit: 0, critFail: 0, weapons: {},
    dmg: 0, dmgBest: 0, dmgBestIt: null, dmgRolls: 0,
    dealt: 0, dealtBest: 0, dealtBestIt: null, healDone: 0,
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
  const by = new Map();
  const get = (w) => {
    if (!w?.k) return null;
    if (!by.has(w.k)) by.set(w.k, blank(w));
    return by.get(w.k);
  };
  for (const e of events) {
    const a = get(e.a);
    if (a && e.e) a.encounters.add(e.e);
    if (e.nat === 20 && a && e.k !== "reroll") a.nat20++;
    if (e.nat === 1 && a && e.k !== "reroll") a.nat1++;
    switch (e.k) {
      case "atk": {
        const known = e.o !== null && e.o !== undefined;
        a.atk++;
        if (known) a.atkKnown++;
        if (e.o >= 2) a.hit++;
        if (e.o === 3) a.crit++;
        if (e.o === 0) a.critFail++;
        const wpn = (a.weapons[e.it ?? "Strike"] ??= weaponRow());
        wpn.n++;
        if (known) wpn.known++;
        if (e.o >= 2) wpn.hit++;
        if (e.o === 3) wpn.crit++;
        if (e.o === 3 && e.tg) get(e.tg).critTaken++;
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
      case "up":
        a.revived++;
        if (e.by) get(e.by).revivedBy++;
        break;
      case "save": {
        // [rolls, passed, critical failures, rolls with a known DC]
        const s = a.saves[e.s] ?? (a.saves[e.s] = [0, 0, 0, 0]);
        s[0]++;
        if (e.o !== null && e.o !== undefined) s[3]++;
        if (e.o >= 2) s[1]++;
        if (e.o === 0) s[2]++;
        // Credit the caster with saves forced on the other side (not on their own allies).
        if (e.by && e.a && e.by.p !== e.a.p) {
          const c = get(e.by);
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
  for (const a of by.values()) {
    const sv = Object.values(a.saves);
    a.saveN = sv.reduce((x, s) => x + s[3], 0);
    a.savePass = sv.reduce((x, s) => x + s[1], 0);
    a.hitRate = a.atkKnown ? a.hit / a.atkKnown : -1;
    a.saveRate = a.saveN ? a.savePass / a.saveN : -1;
    a.spellN = Object.values(a.spells).reduce((x, s) => x + s.n, 0);
  }
  return by;
}

/* ------------------------------------------------------------------ */
/* Round log, dice and recap                                          */
/* ------------------------------------------------------------------ */

const ATTACK_RESULT = ["critical miss", "miss", "hit", "critical hit"];
const CHECK_RESULT = ["critical failure", "failure", "success", "critical success"];

/** One line of the round-by-round log, or null for events the log leaves out. */
function describe(e) {
  const a = esc(e.a?.n ?? "Someone");
  const tg = e.tg ? esc(e.tg.n) : null;
  const it = e.it ? esc(e.it) : null;
  const nat = e.nat === 20 ? " (natural 20)" : e.nat === 1 ? " (natural 1)" : "";
  const res = (list, o) => (o === null || o === undefined ? "" : `: <b>${list[o]}</b>`);
  switch (e.k) {
    case "atk": return `${a} attacks${tg ? ` ${tg}` : ""}${it ? ` with ${it}` : ""}${res(ATTACK_RESULT, e.o)}${nat}`;
    case "dealt": return `${a} deals <b>${e.amt}</b> damage to ${tg ?? "someone"}${it ? ` (${it})` : ""}`;
    case "healdone": return `${a} heals ${tg ?? "someone"} for <b>${e.amt}</b>${it ? ` (${it})` : ""}`;
    case "save": return `${a} rolls a ${esc(titleCase(e.s ?? "saving"))} save${res(CHECK_RESULT, e.o)}${nat}`;
    case "skill": return `${a} rolls ${esc(skillLabel(e.s))}${res(CHECK_RESULT, e.o)}${nat}`;
    case "rec": return `${a} rolls a recovery check${res(CHECK_RESULT, e.o)}`;
    case "spell": return `${a} casts ${it ?? "a spell"}`;
    case "ability": return `${a} uses ${it ?? "an ability"}`;
    case "down": return `<b>${a} goes down</b>${e.by ? ` (${esc(e.by.n)})` : ""}`;
    case "kill": return `<b>${esc(e.v?.n ?? "A foe")} falls</b>${e.a ? ` to ${a}` : ""}`;
    case "up": return `${a} is back up${e.by ? ` thanks to ${esc(e.by.n)}` : ""}`;
    case "dying": return `${a} is dying ${e.v ?? ""}`;
    case "dead": return `<b>${a} dies</b>`;
    case "reroll": return `${a} rerolls${e.hero ? " with a Hero Point" : ""}${res(CHECK_RESULT, e.to)}`;
    case "hero": return e.lost ? null : `${a} spends ${e.n === 1 ? "a Hero Point" : `${e.n} Hero Points`}`;
    default: return null;
  }
}

/** Every d20 rolled, per character, tagged with the kind of check. */
function diceData(events) {
  const out = new Map();
  const push = (w, v, kind) => {
    if (!w?.k || !(v >= 1 && v <= 20)) return;
    if (!out.has(w.k)) out.set(w.k, { k: w.k, n: w.n, p: w.p, rolls: [] });
    out.get(w.k).rolls.push({ v, kind });
  };
  for (const e of events) {
    if (e.fx) continue;
    if (e.k === "atk") push(e.a, e.nat0 ?? e.nat, "atk");
    else if (e.k === "save") push(e.a, e.nat0 ?? e.nat, "save");
    else if (e.k === "skill") push(e.a, e.nat0 ?? e.nat, ["perception", "initiative"].includes(e.s) ? "perc" : "skill");
    else if (e.k === "rec") push(e.a, e.nat0 ?? e.nat, "rec");
    else if (e.k === "reroll") push(e.a, e.nat, "reroll");
  }
  return out;
}

function diceStats(vals) {
  const n = vals.length;
  if (!n) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((x, y) => x + y, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const counts = Array(21).fill(0);
  for (const v of vals) counts[v]++;
  const top = Math.max(...counts);
  const mode = top > 1 ? counts.map((c, i) => (c === top ? i : null)).filter((x) => x).join(", ") : "–";
  return { n, mean, median, mode, counts, nat20: counts[20], nat1: counts[1], luck: mean - 10.5 };
}

function luckText(st) {
  if (st.n < 10) return "Too few rolls";
  const l = st.luck;
  if (Math.abs(l) < 0.25) return "Right on average";
  return `${l > 0 ? "+" : "−"}${Math.abs(l).toFixed(1)} ${l > 0 ? "above" : "below"} average`;
}

/** d20 histogram as inline SVG: one bar per face, a dashed line where a fair die would sit. */
function histogram(st) {
  const W = 680, H = 240, L = 34, R = 10, T = 12, B = 26;
  const pw = W - L - R, ph = H - T - B, bw = pw / 20;
  const expected = st.n / 20;
  const peak = Math.max(...st.counts.slice(1), expected, 1);
  const step = Math.max(1, Math.ceil(peak / 4));
  const top = step * Math.ceil(peak / step);
  const y = (v) => T + ph - (v / top) * ph;
  const grid = [];
  for (let v = 0; v <= top; v += step) {
    grid.push(`<line class="pcl-grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="pcl-axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  }
  const bars = [];
  for (let f = 1; f <= 20; f++) {
    const c = st.counts[f];
    const x = L + (f - 1) * bw + 1, w = bw - 2;
    const h = (c / top) * ph;
    if (h > 0) {
      const r = Math.min(4, h, w / 2), y0 = T + ph - h, y1 = T + ph;
      bars.push(`<path class="pcl-bar" d="M${x},${y1} V${y0 + r} Q${x},${y0} ${x + r},${y0} H${x + w - r} Q${x + w},${y0} ${x + w},${y0 + r} V${y1} Z"/>`);
    }
    const share = Math.round((c / st.n) * 100);
    bars.push(`<rect class="pcl-hit" x="${x - 1}" y="${T}" width="${bw}" height="${ph}" data-tooltip="Rolled a ${f}: ${c} time${c === 1 ? "" : "s"} (${share}%)"/>`);
    bars.push(`<text class="pcl-axis" x="${x + w / 2}" y="${H - 8}" text-anchor="middle">${f}</text>`);
  }
  const ey = y(expected);
  const exp = `<line class="pcl-expected" x1="${L}" x2="${W - R}" y1="${ey}" y2="${ey}"/><text class="pcl-axis pcl-expected-label" x="${W - R}" y="${ey - 5}" text-anchor="end">fair die: ${expected.toFixed(1)} each</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${grid.join("")}${bars.join("")}${exp}</svg>`;
}

/** The recap card for a session, or null if nothing was recorded. */
async function recapHTML(sessionId) {
  const s = Store.index.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  const data = await Store.load(sessionId);
  if (!data.events.length) return null;
  const party = [...aggregate(data.events).values()].filter((a) => a.p);
  const top = (key) => party.filter((a) => a[key] > 0).sort((x, y) => y[key] - x[key])[0];
  const total = (key) => party.reduce((x, a) => x + (a[key] ?? 0), 0);
  const li = [];
  const big = top("dealtBest");
  if (big) li.push(`Biggest hit: <b>${esc(big.n)}</b>, ${big.dealtBest} damage${big.dealtBestIt ? ` with ${esc(big.dealtBestIt)}` : ""}`);
  const dmg = top("dealt");
  if (dmg) li.push(`Most damage: <b>${esc(dmg.n)}</b>, ${dmg.dealt} in total`);
  const crit = top("crit");
  if (crit) li.push(`Most crits: <b>${esc(crit.n)}</b> (${crit.crit})`);
  const kills = total("kills");
  const killer = top("kills");
  if (kills) li.push(`Foes felled: ${kills}${killer ? `, most by <b>${esc(killer.n)}</b> (${killer.kills})` : ""}`);
  const downs = party.filter((a) => a.down).map((a) => `${esc(a.n)}${a.down > 1 ? ` ×${a.down}` : ""}`);
  if (downs.length) li.push(`Went down: ${downs.join(", ")}`);
  const savers = party.filter((a) => a.revivedBy).map((a) => `${esc(a.n)}${a.revivedBy > 1 ? ` ×${a.revivedBy}` : ""}`);
  if (savers.length) li.push(`Brought someone back: ${savers.join(", ")}`);
  const spells = top("spellN");
  if (spells) li.push(`Most spells: <b>${esc(spells.n)}</b> (${spells.spellN})`);
  const forced = top("forcedFail");
  if (forced) li.push(`Most saves failed against them: <b>${esc(forced.n)}</b> (${forced.forcedFail} of ${forced.forced})`);
  const skills = top("skillPass");
  if (skills) li.push(`Most skill successes: <b>${esc(skills.n)}</b> (${skills.skillPass})`);
  const heal = top("healDone");
  if (heal) li.push(`Most healing: <b>${esc(heal.n)}</b>, ${heal.healDone} HP`);
  const n20 = party.filter((a) => a.nat20).map((a) => `${esc(a.n)}${a.nat20 > 1 ? ` ×${a.nat20}` : ""}`);
  if (n20.length) li.push(`Natural 20s: ${n20.join(", ")}`);
  const n1 = party.filter((a) => a.nat1).map((a) => `${esc(a.n)}${a.nat1 > 1 ? ` ×${a.nat1}` : ""}`);
  if (n1.length) li.push(`Natural 1s: ${n1.join(", ")}`);
  const hero = total("hero");
  if (hero) li.push(`Hero Points spent: ${hero}`);
  const encs = data.encounters.length;
  const sub = [fmtDuration((s.end ?? now()) - s.start), `${encs} encounter${encs === 1 ? "" : "s"}`].filter((x) => x && x !== "–").join(" · ");
  return `<div class="pcl-recap"><h3><i class="fa-solid fa-book-open-reader"></i> ${esc(s.name)}</h3>${sub ? `<p class="pcl-recap-sub">${sub}</p>` : ""}<ul>${li.map((l) => `<li>${l}</li>`).join("")}</ul></div>`;
}

async function postRecap(sessionId, { manual = false } = {}) {
  const content = await recapHTML(sessionId);
  if (!content) return false;
  const mode = game.settings.get(MOD, "recap");
  const gmOnly = mode === "gm" || (manual && mode === "off");
  await ChatMessage.create({
    content,
    speaker: { alias: "Campaign Ledger" },
    whisper: gmOnly ? ChatMessage.getWhisperRecipients("GM").map((u) => u.id) : [],
  });
  return true;
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                          */
/* ------------------------------------------------------------------ */

const openApps = new Set();
let refreshTimer = null;
/** Something the dashboard shows changed. Open windows re-render once things go quiet, and only if they show an older revision. */
function refreshOpenApps() {
  Store.rev++;
  if (!openApps.size) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const app of openApps) app.refresh();
  }, 1200);
}

const PARTY_COLUMNS = [
  { key: "n", label: "Character", group: "", fmt: (a) => esc(a.n), text: true },
  { key: "atk", label: "Attacks", group: "Offense" },
  { key: "hitRate", label: "Hit %", group: "Offense", fmt: (a) => pct(a.hit, a.atkKnown), tip: "Of attacks rolled against a target" },
  { key: "crit", label: "Crits", group: "Offense" },
  { key: "dealt", label: "Damage", group: "Offense", tip: "Damage dealt, after resistances and not counting overkill. Hover a number for the amount rolled.", tipf: (a) => `${a.dmg} rolled` },
  { key: "dealtBest", label: "Best hit", group: "Offense", fmt: (a) => (a.dealtBest ? `${a.dealtBest}` : "–"), tipf: (a) => a.dealtBestIt ?? "" },
  { key: "kills", label: "Kills", group: "Offense" },
  { key: "spellN", label: "Spells", group: "Spells and skills", tip: "Spells cast, cantrips included" },
  { key: "forcedFail", label: "Saves forced", group: "Spells and skills", fmt: (a) => (a.forced ? `${a.forcedFail}/${a.forced}` : "–"), tip: "Saves your spells and abilities forced on the other side: failed / rolled" },
  { key: "skillPass", label: "Skills", group: "Spells and skills", fmt: (a) => (a.skillN ? `${a.skillPass}/${a.skillKnown}` : "–"), tip: "Skill checks that succeeded / skill checks against a DC. Initiative isn't counted." },
  { key: "taken", label: "Taken", group: "Defense", tip: "Damage taken: what came off HP, with the temporary HP that went with the same hit" },
  { key: "critTaken", label: "Crits taken", group: "Defense" },
  { key: "down", label: "Downed", group: "Defense" },
  { key: "dead", label: "Deaths", group: "Defense" },
  { key: "healDone", label: "Healing", group: "Support", tip: "Healing applied to HP. Hover a number for the amount rolled.", tipf: (a) => `${a.heal} rolled` },
  { key: "revivedBy", label: "Revived", group: "Support", tip: "Allies brought back up from 0 HP" },
  { key: "saveRate", label: "Saves", group: "Dice", fmt: (a) => pct(a.savePass, a.saveN), tip: "Saving throws passed" },
  { key: "nat20", label: "20s / 1s", group: "Dice", fmt: (a) => (a.nat20 || a.nat1 ? `${a.nat20} / ${a.nat1}` : "–"), tip: "Natural 20s / natural 1s" },
  { key: "hero", label: "Hero pts", group: "Dice", tip: "Hero Points spent" },
  { key: "rerolls", label: "Rerolls", group: "Dice", fmt: (a) => (a.rerolls ? `${a.rerollsBetter}/${a.rerolls}` : "–"), tip: "Rerolls that improved the result / all rerolls" },
];

class LedgerApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pf2e-campaign-ledger",
    classes: ["pcl-app"],
    tag: "div",
    window: {
      title: "Campaign Ledger", icon: "fa-solid fa-book-open-reader", resizable: true,
      controls: [
        { icon: "fa-solid fa-file-export", label: "Export everything", action: "exportData" },
        { icon: "fa-solid fa-file-import", label: "Import an export", action: "importData" },
      ],
    },
    position: { width: 1200, height: 740 },
    actions: {
      // Not "tab": Foundry reserves that action name for its own tab groups.
      pclTab: LedgerApp.#onTab,
      sort: LedgerApp.#onSort,
      encounter: LedgerApp.#onEncounter,
      renameEncounter: LedgerApp.#onRenameEncounter,
      startSession: LedgerApp.#onStartSession,
      endSession: LedgerApp.#onEndSession,
      resumeSession: LedgerApp.#onResumeSession,
      addArc: LedgerApp.#onAddArc,
      deleteSession: LedgerApp.#onDeleteSession,
      recap: LedgerApp.#onRecap,
      diceWho: LedgerApp.#onDiceWho,
      exportData: LedgerApp.#onExport,
      importData: LedgerApp.#onImport,
      reset: LedgerApp.#onReset,
      refresh: LedgerApp.#onRefresh,
      viewSession: LedgerApp.#onViewSession,
      archiveChat: LedgerApp.#onArchiveChat,
      viewChat: LedgerApp.#onViewChat,
    },
  };

  // The tab, scope and sort survive closing the window
  static lastState = null;
  state = LedgerApp.lastState ?? { tab: "party", scope: "all", sort: { key: "dealt", dir: -1 }, char: null, enc: null, diceWho: "party", diceKind: "all" };
  rev = -1; // Store.rev this window shows

  get isGM() {
    return game.user.isGM;
  }

  get allowed() {
    return this.isGM || game.settings.get(MOD, "playerView");
  }

  _getHeaderControls() {
    const controls = super._getHeaderControls();
    return this.isGM ? controls : controls.filter((c) => !["exportData", "importData"].includes(c.action));
  }

  async _prepareContext() {
    this.rev = Store.rev;
    if (!this.allowed) return { ix: foundry.utils.deepClone(DEFAULT_INDEX), data: { sessions: [], events: [], encounters: [] }, stats: new Map() };
    const ix = Store.index;
    // A scope pointing at a deleted session or arc falls back to the whole campaign
    const sc = this.state.scope;
    if ((sc.startsWith("session:") && !ix.sessions.some((s) => s.id === sc.slice(8))) || (sc.startsWith("arc:") && sc !== "arc:none" && !ix.arcs.some((a) => a.id === sc.slice(4)))) this.state.scope = "all";
    const data = await Store.loadScope(this.state.scope);
    return { ix, data, stats: aggregate(data.events) };
  }

  async _renderHTML(ctx) {
    const el = document.createElement("div");
    el.className = "pcl";
    if (!this.allowed) {
      el.innerHTML = `<section class="pcl-body"><p class="pcl-empty">The GM hasn't opened the Campaign Ledger to players.</p></section>`;
      return el;
    }
    el.innerHTML = this.#header(ctx) + this.#tabs() + `<section class="pcl-body">${this.#body(ctx)}</section>`;
    return el;
  }

  // Keeps the scroll position of the body and the round log when the same tab is drawn again
  #shownTab = null;
  _replaceHTML(result, content) {
    const same = this.#shownTab === this.state.tab;
    const body = content.querySelector(".pcl-body");
    const log = content.querySelector(".pcl-log");
    const pos = same && body ? { top: body.scrollTop, left: body.scrollLeft, log: log?.scrollTop ?? 0 } : null;
    content.replaceChildren(result);
    this.#shownTab = this.state.tab;
    if (!pos) return;
    const nb = result.querySelector(".pcl-body");
    if (nb) {
      nb.scrollTop = pos.top;
      nb.scrollLeft = pos.left;
    }
    const nl = result.querySelector(".pcl-log");
    if (nl) nl.scrollTop = pos.log;
  }

  /** A live refresh: only when the data moved on, and not under a field the GM is typing in. */
  refresh() {
    if (!this.rendered || this.rev === Store.rev) return;
    const focus = document.activeElement;
    if (focus && this.element.contains(focus) && focus.matches("input, select, textarea")) return;
    this.render();
  }

  _onFirstRender() {
    openApps.add(this);
    // A refresh held back while a field had focus runs once the field is left
    this.element.addEventListener("focusout", () => setTimeout(() => this.refresh(), 50));
  }

  _onClose() {
    openApps.delete(this);
    LedgerApp.lastState = this.state;
  }

  _onRender() {
    this.element.querySelector("select[name=diceKind]")?.addEventListener("change", (e) => {
      this.state.diceKind = e.target.value;
      this.render();
    });
    const q = (s) => this.element.querySelector(s);
    q("select[name=scope]")?.addEventListener("change", (e) => {
      this.state.scope = e.target.value;
      this.state.enc = null;
      this.render();
    });
    q("select[name=char]")?.addEventListener("change", (e) => {
      this.state.char = e.target.value;
      this.render();
    });
    q("select[name=currentArc]")?.addEventListener("change", async (e) => {
      const ix = Store.index;
      ix.currentArc = e.target.value || null;
      await Store.setIndex(ix);
    });
    for (const input of this.element.querySelectorAll("[data-edit]")) {
      input.addEventListener("change", (e) => this.#onEdit(e.target));
    }
  }

  /* ---------- pieces ---------- */

  #header({ ix }) {
    const arcName = (id) => ix.arcs.find((a) => a.id === id)?.name ?? "No arc";
    const opts = [`<option value="all">Whole campaign</option>`];
    for (const a of ix.arcs) opts.push(`<option value="arc:${a.id}">Arc: ${esc(a.name)}</option>`);
    for (const s of [...ix.sessions].reverse()) opts.push(`<option value="session:${s.id}">${esc(s.name)} · ${fmtDate(s.start)}</option>`);
    const scope = opts.join("").replace(`value="${this.state.scope}"`, `value="${this.state.scope}" selected`);
    const active = ix.sessions.find((s) => s.id === ix.active);
    const live = active
      ? `<span class="pcl-live"><i class="fa-solid fa-circle"></i> Recording ${esc(active.name)} (${esc(arcName(active.arc))})</span>`
      : `<span class="pcl-idle">No session running. One starts by itself on the first roll.</span>`;
    let gm = "";
    if (this.isGM) {
      const arcOpts = [`<option value="">No arc</option>`, ...ix.arcs.map((a) => `<option value="${a.id}" ${a.id === ix.currentArc ? "selected" : ""}>${esc(a.name)}</option>`)].join("");
      gm = `<div class="pcl-gm">
        <label>Current arc <select name="currentArc">${arcOpts}</select></label>
        <button type="button" data-action="addArc"><i class="fa-solid fa-plus"></i> Arc</button>
        ${active ? `<button type="button" data-action="endSession"><i class="fa-solid fa-stop"></i> End session</button>` : ""}
        <button type="button" data-action="startSession"><i class="fa-solid fa-play"></i> New session</button>
        ${game.messages.size && ix.sessions.length ? `<button type="button" data-action="archiveChat" data-tooltip="Copy the chat log into the ledger with ${esc((active ?? archiveTarget())?.name ?? "the session")}, and clear it"><i class="fa-solid fa-box-archive"></i> Archive chat</button>` : ""}
        ${!active && ix.sessions.some((s) => s.end) ? `<button type="button" data-action="resumeSession" data-tooltip="Reopen the last ended session and keep recording into it"><i class="fa-solid fa-rotate-left"></i> Resume last session</button>` : ""}
      </div>`;
    }
    return `<header class="pcl-head">
      <div class="pcl-scope"><label>Showing <select name="scope">${scope}</select></label>
      <button type="button" data-action="refresh" data-tooltip="Reload"><i class="fa-solid fa-rotate"></i></button></div>
      ${live}${gm}</header>`;
  }

  #tabs() {
    const t = [["party", "Party", "fa-users"], ["character", "Characters", "fa-user"], ["encounters", "Encounters", "fa-swords"], ["dice", "Dice", "fa-dice-d20"], ["sessions", "Sessions", "fa-calendar-days"]];
    return `<div class="pcl-tabs">${t.map(([id, label, icon]) => `<a data-action="pclTab" data-tab="${id}" class="${this.state.tab === id ? "active" : ""}"><i class="fa-solid ${icon}"></i> ${label}</a>`).join("")}</div>`;
  }

  #body(ctx) {
    switch (this.state.tab) {
      case "character": return this.#character(ctx);
      case "encounters": return this.#encounters(ctx);
      case "sessions": return this.#sessions(ctx);
      case "dice": return this.#dice(ctx);
      default: return this.#party(ctx);
    }
  }

  #party({ stats, data }) {
    const party = [...stats.values()].filter((a) => a.p);
    if (!party.length) return `<p class="pcl-empty">Nothing recorded for this selection yet.</p>`;
    const { key, dir } = this.state.sort;
    party.sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === "string") return dir * x.localeCompare(y);
      return dir * ((x ?? 0) - (y ?? 0));
    });
    const best = {};
    for (const c of PARTY_COLUMNS) if (!c.text) best[c.key] = Math.max(...party.map((a) => (typeof a[c.key] === "number" ? a[c.key] : -1)));
    const groups = [];
    for (const c of PARTY_COLUMNS) {
      const g = groups.at(-1);
      if (g && g.name === c.group) g.span++;
      else groups.push({ name: c.group, span: 1 });
    }
    const head1 = groups.map((g) => `<th colspan="${g.span}" class="pcl-group">${g.name}</th>`).join("");
    const head2 = PARTY_COLUMNS.map((c) => {
      const arrow = c.key === key ? (dir < 0 ? " ▾" : " ▴") : "";
      return `<th data-action="sort" data-key="${c.key}" ${c.tip ? `data-tooltip="${esc(c.tip)}"` : ""}>${c.label}${arrow}</th>`;
    }).join("");
    const rows = party.map((a) => `<tr>${PARTY_COLUMNS.map((c) => {
      const v = c.fmt ? c.fmt(a) : (a[c.key] ?? 0) || "–";
      const lead = !c.text && party.length > 1 && best[c.key] > 0 && a[c.key] === best[c.key] && !["nat1", "taken", "critTaken", "down", "dead"].includes(c.key);
      const tip = c.tipf ? c.tipf(a) : "";
      return `<td class="${c.text ? "pcl-name" : ""} ${lead ? "pcl-lead" : ""}" ${tip ? `data-tooltip="${esc(tip)}"` : ""}>${v}</td>`;
    }).join("")}</tr>`).join("");
    return this.#highlights(party, data) + `<table class="pcl-table pcl-party"><thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${rows}</tbody></table>
      <p class="pcl-note">Damage and healing are what was applied from a chat card, after resistances; hover for the amount rolled. Damage taken is what came off HP, with any temporary HP that went with it. Click a column to sort.</p>`;
  }

  #highlights(party, data) {
    const top = (key, label, icon, fmt = (a) => a[key]) => {
      const a = [...party].sort((x, y) => (y[key] ?? 0) - (x[key] ?? 0))[0];
      if (!a || !(a[key] > 0)) return "";
      return `<div class="pcl-card"><i class="fa-solid ${icon}"></i><div><span class="pcl-card-label">${label}</span><strong>${esc(a.n)}</strong><span class="pcl-card-sub">${fmt(a)}</span></div></div>`;
    };
    const encs = data.encounters.length;
    return `<div class="pcl-cards">
      <div class="pcl-card"><i class="fa-solid fa-calendar"></i><div><span class="pcl-card-label">Sessions</span><strong>${data.sessions.length}</strong><span class="pcl-card-sub">${encs} encounter${encs === 1 ? "" : "s"}</span></div></div>
      ${top("dealtBest", "Biggest hit", "fa-burst", (a) => `${a.dealtBest}${a.dealtBestIt ? ` · ${esc(a.dealtBestIt)}` : ""}`)}
      ${top("crit", "Most crits", "fa-bullseye")}
      ${top("kills", "Most kills", "fa-skull")}
      ${top("nat20", "Most natural 20s", "fa-dice-d20")}
      ${top("nat1", "Most natural 1s", "fa-face-grimace")}
      ${top("taken", "Took the most", "fa-shield-halved")}
      ${top("healDone", "Most healing", "fa-heart-pulse")}
      ${top("spellN", "Most spells", "fa-wand-sparkles")}
      ${top("skillPass", "Most skill successes", "fa-hand-sparkles")}
    </div>`;
  }

  #character({ stats }) {
    const party = [...stats.values()].filter((a) => a.p).sort((a, b) => a.n.localeCompare(b.n));
    if (!party.length) return `<p class="pcl-empty">Nothing recorded for this selection yet.</p>`;
    if (!party.some((a) => a.k === this.state.char)) this.state.char = party[0].k;
    const a = stats.get(this.state.char);
    const select = `<select name="char">${party.map((p) => `<option value="${p.k}" ${p.k === a.k ? "selected" : ""}>${esc(p.n)}</option>`).join("")}</select>`;
    const table = (cols, rows) => rows.length
      ? `<table class="pcl-table"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td class="${i === 0 ? "pcl-name" : ""}">${v}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : `<p class="pcl-empty">None yet.</p>`;
    const weapons = Object.entries(a.weapons).sort((x, y) => y[1].n - x[1].n)
      .map(([n, w]) => [esc(n), w.n || "–", pct(w.hit, w.known), w.crit || "–", w.dealt || "–", w.dmg || "–"]);
    const saves = SAVES.map((s) => [titleCase(s), a.saves[s][0] || "–", pct(a.saves[s][1], a.saves[s][3]), a.saves[s][2] || "–"]);
    const skills = Object.entries(a.skills).sort((x, y) => y[1].n - x[1].n)
      .map(([s, v]) => [esc(skillLabel(s)), v.n, v.known ? pct(v.pass, v.known) : "–", v.nat20 || "–", v.nat1 || "–"]);
    const abilities = Object.entries(a.abilities).sort((x, y) => y[1].n - x[1].n).map(([n, v]) => [esc(n), v.n]);
    const spells = Object.entries(a.spells).sort((x, y) => y[1].n - x[1].n)
      .map(([n, s]) => [esc(n), s.n, s.ca ? "Cantrip" : s.fo ? "Focus" : s.rk ? `Rank ${s.rk}` : "–"]);
    const kills = Object.entries(a.killed).sort((x, y) => y[1] - x[1]).map(([n, c]) => `${esc(n)}${c > 1 ? ` ×${c}` : ""}`).join(", ");
    const fact = (label, value) => `<div class="pcl-fact"><span>${label}</span><strong>${value}</strong></div>`;
    return `<div class="pcl-char-head"><label>Character ${select}</label></div>
      <div class="pcl-facts">
        ${fact("Encounters", a.encounters.size)}
        ${fact("Attacks", `${a.atk} · ${pct(a.hit, a.atkKnown)} hit`)}
        ${fact("Crits", `${a.crit} dealt · ${a.critTaken} taken`)}
        ${fact("Damage dealt", `${a.dealt} · ${a.dmg} rolled${a.dealtBest ? ` · best ${a.dealtBest}` : ""}`)}
        ${fact("Damage taken", `${a.taken}${a.takenBest ? ` · worst ${a.takenBest}${a.takenBestBy ? ` (${esc(a.takenBestBy)})` : ""}` : ""}`)}
        ${fact("Healing", `${a.healDone} given (${a.heal} rolled) · ${a.healed} received`)}
        ${fact("Downed", `${a.down}${a.dyingMax ? ` · worst dying ${a.dyingMax}` : ""}${a.dead ? ` · died ${a.dead}` : ""}`)}
        ${fact("Recovery checks", a.rec ? `${a.recPass}/${a.rec} passed` : "–")}
        ${fact("Revived allies", a.revivedBy)}
        ${fact("Natural 20s / 1s", `${a.nat20} / ${a.nat1}`)}
        ${fact("Hero Points spent", a.hero)}
        ${fact("Focus Points spent", a.focus)}
      </div>
      <div class="pcl-grid">
        <div><h3>Attacks</h3>${table(["Weapon or spell", "Attacks", "Hit %", "Crits", "Dealt", "Rolled"], weapons)}</div>
        <div><h3>Saving throws</h3>${table(["Save", "Rolls", "Passed", "Crit fails"], saves)}</div>
        <div><h3>Skills</h3>${table(["Skill", "Rolls", "Passed", "Nat 20", "Nat 1"], skills)}</div>
        <div><h3>Spells cast</h3>${table(["Spell", "Casts", "Kind"], spells)}</div>
        <div><h3>Abilities used</h3>${table(["Action or feat", "Uses"], abilities)}</div>
      </div>
      <h3>Kills</h3><p>${kills || "None yet."}</p>`;
  }

  #encounters({ data, ix }) {
    if (!data.encounters.length) return `<p class="pcl-empty">No encounters recorded for this selection yet.</p>`;
    const sessName = (id) => ix.sessions.find((s) => s.id === id)?.name ?? "";
    // Events grouped by encounter once, not once per encounter
    const byEnc = new Map();
    for (const e of data.events) if (e.e) (byEnc.get(e.e) ?? byEnc.set(e.e, []).get(e.e)).push(e);
    const rows = [...data.encounters].sort((a, b) => b.start - a.start).map((enc) => {
      const evs = byEnc.get(enc.id) ?? [];
      const st = aggregate(evs);
      const side = (p) => [...st.values()].filter((a) => a.p === p);
      const sum = (arr, k) => arr.reduce((x, a) => x + (a[k] ?? 0), 0);
      const party = side(true), foes = side(false);
      const open = this.state.enc === enc.id;
      let detail = "";
      if (open) {
        const list = this.isGM ? [...party, ...foes] : party;
        detail = `<tr class="pcl-detail"><td colspan="10"><table class="pcl-table"><thead><tr><th>Combatant</th><th>Attacks</th><th>Hit %</th><th>Crits</th><th>Damage</th><th data-tooltip="Spells cast">Spells</th><th data-tooltip="Saves forced on the other side: failed / rolled">Saves forced</th><th data-tooltip="Skill checks that succeeded / against a DC">Skills</th><th data-tooltip="Actions and feats used">Abilities</th><th>Healing</th><th>Taken</th><th>Kills</th><th>Downed</th></tr></thead><tbody>
          ${list.map((a) => `<tr class="${a.p ? "" : "pcl-foe"}"><td class="pcl-name">${esc(a.n)}</td><td>${a.atk || "–"}</td><td>${pct(a.hit, a.atkKnown)}</td><td>${a.crit || "–"}</td><td>${a.dealt || "–"}</td><td>${a.spellN || "–"}</td><td>${a.forced ? `${a.forcedFail}/${a.forced}` : "–"}</td><td>${a.skillN ? `${a.skillPass}/${a.skillKnown}` : "–"}</td><td>${a.abilityN || "–"}</td><td>${a.healDone || "–"}</td><td>${a.taken || "–"}</td><td>${a.kills || "–"}</td><td>${a.down || "–"}</td></tr>`).join("")}
          </tbody></table>${this.#roundLog(evs)}</td></tr>`;
      }
      return `<tr class="pcl-click" data-action="encounter" data-id="${enc.id}">
        <td>${fmtDate(enc.start)}</td><td>${esc(sessName(enc.sid))}</td><td class="pcl-name">${esc(enc.name || enc.scene)}${this.isGM ? ` <a data-action="renameEncounter" data-id="${enc.id}" data-sid="${enc.sid}" data-tooltip="Rename this encounter"><i class="fa-solid fa-pencil"></i></a>` : ""}</td>
        <td>${enc.rounds}</td><td>${fmtDuration((enc.end ?? now()) - enc.start)}${enc.end ? "" : " (running)"}</td>
        <td>${sum(party, "dealt") || "–"}</td><td>${sum(foes, "dealt") || "–"}</td><td>${sum(party, "kills") || "–"}</td>
        <td>${sum(party, "down") || "–"}</td><td>${sum(party, "crit")} / ${sum(foes, "crit")}</td></tr>${detail}`;
    }).join("");
    return `<table class="pcl-table pcl-enc"><thead><tr><th>Date</th><th>Session</th><th>Encounter</th><th>Rounds</th><th>Length</th><th>Party damage</th><th>Enemy damage</th><th>Foes felled</th><th>PCs downed</th><th>Crits (party / foes)</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="pcl-note">Click an encounter for the breakdown.${this.isGM ? " Enemy rows are shown to the GM only." : ""}</p>`;
  }

  #roundLog(evs) {
    const lines = evs
      .filter((e) => e.r && (this.isGM || e.a?.p))
      .sort((x, y) => x.r - y.r || (x.t ?? 0) - (y.t ?? 0))
      .map((e) => ({ r: e.r, html: describe(e), foe: !e.a?.p }))
      .filter((l) => l.html);
    if (!lines.length) return "";
    const rounds = [];
    for (const l of lines) {
      if (rounds.at(-1)?.r !== l.r) rounds.push({ r: l.r, lines: [] });
      rounds.at(-1).lines.push(l);
    }
    return `<h3>Round by round</h3><div class="pcl-log">${rounds.map((g) => `<div class="pcl-round"><h4>Round ${g.r}</h4><ul>${g.lines.map((l) => `<li class="${l.foe ? "pcl-foe-line" : ""}">${l.html}</li>`).join("")}</ul></div>`).join("")}</div>`;
  }

  #dice({ data }) {
    const KINDS = [["all", "All checks"], ["atk", "Attacks"], ["save", "Saves"], ["skill", "Skills"], ["perc", "Perception and initiative"], ["rec", "Recovery checks"]];
    const all = diceData(data.events);
    const kind = this.state.diceKind;
    const valsFor = (entries) => entries.flatMap((x) => x.rolls.filter((r) => kind === "all" || r.kind === kind).map((r) => r.v));
    const party = [...all.values()].filter((x) => x.p).sort((a, b) => a.n.localeCompare(b.n));
    const foes = [...all.values()].filter((x) => !x.p);
    const who = [["party", "Whole party", party], ...party.map((x) => [x.k, x.n, [x]])];
    if (this.isGM) who.push(["foes", "Enemies", foes]);
    if (!who.some(([k]) => k === this.state.diceWho)) this.state.diceWho = "party";
    const [, label, entries] = who.find(([k]) => k === this.state.diceWho);
    const st = diceStats(valsFor(entries));
    const list = who.map(([k, n]) => `<a data-action="diceWho" data-who="${esc(k)}" class="${k === this.state.diceWho ? "active" : ""}">${esc(n)}</a>`).join("");
    const kinds = KINDS.map(([k, n]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${n}</option>`).join("");
    const tile = (l, v) => `<div class="pcl-tile"><span>${l}</span><strong>${v}</strong></div>`;
    const main = st
      ? `<div class="pcl-tiles">${tile("Rolls", st.n)}${tile("Average", st.mean.toFixed(1))}${tile("Median", st.median)}${tile("Most common", st.mode)}${tile("Natural 20s", st.nat20)}${tile("Natural 1s", st.nat1)}${tile("Luck", luckText(st))}</div>
         <figure class="pcl-chart" aria-label="How often ${esc(label)} rolled each number on the d20">${histogram(st)}</figure>`
      : `<p class="pcl-empty">No d20 rolls for this selection yet.</p>`;
    const rows = [...party, ...(this.isGM && foes.length ? [{ k: "foes", n: "Enemies", p: false, group: foes }] : [])]
      .map((x) => ({ n: x.n, foe: !x.p, st: diceStats(valsFor(x.group ?? [x])) }))
      .filter((x) => x.st)
      .sort((a, b) => b.st.mean - a.st.mean);
    const table = rows.length
      ? `<h3>Who's rolling well</h3><table class="pcl-table"><thead><tr><th>Character</th><th>Rolls</th><th>Average</th><th>Luck</th><th>Nat 20</th><th>Nat 1</th></tr></thead><tbody>${rows.map((x) => `<tr class="${x.foe ? "pcl-foe" : ""}"><td class="pcl-name">${esc(x.n)}</td><td>${x.st.n}</td><td>${x.st.mean.toFixed(1)}</td><td>${luckText(x.st)}</td><td>${x.st.nat20 || "–"}</td><td>${x.st.nat1 || "–"}</td></tr>`).join("")}</tbody></table>`
      : "";
    return `<div class="pcl-dice">
        <nav class="pcl-dice-list">${list}</nav>
        <div class="pcl-dice-main"><div class="pcl-dice-top"><strong>${esc(label)}</strong><label>Rolls <select name="diceKind">${kinds}</select></label></div>${main}</div>
      </div>${table}
      <p class="pcl-note">Every d20 counts, including the first roll of a reroll. Fortune and misfortune rolls (roll twice, keep one) are left out because they skew the curve. The dashed line is what a fair die would average for this many rolls. Luck is the average minus 10.5.</p>`;
  }

  #sessions({ ix }) {
    const chatIcon = (s) => {
      const n = this.isGM ? archivesOf(s.id).reduce((t, a) => t + a.n, 0) : playersReadChat() ? (s.chat ?? []).reduce((t, a) => t + a.n, 0) : 0;
      return n ? `<a data-action="viewChat" data-id="${s.id}" data-tooltip="Archived chat (${n} message${n === 1 ? "" : "s"})"><i class="fa-solid fa-comments"></i></a> ` : "";
    };
    const arcOpts = (sel) => [`<option value="">No arc</option>`, ...ix.arcs.map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.name)}</option>`)].join("");
    const rows = [...ix.sessions].reverse().map((s) => {
      const name = this.isGM ? `<input type="text" data-edit="sessionName" data-id="${s.id}" value="${esc(s.name)}">` : esc(s.name);
      const arc = this.isGM ? `<select data-edit="sessionArc" data-id="${s.id}">${arcOpts(s.arc)}</select>` : esc(ix.arcs.find((a) => a.id === s.arc)?.name ?? "–");
      const state = s.id === ix.active ? `<span class="pcl-live"><i class="fa-solid fa-circle"></i> Recording</span>` : fmtDuration((s.end ?? s.start) - s.start);
      const gm = this.isGM
        ? `<a data-action="recap" data-id="${s.id}" data-tooltip="Post a recap to chat"><i class="fa-solid fa-scroll"></i></a> <a data-action="deleteSession" data-id="${s.id}" data-tooltip="Delete session"><i class="fa-solid fa-trash"></i></a>`
        : "";
      return `<tr><td class="pcl-name">${name}</td><td>${arc}</td><td>${fmtDate(s.start)}</td><td>${state}</td>
        <td><a data-action="viewSession" data-id="${s.id}" data-tooltip="Show this session"><i class="fa-solid fa-eye"></i></a> ${chatIcon(s)}${gm}</td></tr>`;
    }).join("");
    const arcs = this.isGM
      ? `<h3>Arcs</h3><table class="pcl-table pcl-arcs"><tbody>${ix.arcs.map((a) => `<tr><td><input type="text" data-edit="arcName" data-id="${a.id}" value="${esc(a.name)}"></td><td>${((n) => `${n} session${n === 1 ? "" : "s"}`)(ix.sessions.filter((s) => s.arc === a.id).length)}</td></tr>`).join("") || `<tr><td>No arcs yet. Add one with the Arc button above.</td></tr>`}</tbody></table>`
      : "";
    const tools = this.isGM
      ? `<div class="pcl-tools"><button type="button" data-action="exportData"><i class="fa-solid fa-file-export"></i> Export everything</button>
         <button type="button" data-action="importData" data-tooltip="Restore sessions and arcs from an export. Nothing already here is removed."><i class="fa-solid fa-file-import"></i> Import</button>
         <button type="button" data-action="reset" class="pcl-danger"><i class="fa-solid fa-trash-can"></i> Reset ledger</button></div>`
      : "";
    return `${ix.sessions.length ? `<table class="pcl-table pcl-sessions"><thead><tr><th>Session</th><th>Arc</th><th>Date</th><th>Length</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="pcl-empty">No sessions yet.</p>`}${arcs}${tools}`;
  }

  /* ---------- handlers ---------- */

  async #onEdit(target) {
    if (!game.user.isGM) return;
    const ix = Store.index;
    const { edit, id } = target.dataset;
    if (edit === "sessionName") {
      const s = ix.sessions.find((s) => s.id === id);
      if (s) s.name = target.value.trim() || s.name;
    } else if (edit === "sessionArc") {
      const s = ix.sessions.find((s) => s.id === id);
      if (s) s.arc = target.value || null;
    } else if (edit === "arcName") {
      const a = ix.arcs.find((a) => a.id === id);
      if (a) a.name = target.value.trim() || a.name;
    }
    await Store.setIndex(ix);
    this.render();
  }

  static #onTab(event, target) {
    this.state.tab = target.dataset.tab;
    this.render();
  }

  static #onSort(event, target) {
    const key = target.dataset.key;
    const s = this.state.sort;
    if (s.key === key) s.dir *= -1;
    else Object.assign(s, { key, dir: key === "n" ? 1 : -1 });
    this.render();
  }

  static #onEncounter(event, target) {
    this.state.enc = this.state.enc === target.dataset.id ? null : target.dataset.id;
    this.render();
  }

  static async #onRenameEncounter(event, target) {
    if (!game.user.isGM) return;
    const { id, sid } = target.dataset;
    const data = await Store.load(sid);
    const enc = data.encounters.find((e) => e.id === id);
    if (!enc) return;
    const name = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Rename encounter" },
      content: `<p>A name for this encounter (players see it). Leave it empty to go back to the scene name.</p><input type="text" name="name" value="${esc(enc.name ?? "")}" placeholder="${esc(enc.scene)}" autofocus>`,
      ok: { label: "Rename", callback: (ev, button) => button.form.elements.name.value.trim() },
    });
    if (name === null || name === undefined) return;
    if (name) enc.name = name;
    else delete enc.name;
    await Store.save(sid);
    await Store.setIndex(Store.index);
    this.render();
  }

  static async #onStartSession() {
    if (!game.user.isGM) return;
    const s = await startSession();
    this.state.scope = `session:${s.id}`;
    this.render();
  }

  static async #onEndSession() {
    if (!game.user.isGM) return;
    const s = Store.index.sessions.find((s) => s.id === Store.index.active);
    if (!s) return;
    const n = game.messages.size;
    const offer = n > 0 && game.settings.get(MOD, "archiveOffer");
    const box = offer ? `<label class="pcl-check"><input type="checkbox" name="archive" checked> Archive the chat log with this session and clear it (${n} message${n === 1 ? "" : "s"})</label>` : "";
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: "End session" },
      content: `<p>End <strong>${esc(s.name)}</strong>? The next roll starts a new session${game.settings.get(MOD, "recap") === "all" ? ", and the recap goes to everyone" : ""}.</p>${box}`,
      buttons: [
        { action: "end", label: "End session", icon: "fa-solid fa-stop", default: true, callback: (ev, button) => ({ archive: !!button.form.elements.archive?.checked }) },
        { action: "cancel", label: "Cancel" },
      ],
      rejectClose: false,
    });
    if (!choice || choice === "cancel") return;
    if (Store.index.active !== s.id) {
      ui.notifications.warn(`Campaign Ledger: ${s.name} had already ended.`);
      return this.render();
    }
    await endSession({ archive: choice.archive });
    this.render();
  }

  static async #onResumeSession() {
    if (!game.user.isGM) return;
    const s = await resumeSession();
    if (!s) return ui.notifications.warn("Campaign Ledger: there is no ended session to resume.");
    this.state.scope = `session:${s.id}`;
    this.render();
  }

  static async #onAddArc() {
    if (!game.user.isGM) return;
    const ix = Store.index;
    const arc = { id: uid(), name: `Arc ${ix.arcs.length + 1}` };
    ix.arcs.push(arc);
    ix.currentArc = arc.id;
    await Store.setIndex(ix);
    ui.notifications.info(`Campaign Ledger: added ${arc.name} and made it the current arc. Rename it on the Sessions tab.`);
    this.render();
  }

  static async #onRecap(event, target) {
    if (!game.user.isGM) return;
    await Store.flushNow();
    const ok = await postRecap(target.dataset.id, { manual: true });
    if (!ok) ui.notifications.info("Campaign Ledger: nothing was recorded in that session.");
  }

  static #onDiceWho(event, target) {
    this.state.diceWho = target.dataset.who;
    this.render();
  }

  static async #onDeleteSession(event, target) {
    if (!game.user.isGM) return;
    const ix = Store.index;
    const s = ix.sessions.find((s) => s.id === target.dataset.id);
    if (!s) return;
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: "Delete session" }, content: `<p>Delete <strong>${esc(s.name)}</strong> and everything recorded in it? This can't be undone from the ledger (its file stays on disk, and an export can bring it back with Import).</p>` });
    if (!ok) return;
    ix.sessions = ix.sessions.filter((x) => x.id !== s.id);
    if (ix.active === s.id) {
      ix.active = null;
      Rec.encounter = null;
    }
    Store.forget(s.id);
    await Store.setIndex(ix);
    this.state.scope = "all";
    this.render();
  }

  static async #onExport() {
    if (!game.user.isGM) return;
    await Store.flushNow();
    const ix = Store.index;
    const sessions = await Promise.all(ix.sessions.map((s) => Store.load(s.id)));
    const blob = JSON.stringify({ module: MOD, exported: now(), index: ix, sessions }, null, 1);
    foundry.utils.saveDataToFile(blob, "application/json", `campaign-ledger-${new Date().toISOString().slice(0, 10)}.json`);
  }

  static async #onImport() {
    if (!game.user.isGM) return;
    const file = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Import a Campaign Ledger export" },
      content: `<p>Pick a file made by "Export everything". Sessions and arcs it holds are added; ones already in the ledger get any events they're missing. Nothing is deleted.</p><input type="file" name="file" accept=".json,application/json">`,
      ok: { label: "Import", callback: (ev, button) => button.form.elements.file.files[0] ?? null },
    });
    if (!file) return;
    try {
      const { added, merged } = await importLedger(await file.text());
      ui.notifications.info(`Campaign Ledger: imported ${added} new session${added === 1 ? "" : "s"}, merged ${merged}.`);
    } catch (e) {
      console.error(MOD, e);
      ui.notifications.error(`Campaign Ledger: couldn't import (${e.message}).`);
    }
    this.render();
  }

  static async #onReset() {
    if (!game.user.isGM) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Reset Campaign Ledger" },
      content: "<p>This clears every session, arc and encounter from the ledger. A full export downloads first so nothing is lost for good; Import brings it back.</p><p>Reset the ledger?</p>",
    });
    if (!ok) return;
    await LedgerApp.#onExport.call(this);
    Store.cache.clear();
    Rec.encounter = null;
    await Store.setIndex(foundry.utils.deepClone(DEFAULT_INDEX));
    this.state.scope = "all";
    ui.notifications.info("Campaign Ledger: reset. The export is in your downloads.");
    this.render();
  }

  static async #onRefresh() {
    if (!game.user.isGM) Store.cache.clear();
    this.render();
  }

  static async #onArchiveChat() {
    if (!game.user.isGM) return;
    const s = archiveTarget();
    const n = game.messages.size;
    if (!s || !n) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Archive chat" },
      content: `<p>Copy the chat log (${n} message${n === 1 ? "" : "s"}) into the ledger with <strong>${esc(s.name)}</strong> and clear it from chat? The archive opens from the speech bubbles on the Sessions tab.</p>`,
    });
    if (!ok) return;
    await Store.flushNow();
    await archiveChat(s.id, { clear: true });
    this.render();
  }

  static #onViewChat(event, target) {
    ChatArchiveApp.open(target.dataset.id);
  }

  static #onViewSession(event, target) {
    this.state.scope = `session:${target.dataset.id}`;
    this.state.tab = "party";
    this.render();
  }

  static open() {
    if (!game.user.isGM && !game.settings.get(MOD, "playerView")) return ui.notifications.warn("The GM hasn't opened the Campaign Ledger to players.");
    const existing = [...openApps][0];
    if (existing) return existing.render({ force: true });
    return new LedgerApp().render({ force: true });
  }
}

/** The settings menu makes its own window of whatever type it's given; this one just opens the ledger the normal way. */
class LedgerMenu extends foundry.applications.api.ApplicationV2 {
  render() {
    LedgerApp.open();
    return this;
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                       */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  game.settings.register(MOD, "index", { scope: "world", config: false, type: Object, default: foundry.utils.deepClone(DEFAULT_INDEX) });
  game.settings.register(MOD, "recording", {
    name: "Record statistics",
    hint: "Record rolls, damage, healing and combat to the ledger. Turn off for test rolls or one-shots.",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "playerView", {
    name: "Players can open the ledger",
    hint: "Players get a read-only view of party statistics. Enemy breakdowns stay GM-only.",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => { refreshOpenApps(); ChatArchiveApp.refresh(); },
  });
  game.settings.register(MOD, "startNotice", {
    name: "Whisper when recording starts",
    hint: "When a session starts recording (on the first roll, or with New session), whisper the GM a note in chat.",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "recap", {
    name: "Session recap",
    hint: "When a session ends, post a short recap card to chat: biggest hit, crits, kills, who went down and who brought them back.",
    scope: "world", config: true, type: String, default: "all",
    choices: { all: "Post to everyone", gm: "Whisper to the GM", off: "Don't post" },
  });
  game.settings.register(MOD, "archiveOffer", {
    name: "Offer to archive the chat at End session",
    hint: "End session offers to copy the chat log into the ledger with the session and clear it (ticked by default). Archived chat opens from the Sessions tab. The GM's copy includes whispers; like GM journals, it's out of the players' view but not out of reach of a player who digs in the browser console.",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "archivePlayers", {
    name: "Players can read the archived chat",
    hint: "When players can open the ledger, they can also read archived chat: their copy holds only messages everyone saw, without whispers, blind rolls or what PF2e shows the GM alone (DCs, modifiers, roll formulas).",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => { refreshOpenApps(); ChatArchiveApp.refresh(); },
  });
  game.settings.register(MOD, "sessionGap", {
    name: "Hours between sessions",
    hint: "A session nobody ended is ended by itself when the next roll comes this many hours after its last one, and a new session starts. 0 turns this off.",
    scope: "world", config: true, type: Number, default: 10,
  });
  game.settings.registerMenu(MOD, "open", {
    name: "Campaign Ledger", label: "Open the ledger", icon: "fa-solid fa-book-open-reader", type: LedgerMenu, restricted: false,
  });
});

Hooks.once("ready", () => {
  game.modules.get(MOD).api = { open: () => LedgerApp.open(), startSession, endSession, resumeSession, importLedger, Store, aggregate, archiveChat, archivesOf, publicArchivesOf, rebuildChatIndex, viewChat: (id) => ChatArchiveApp.open(id) };
  lastActive = Store.index.active;
  primeCaches();
  repairPublicArchives().catch((e) => console.error(MOD, e));
  if (isRecorder() && game.combat?.started) {
    activeSession({ create: false }).then(async (s) => {
      if (!s) return;
      const data = await Store.load(s.id);
      if (data.encounters.some((e) => e.id === game.combat.id && !e.end)) Rec.encounter = game.combat.id;
    });
  }
});

Hooks.on("canvasReady", () => primeCaches());
Hooks.on("createToken", (t) => t.actor && Rec.hp.set(t.actor.uuid, hpSnap(t.actor)) && Rec.res.set(t.actor.uuid, resSnap(t.actor)));
Hooks.on("createChatMessage", (msg) => {
  sampleClock(msg);
  onChatMessage(msg).catch((e) => console.error(MOD, e));
});
Hooks.on("updateChatMessage", (msg, changes) => onUpdateChatMessage(msg, changes).catch((e) => console.error(MOD, e)));
Hooks.on("updateActor", (a, c, o) => onUpdateActor(a, c, o).catch((e) => console.error(MOD, e)));
Hooks.on("createItem", (i) => onDying(i).catch((e) => console.error(MOD, e)));
Hooks.on("updateItem", (i, c) => onDying(i, c ?? {}).catch((e) => console.error(MOD, e)));
Hooks.on("combatStart", (c) => onCombatStart(c).catch((e) => console.error(MOD, e)));
Hooks.on("updateCombat", (c, ch) => onUpdateCombat(c, ch).catch((e) => console.error(MOD, e)));
Hooks.on("createCombatant", (c) => onCreateCombatant(c).catch((e) => console.error(MOD, e)));
Hooks.on("deleteCombat", (c) => onDeleteCombat(c).catch((e) => console.error(MOD, e)));

let lastActive = null;
Hooks.on("updateSetting", (setting) => {
  if (setting.key !== `${MOD}.index`) return;
  if (!game.user.isGM) {
    // Players refetch the running session, and the one that just ended (its final save lands after the index)
    const active = Store.index.active;
    for (const id of new Set([active, lastActive])) if (id) Store.forget(id);
    lastActive = active;
  }
  refreshOpenApps();
  if (!game.user.isGM) ChatArchiveApp.refresh();
});

Hooks.on("updateJournalEntry", (j) => {
  if (!j.flags?.[MOD]?.gmStore) return;
  refreshOpenApps();
  ChatArchiveApp.refresh();
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM && !game.settings.get(MOD, "playerView")) return;
  const tools = controls.tokens?.tools;
  if (!tools) return;
  tools.campaignLedger = {
    name: "campaignLedger",
    title: "Campaign Ledger",
    icon: "fa-solid fa-book-open-reader",
    order: Object.keys(tools).length,
    button: true,
    visible: true,
    onChange: () => LedgerApp.open(),
  };
});
