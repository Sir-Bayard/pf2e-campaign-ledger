import { esc } from "./kit/safe-text.mjs";
import { DEFAULT_INDEX, FP, L, MOD, SAVE_EVERY, SKIP, fileDir, now } from "./constants.mjs";
import { leading, loseLead, tabs } from "./lead.mjs";
import { storeSummaries, summaryValue } from "./recap.mjs";
import { hashOf } from "./recorder.mjs";

/* The session files and the index of sessions and arcs. */

/** The id an event from before 1.1.1 (which has none) gets from its content: the same on every read. */
function contentId(e) {
  const text = JSON.stringify(e);
  return `h${hashOf(text)}${hashOf(`~${text}`)}`;
}

/**
 * Adds to `data` what `disk` (the same session as saved on the server) has and `data` lacks: events by id and
 * encounters by id; what `data` has wins. Events taken back by either copy (`dropped` here, `disk.dropped` there)
 * stay out of both, and the list of them is kept in the file so a later merge doesn't bring them back either.
 */
function mergeInto(data, disk, dropped = null) {
  const gone = new Set([...(dropped ?? []), ...(Array.isArray(data.dropped) ? data.dropped : []), ...(Array.isArray(disk.dropped) ? disk.dropped : [])]);
  if (gone.size) {
    data.events = data.events.filter((e) => !gone.has(e.id));
    data.dropped = [...gone];
  }
  const have = new Set(data.events.map((e) => e.id));
  let added = false;
  for (const e of disk.events) {
    if (have.has(e.id) || gone.has(e.id)) continue;
    data.events.push(e);
    added = true;
  }
  if (added) data.events.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  for (const enc of disk.encounters) if (enc?.id && !data.encounters.some((x) => x.id === enc.id)) data.encounters.push(enc);
}

/**
 * Tell the other clients that session files changed, so players (and the GM's other tabs) read them again. A socket
 * message rather than a write to the index setting, which every client would store.
 */
function announceSaved(ids) {
  if (!ids.length) return;
  try {
    game.socket.emit(`module.${MOD}`, { type: "saved", ids });
  } catch (e) {
    console.warn(MOD, e);
  }
}

