import { aggregate } from "./aggregate.mjs";
import { ChatArchiveApp, archiveChat, archivesOf, publicArchivesOf, rebuildChatIndex, repairPublicArchives, sampleClock } from "./archive.mjs";
import { DEFAULT_INDEX, MOD, now } from "./constants.mjs";
import { LedgerApp, LedgerMenu, refreshOpenApps } from "./dashboard.mjs";
import { isRecorder, leading, loseLead, tabs } from "./lead.mjs";
import { storeSummaries, summaryValue } from "./recap.mjs";
import { Rec, hpSnap, onChatMessage, primeCaches, resSnap } from "./recorder.mjs";
import { endSession, importLedger, resumeSession, startSession } from "./sessions.mjs";
import { Store } from "./store.mjs";
import { isAlly } from "./util.mjs";
import { onCombatStart, onCreateCombatant, onDeadStatus, onDeleteCombat, onDeleteItem, onDying, onPersistentGranted, onTrackersChanged, onUpdateActor, onUpdateChatMessage, onUpdateCombat, primeQuests } from "./watchers.mjs";

/**
 * PF2e Campaign Ledger
 * Long-term table statistics for Pathfinder 2e, grouped by session, arc and encounter.
 *
 * Recording runs on the active GM's client only. Each session's events are kept in a JSON file in
 * worlds/<world>/pf2e-campaign-ledger/, and the list of sessions and arcs lives in a world setting.
 * Enemies are recorded by token name only, which players can already see on the map.
 * Archived chat goes into its own files there too, listed on a GM-only journal entry (see "Chat archive").
 */


/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */

/** The sessions, oldest first: [{ id, name, arc, arcName, start, end, running }]. A copy; changing it changes nothing. */
function sessions() {
  const ix = Store.index;
  return ix.sessions.map((s) => ({ id: s.id, name: s.name, arc: s.arc ?? null, arcName: ix.arcs.find((a) => a.id === s.arc)?.name ?? null, start: s.start, end: s.end ?? null, running: s.id === ix.active }));
}

/**
 * Totals per character and creature for a scope ("all", "session:<id>", "arc:<id>", "arc:none"), as the ledger's
 * tables count them: [{ k, n, p, ally, atk, hit, crit, dealt, ff, taken, kills, ... }]. Players get the party only,
 * and only when the GM lets them open the ledger.
 */
async function stats(scope = "all") {
  if (!game.user.isGM && !game.settings.get(MOD, "playerView")) return [];
  const data = await Store.loadScope(scope);
  const rows = [...aggregate(data.events).values()].filter((r) => game.user.isGM || r.p);
  return rows.map((r) => ({ ...foundry.utils.deepClone({ ...r, encounters: undefined }), encounters: r.encounters.size, ally: isAlly(r) }));
}

/* ------------------------------------------------------------------ */
/* Registration                                                       */
/* ------------------------------------------------------------------ */

let leadCheck = null;
function onSocket(msg, senderId) {
  if (tabs.handle(msg, senderId)) {
    // Another tab of this GM spoke: once a new tab has settled in, this one may no longer lead
    if (leading) {
      clearTimeout(leadCheck);
      leadCheck = setTimeout(() => {
        if (leading && !tabs.isLead()) loseLead().catch((e) => console.error(MOD, e));
      }, 2500);
    }
    return;
  }
  if (msg?.type === "saved" && Array.isArray(msg.ids) && game.users.get(senderId)?.isGM) {
    // Another client saved session files: read them again. The recording client keeps the running session and anything
    // it hasn't saved yet; a correction from another client to an ended session is read again.
    for (const id of msg.ids) {
      if (typeof id !== "string") continue;
      Store.mine.delete(id);
      if (game.user.isGM && leading && (id === Store.index.active || Store.dirty.has(id))) continue;
      Store.forget(id);
      // The recording tab keeps an ended session's stored summary in step with its file
      if (tabs.isLead() && Store.index.sessions.find((x) => x.id === id)?.end) {
        Store.load(id).then((d) => storeSummaries(new Map([[id, summaryValue(d)]]))).catch((e) => console.error(MOD, e));
      }
    }
    refreshOpenApps();
    return;
  }
  if (msg?.type === "end" && senderId === game.user.id && game.user.isGM && typeof msg.id === "string") {
    // From this GM's other tab: the recording tab ends that session, if it's still the running one
    isRecorder()
      .then((lead) => (lead && Store.index.active === msg.id ? endSession({ id: msg.id, quiet: !!msg.quiet, archive: !!msg.archive, at: Number.isFinite(msg.at) ? msg.at : null }) : null))
      .catch((e) => console.error(MOD, e));
    return;
  }
  if (msg?.type === "revert" && typeof msg.m === "string" && msg.m.length <= 32 && leading) {
    Rec.revertAsks.set(msg.m, { user: senderId, t: now() });
    // Only the last few count
    if (Rec.revertAsks.size > 50) Rec.revertAsks.delete(Rec.revertAsks.keys().next().value);
  }
}

