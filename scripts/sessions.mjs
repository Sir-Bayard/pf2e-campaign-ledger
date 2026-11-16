import { esc } from "./kit/safe-text.mjs";
import { archiveChat } from "./archive.mjs";
import { L, MOD, SKIP, now, uid } from "./constants.mjs";
import { isRecorder, notRecording, tabs } from "./lead.mjs";
import { postRecap, summaryValue } from "./recap.mjs";
import { Rec } from "./recorder.mjs";
import { Store, announceSaved, contentId } from "./store.mjs";
import { fmtDate } from "./util.mjs";

/* Sessions: starting, ending, resuming and expiring them, and importing an export. */

let starting = null;
let expiring = null;

async function activeSession({ create = true, force = false } = {}) {
  const ix = Store.index;
  const s = ix.sessions.find((s) => s.id === ix.active);
  if (s && create) {
    expiring ??= expireStale(s).finally(() => (expiring = null));
    if (await expiring) return activeSession({ create, force });
  }
  if (s || !create) return s ?? null;
  // The GM rolling on their own (prep between sessions) doesn't start one, unless asked to
  if (!force && game.settings.get(MOD, "needPlayer") && !game.users.some((u) => u.active && !u.isGM)) return null;
  if (starting) return starting;
  starting = (async () => {
    let running = null;
    const made = await Store.mutateIndex((ix) => {
      // A session made running meanwhile (Resume, or another client) is the one to record into
      running = ix.sessions.find((x) => x.id === ix.active) ?? null;
      if (running) return SKIP;
      const fresh = { id: uid(), name: nextSessionName(ix), arc: ix.currentArc ?? null, start: now(), end: null };
      ix.sessions.push(fresh);
      ix.active = fresh.id;
      return fresh;
    });
    if (!made) return running;
    const session = made;
    Store.cache.set(session.id, { id: session.id, events: [], encounters: [] });
    ui.notifications.info(L("NoticeRecording", { name: esc(session.name) }));
    await startNotice(session, Store.index);
    return session;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** "Session N", one past the highest N in use, so a deleted session's number isn't given out twice. */
function nextSessionName(ix) {
  const [before, after] = L("SessionN").split("{n}").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`^${before}(\\d+)${after ?? ""}$`);
  const nums = ix.sessions.map((s) => pattern.exec(String(s.name ?? "").trim())?.[1]).filter(Boolean).map(Number);
  return L("SessionN", { n: nums.length ? Math.max(...nums) + 1 : ix.sessions.length + 1 });
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
  await endSession({ quiet: true, at: last, auto: true });
  // With no player logged in, the GM's roll ends the old session but starts no new one (needPlayer)
  const next = !(game.settings.get(MOD, "needPlayer") && !game.users.some((u) => u.active && !u.isGM));
  const vals = { name: esc(s.name), date: esc(fmtDate(last)) };
  ui.notifications.info(L(next ? "NoticeExpiredNext" : "NoticeExpired", vals));
  await whisperGM(`<h3><i class="fa-solid fa-circle-stop"></i> ${L("WhisperEndedTitle", vals)}</h3><p>${L(next ? "WhisperEndedNext" : "WhisperEnded", vals)}</p>`, { notice: "expired", session: s.id });
  return true;
}

async function whisperGM(html, flags) {
  try {
    await ChatMessage.create({
      content: `<div class="pcl-recap">${html}</div>`,
      speaker: { alias: L("Title") },
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
    `<h3><i class="fa-solid fa-circle-dot"></i> ${L("WhisperRecordingTitle", { name: esc(session.name) })}</h3><p class="pcl-recap-sub">${[arc ? esc(arc) : null, L("StartedAt", { time: esc(when) })].filter(Boolean).join(" · ")}</p><p>${L("WhisperRecording")}</p>`,
    { notice: "start", session: session.id },
  );
}

async function startSession() {
  await endSession({ quiet: true });
  starting = null;
  // Whatever is still marked running (a session started meanwhile) is ended, never just dropped
  await Store.mutateIndex((ix) => {
    if (!ix.active) return SKIP;
    const run = ix.sessions.find((x) => x.id === ix.active);
    if (run && !run.end) run.end = now();
    ix.active = null;
  });
  return activeSession({ force: true });
}

/** Waits (up to about `ms`) for session `id` to stop being the running one; true when it did. */
async function endedSoon(id, ms = 8000) {
  for (let i = 0; i < ms / 200 && Store.index.active === id; i++) await new Promise((r) => setTimeout(r, 200));
  return Store.index.active !== id;
}

/** Ends the running session; with `id`, only if that session is still the running one. */
async function endSession({ id = null, quiet = false, at = null, archive = false, auto = false } = {}) {
  // A tab of the active GM that isn't recording asks the one that is (only it has the session's last few seconds) and
  // waits for the end to land; with no answer, it ends the session itself
  if (!auto && game.users.activeGM?.isSelf && tabs.info().others.length && !(await isRecorder())) {
    const run = Store.index.sessions.find((x) => x.id === (id ?? Store.index.active));
    if (!run || run.id !== Store.index.active) return;
    game.socket.emit(`module.${MOD}`, { type: "end", id: run.id, quiet, archive: !!archive, at });
    if (!quiet) ui.notifications.info(L("NoticeEndingElsewhere", { name: esc(run.name) }));
    if (await endedSoon(run.id)) return;
    id = run.id;
  }
  await Store.flushNow();
  if (id && Store.index.active !== id) return;
  const runId = Store.index.active;
  const data = runId ? await Store.load(runId).catch(() => null) : null;
  const sum = data ? summaryValue(data) : null;
  const s = await Store.mutateIndex((ix) => {
    const run = ix.sessions.find((x) => x.id === ix.active);
    if (!run || (id && run.id !== id)) return SKIP;
    run.end = at ?? now();
    if (sum && run.id === runId) run.sum = sum;
    ix.active = null;
    return run;
  });
  if (!s) return;
  // What the recorder remembered from that session (who hit whom, cards seen) goes with it
  Rec.forget(s.end);
  if (!quiet) ui.notifications.info(L("NoticeEnded", { name: esc(s.name) }));
  // Archived (and cleared) before the recap, so the recap is the first thing in the fresh chat
  if (archive) await archiveChat(s.id, { clear: true });
  if (auto || game.settings.get(MOD, "recap") !== "off") await postRecap(s.id, { auto });
}

/** Reopens the most recently ended session as the active one (for an evening that was ended too soon). */
async function resumeSession() {
  const s = await Store.mutateIndex((ix) => {
    if (ix.active) return SKIP;
    const last = [...ix.sessions].filter((x) => x.end).sort((a, b) => b.end - a.end)[0];
    if (!last) return SKIP;
    last.end = null;
    ix.active = last.id;
    return last;
  });
  if (!s) return null;
  ui.notifications.info(L("NoticeResumed", { name: esc(s.name) }));
  return s;
}

/**
 * Restores an export (the JSON from "Export everything") into the ledger. Sessions and arcs are matched by id:
 * unknown ones are added, known ones get any events and encounters they don't have yet. Nothing is deleted.
 */
async function importLedger(text) {
  let x;
  try {
    x = JSON.parse(text);
  } catch (e) {
    throw new Error(L("ImportNotJson"));
  }
  if (x?.module !== MOD || !x.index?.sessions || !Array.isArray(x.sessions)) throw new Error(L("ImportNotExport"));
  const why = Store.index.active ? await notRecording() : null;
  if (why) throw new Error(L("ImportElsewhere", { why }));
  await Store.flushNow();
  // A session's id becomes its file name, so an id from a hand-edited or foreign file must be a plain one
  const ID = /^[A-Za-z0-9]{1,32}$/;
  let added = 0, merged = 0, skipped = 0;
  const incoming = [];
  for (const s of x.index.sessions) {
    if (!s?.id) continue;
    if (typeof s.id !== "string" || !ID.test(s.id)) {
      skipped++;
      continue;
    }
    const file = x.sessions.find((d) => d?.id === s.id) ?? {};
    const events = (Array.isArray(file.events) ? file.events : []).filter((e) => e && typeof e === "object");
    // Events from before 1.1.1 get the id a read of their file would give them, so the two match
    for (const e of events) e.id ??= contentId(e);
    const encounters = (Array.isArray(file.encounters) ? file.encounters : []).filter((e) => typeof e?.id === "string" && ID.test(e.id));
    incoming.push({ s, events, encounters });
  }
  const arcs = (x.index.arcs ?? []).filter((a) => typeof a?.id === "string" && ID.test(a.id));
  const touched = [];
  // Sessions already in the ledger get what they're missing; events have no id, so one is known by its whole content
  const known = new Set(Store.index.sessions.map((m) => m.id));
  for (const { s, events, encounters } of incoming) {
    if (!known.has(s.id)) continue;
    const data = await Store.load(s.id);
    const have = new Set(data.events.map((e) => e.id));
    const extra = events.filter((e) => !have.has(e.id));
    if (extra.length) {
      data.events.push(...extra);
      data.events.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    }
    for (const enc of encounters) if (enc?.id && !data.encounters.some((d) => d.id === enc.id)) data.encounters.push(enc);
    merged++;
    touched.push(s.id);
  }
  await Store.mutateIndex((ix) => {
    for (const a of arcs) if (!ix.arcs.some((b) => b.id === a.id)) ix.arcs.push({ id: a.id, name: String(a.name ?? L("Arc")) });
    for (const { s, events, encounters } of incoming) {
      if (known.has(s.id) || ix.sessions.some((m) => m.id === s.id)) continue;
      ix.sessions.push({ id: s.id, name: String(s.name ?? L("Session")), arc: ix.arcs.some((a) => a.id === s.arc) ? s.arc : null, start: s.start ?? events[0]?.t ?? now(), end: s.end ?? events.at(-1)?.t ?? s.start ?? now() });
      Store.cache.set(s.id, { id: s.id, events, encounters });
      added++;
      touched.push(s.id);
    }
    ix.sessions.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  });
  const saved = [];
  for (const id of touched) if (await Store.save(id)) saved.push(id);
  announceSaved(saved);
  return { added, merged, skipped };
}


export { starting, expiring, activeSession, nextSessionName, expireStale, whisperGM, startNotice, startSession, endedSoon, endSession, resumeSession, importLedger };