const Store = {
  cache: new Map(),
  timer: null,
  dirReady: false,
  fixes: 0, // bumped when events change in place (a correction), so the Sessions tab's summaries are worked out again
  rev: 0, // bumped whenever the data the dashboard shows may have changed; open windows re-render only when it moved

  get index() {
    return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_INDEX), game.settings.get(MOD, "index") ?? {});
  },

  /**
   * Every change to the index goes through here, one at a time: fn gets the index as it is once the write before it
   * has landed and changes it in place, so two changes at once can't undo each other. Resolves to what fn returns;
   * fn returning SKIP writes nothing.
   */
  indexChain: Promise.resolve(),
  mutateIndex(fn) {
    const run = this.indexChain.then(async () => {
      const ix = this.index;
      const out = fn(ix);
      if (out === SKIP) return undefined;
      ix.updated = now();
      await game.settings.set(MOD, "index", ix);
      return out;
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

  /**
   * The session file as it is on the server: { events, encounters }, or null when it hasn't been saved yet. Throws on
   * anything else (server down, a half-written file), so an unread file is never taken for an empty one. Events from
   * before 1.1.1 have no id; they get one from their content, the same each time, so two copies of the file agree.
   */
  async readFile(id) {
    const res = await fetch(`${this.path(id)}?t=${now()}`, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error(`${this.file(id)} is unreadable: ${e.message}`);
    }
    data.events = Array.isArray(data?.events) ? data.events : [];
    data.encounters = Array.isArray(data?.encounters) ? data.encounters : [];
    for (const e of data.events) if (e && typeof e === "object") e.id ??= contentId(e);
    data.events = data.events.filter((e) => e && typeof e === "object");
    return data;
  },

  // Loads in flight, so two events at once on a session not read yet share one read (and one copy)
  loading: new Map(),
  async load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    if (this.loading.has(id)) return this.loading.get(id);
    const run = (async () => {
      let disk;
      try {
        disk = await this.readFile(id);
      } catch (e) {
        const running = id === game.settings.get(MOD, "index")?.active;
        if (running && !this.readFailed++ && game.user.isGM) ui.notifications.error(L("ReadFailedRunning", { error: esc(e.message) }), { permanent: true });
        else if (!running && game.user.isGM) ui.notifications.warn(L("ReadFailedOld", { error: esc(e.message) }));
        else console.warn(MOD, `couldn't read session ${id}`, e);
        throw new Error(`Campaign Ledger: couldn't read session ${id} (${e.message})`);
      }
      this.readFailed = 0;
      const data = { ...(disk ?? {}), id, events: disk?.events ?? [], encounters: disk?.encounters ?? [] };
      if (!this.cache.has(id)) this.cache.set(id, data);
      return this.cache.get(id);
    })();
    this.loading.set(id, run);
    try {
      return await run;
    } finally {
      this.loading.delete(id);
    }
  },

  // Event ids taken back (Revert) per session, so a merge with the file doesn't bring them back
  dropped: new Map(),
  drop(id, events) {
    const set = this.dropped.get(id) ?? new Set();
    for (const e of events) if (e.id) set.add(e.id);
    this.dropped.set(id, set);
    const data = this.cache.get(id);
    if (data) data.dropped = [...new Set([...(Array.isArray(data.dropped) ? data.dropped : []), ...set])];
  },

  forget(id) {
    this.cache.delete(id);
    this.mine.delete(id);
  },

  // Sessions whose file this tab wrote last (another client's "saved" takes one off; see saveOnce)
  mine: new Set(),

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
  dirty: new Set(), // sessions with changes not saved yet

  /**
   * Upload a session's file. Only the recording client writes the running session: another GM tab, or another GM,
   * may hold an older copy (`force` is for a tab handing over its last events). Whatever another tab saved since this
   * copy was read (a hand-over between tabs) is kept: events and encounters this copy lacks are added from the file,
   * except events taken back here. Returns true when saved.
   */
  // Saves of the same session run one after another, so an older copy never lands after a newer one
  saving: new Map(),
  save(id, opts = {}) {
    const run = (this.saving.get(id) ?? Promise.resolve()).then(() => this.saveOnce(id, opts));
    const tail = run.catch(() => {});
    this.saving.set(id, tail);
    tail.then(() => {
      if (this.saving.get(id) === tail) this.saving.delete(id);
    });
    return run;
  },

  async saveOnce(id, { force = false } = {}) {
    const data = this.cache.get(id);
    if (!data) return false;
    if (!force && id === this.index.active && !tabs.isLead()) return false;
    // Off the list now: an event recorded while this save is under way puts it back, so it's saved next time
    this.dirty.delete(id);
    await this.ensureDir();
    let ok = false;
    try {
      // A file this tab wrote last, with no other tab of this GM about, can't hold anything this copy lacks
      const disk = !force && this.mine.has(id) && !tabs.info().others.length ? { events: [], encounters: [] } : await this.readFile(id);
      if (disk) mergeInto(data, disk, this.dropped.get(id));
      const file = new File([JSON.stringify(data)], this.file(id), { type: "application/json" });
      const res = await FP().upload("data", fileDir(), file, {}, { notify: false });
      ok = !!res && res !== false;
      if (ok) {
        this.mine.add(id);
        // An ended session's stored summary follows its file; the recording tab writes it (others' saves reach it as "saved")
        if (tabs.isLead() && this.index.sessions.find((x) => x.id === id)?.end) storeSummaries(new Map([[id, summaryValue(data)]])).catch((e) => console.error(MOD, e));
      }
    } catch (e) {
      console.error(MOD, e);
    }
    if (!ok) {
      // Keep the data in memory and tell the GM once; the next event schedules another try
      this.dirty.add(id);
      if (!this.failed++) ui.notifications.error(L("SaveFailed"), { permanent: true });
    } else {
      if (this.failed) {
        this.failed = 0;
        ui.notifications.info(L("SaveRecovered"));
      }
    }
    return ok;
  },

  /**
   * Save 30 seconds after the first unsaved event, and at once at the end of a round, when combat ends and when the
   * session ends (saveSoon, flushNow): a crash loses at most half a minute, and a long evening isn't uploaded whole
   * every few seconds.
   */
  firstPending: 0,
  scheduleSave(id) {
    this.dirty.add(id);
    this.firstPending ||= now();
    if (this.timer) return;
    this.timer = setTimeout(() => this.saveSoon().catch((e) => console.error(MOD, e)), Math.max(0, this.firstPending + SAVE_EVERY - now()));
  },

  async saveSoon() {
    clearTimeout(this.timer);
    this.timer = null;
    this.firstPending = 0;
    // Another tab took over meanwhile (or this one was frozen): hand over instead
    if (leading && !tabs.isLead()) return loseLead();
    const saved = [];
    for (const d of [...this.dirty]) if (await this.save(d)) saved.push(d);
    announceSaved(saved);
  },

  async flushNow() {
    clearTimeout(this.timer);
    this.timer = null;
    this.firstPending = 0;
    const saved = [];
    for (const id of [...this.dirty]) if (this.cache.has(id) && (await this.save(id))) saved.push(id);
    announceSaved(saved);
  },

  async loadScope(scope) {
    const ix = this.index;
    let sessions = ix.sessions;
    if (scope === "arc:none") sessions = sessions.filter((s) => !s.arc);
    else if (scope?.startsWith("arc:")) sessions = sessions.filter((s) => s.arc === scope.slice(4));
    else if (scope?.startsWith("session:")) sessions = sessions.filter((s) => s.id === scope.slice(8));
    const datas = await Promise.all(sessions.map((s) => this.load(s.id)));
    return {
      sessions,
      events: datas.flatMap((d) => d.events.map((e) => ({ ...e, sid: d.id }))),
      encounters: datas.flatMap((d) => d.encounters.map((e) => ({ ...e, sid: d.id }))),
    };
  },
};


export { contentId, mergeInto, announceSaved, Store };