Hooks.once("init", () => {
  game.settings.register(MOD, "index", { scope: "world", config: false, type: Object, default: foundry.utils.deepClone(DEFAULT_INDEX) });
  game.settings.register(MOD, "recording", {
    name: "PCL.SettingRecordingName",
    hint: "PCL.SettingRecordingHint",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "playerView", {
    name: "PCL.SettingPlayerViewName",
    hint: "PCL.SettingPlayerViewHint",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => { refreshOpenApps(); ChatArchiveApp.refresh(); },
  });
  game.settings.register(MOD, "startNotice", {
    name: "PCL.SettingStartNoticeName",
    hint: "PCL.SettingStartNoticeHint",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "recap", {
    name: "PCL.SettingRecapName",
    hint: "PCL.SettingRecapHint",
    scope: "world", config: true, type: String, default: "all",
    choices: { all: "PCL.RecapAll", gm: "PCL.RecapGM", off: "PCL.RecapOff" },
  });
  game.settings.register(MOD, "archiveOffer", {
    name: "PCL.SettingArchiveOfferName",
    hint: "PCL.SettingArchiveOfferHint",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "archivePlayers", {
    name: "PCL.SettingArchivePlayersName",
    hint: "PCL.SettingArchivePlayersHint",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => { refreshOpenApps(); ChatArchiveApp.refresh(); },
  });
  game.settings.register(MOD, "needPlayer", {
    name: "PCL.SettingNeedPlayerName",
    hint: "PCL.SettingNeedPlayerHint",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MOD, "initiativeNat", {
    name: "PCL.SettingInitiativeNatName",
    hint: "PCL.SettingInitiativeNatHint",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => refreshOpenApps(),
  });
  game.settings.register(MOD, "sessionGap", {
    name: "PCL.SettingSessionGapName",
    hint: "PCL.SettingSessionGapHint",
    scope: "world", config: true, type: Number, default: 10,
  });
  game.settings.registerMenu(MOD, "open", {
    name: "PCL.Title", label: "PCL.OpenLedger", icon: "fa-solid fa-book-open-reader", type: LedgerMenu, restricted: false,
  });
});

Hooks.once("ready", () => {
  game.modules.get(MOD).api = { open: () => LedgerApp.open(), startSession, endSession, resumeSession, importLedger, sessions, stats, archiveChat, archivesOf, publicArchivesOf, rebuildChatIndex, viewChat: (id) => ChatArchiveApp.open(id) };
  lastActive = Store.index.active;
  primeCaches();
  // The socket handler before start(), so no answer from another tab is missed.
  game.socket.on(`module.${MOD}`, onSocket);
  tabs.start();
  // A page being frozen (a background tab) hands its last events over and stops recording
  document.addEventListener("freeze", () => loseLead().catch((e) => console.error(MOD, e)));
  // Leaving the page: try to save what's waiting (it may not finish; at most half a minute is lost)
  globalThis.addEventListener("pagehide", () => {
    if (leading) Store.flushNow().catch(() => {});
  });
  // A player's Revert on a card they can't mark: tell the recording GM which card it was
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.('button[data-action="revertDamage"]');
    const m = button?.closest("[data-message-id]")?.dataset.messageId;
    if (m && !game.user.isGM) game.socket.emit(`module.${MOD}`, { type: "revert", m });
  }, true);
  repairPublicArchives().catch((e) => console.error(MOD, e));
  isRecorder().catch((e) => console.error(MOD, e));
  primeQuests(false);
});

Hooks.on("canvasReady", () => primeCaches());
Hooks.on("pf2e-campaign-trackers.ready", () => primeQuests());
Hooks.on("pf2e-campaign-trackers.changed", () => onTrackersChanged().catch((e) => console.error(MOD, e)));
Hooks.on("createToken", (t) => t.actor && Rec.hp.set(t.actor.uuid, hpSnap(t.actor)) && Rec.res.set(t.actor.uuid, resSnap(t.actor)));
Hooks.on("createChatMessage", (msg) => {
  sampleClock(msg);
  onChatMessage(msg).catch((e) => console.error(MOD, e));
});
Hooks.on("updateChatMessage", (msg, changes) => onUpdateChatMessage(msg, changes).catch((e) => console.error(MOD, e)));
Hooks.on("updateActor", (a, c, o, userId) => onUpdateActor(a, c, o, userId).catch((e) => console.error(MOD, e)));
Hooks.on("createItem", (i) => {
  onPersistentGranted(i);
  onDying(i).catch((e) => console.error(MOD, e));
});
Hooks.on("updateItem", (i, c) => onDying(i, c ?? {}).catch((e) => console.error(MOD, e)));
Hooks.on("deleteItem", (i) => onDeleteItem(i));
Hooks.on("createActiveEffect", (e) => onDeadStatus(e).catch((err) => console.error(MOD, err)));
Hooks.on("combatStart", (c) => onCombatStart(c).catch((e) => console.error(MOD, e)));
Hooks.on("updateCombat", (c, ch) => onUpdateCombat(c, ch).catch((e) => console.error(MOD, e)));
Hooks.on("createCombatant", (c) => onCreateCombatant(c));
Hooks.on("deleteCombat", (c) => onDeleteCombat(c).catch((e) => console.error(MOD, e)));

let lastActive = null;
Hooks.on("updateSetting", (setting) => {
  if (setting.key !== `${MOD}.index`) return;
  const ix = Store.index;
  const active = ix.active;
  if (game.user.isGM && leading) {
    // A session ended from another client (another GM, a macro): what the recorder remembered from it goes too
    if (lastActive && active !== lastActive) Rec.forget(ix.sessions.find((s) => s.id === lastActive)?.end ?? now());
    if (!tabs.isLead()) loseLead().catch((e) => console.error(MOD, e));
  } else {
    // Players and the GM's other tabs refetch the running session, and the one that just ended (its final save lands
    // after the index)
    for (const id of new Set([active, lastActive])) if (id) Store.forget(id);
  }
  lastActive = active;
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
    title: "PCL.Title",
    icon: "fa-solid fa-book-open-reader",
    order: Object.keys(tools).length,
    button: true,
    visible: true,
    // Opened by a click, so the keys go to the ledger at once
    onChange: () => LedgerApp.open()?.then?.((app) => app?.focusWindow?.()).catch?.((e) => console.error(MOD, e)),
  };
});
