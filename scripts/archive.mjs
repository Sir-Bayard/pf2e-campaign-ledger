import { keyboardWindow } from "./kit/keyboard.mjs";
import { esc, labelAttr } from "./kit/safe-text.mjs";
import { rememberWindow } from "./kit/window-memory.mjs";
import { FP, L, MOD, fileDir, now } from "./constants.mjs";
import { refreshOpenApps } from "./dashboard.mjs";
import { isRecorder } from "./lead.mjs";
import { Store } from "./store.mjs";
import { fmtDate } from "./util.mjs";

/* The chat archive: copying the chat log into files beside each session, the archive window and the Markdown export. */

// The chat log is copied into files next to the session files, then (by default) cleared, so a long campaign doesn't
// slow Foundry down. Archives hold GM whispers and blind rolls, so the files get random names (players can fetch a
// file by its URL but can't browse the folder) and are listed on a GM-only journal entry, not in the index setting
// players read. That keeps them out of the players' view, not out of a determined player's console: Foundry sends
// every journal entry, compendium and setting to every client (Foundry 14), the same protection GM journals have.
// Whispered chat cards reach players' clients too, content included.

/** The GM-only journal entry that records which archive files belong to which session. */
function gmStore() {
  return game.journal?.find((j) => j.flags?.[MOD]?.gmStore) ?? null;
}

async function ensureGmStore() {
  return gmStore() ?? JournalEntry.create({
    name: L("GmDataName"),
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: { [MOD]: { gmStore: true, chat: {} } },
  });
}

/** A session's archives: [{ file, pub, n, nPub, from, to, at }], oldest first (keyed by file, so writes merge). */
function archivesOf(sessionId) {
  const v = gmStore()?.flags?.[MOD]?.chat?.[sessionId] ?? {};
  return Object.values(foundry.utils.deepClone(v)).filter((a) => a?.file).sort((a, b) => a.from - b.from || a.at - b.at);
}

/**
 * Sessions no longer in the ledger (deleted, or a reset) whose archived chat is still listed, for the GM's archive
 * window: [{ id, name, start }], newest first.
 */
function deletedWithChat() {
  const ix = Store.index;
  const chat = gmStore()?.flags?.[MOD]?.chat ?? {};
  return Object.keys(chat)
    .filter((sid) => !ix.sessions.some((s) => s.id === sid))
    .map((sid) => ({ sid, list: archivesOf(sid) }))
    .filter((x) => x.list.length)
    .map((x) => ({ id: x.sid, name: L("DeletedSession"), start: x.list[0].from, deleted: true }))
    .sort((a, b) => b.start - a.start);
}

/** Take a session's archived chat off the GM's list (the files stay on the server). */
async function forgetArchives(sessionId) {
  const j = gmStore();
  if (!j?.flags?.[MOD]?.chat?.[sessionId]) return;
  await j.update({ [`flags.${MOD}.chat.${sessionId}`]: new foundry.data.operators.ForcedDeletion() });
}

const fileKey = (file) => file.replace(/^chat-/, "").replace(/\.json$/, "");

/** What players saw as the name of a speaker whose name was hidden. */
const unknownName = () => L("Unknown");

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

/**
 * One message as rendered for the GM, with the players' copy of a public message (pubHtml, pubSpeaker) and the
 * fields the archive window filters on.
 */
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
          if (!x.children.length && x.textContent.trim() === m.alias) x.textContent = unknownName();
          for (const at of ["alt", "title", "aria-label", "data-tooltip", "data-tooltip-text"]) {
            const v = x.getAttribute(at);
            if (m.alias && v?.includes(m.alias)) x.setAttribute(at, v.replaceAll(m.alias, unknownName()));
          }
        }
        pubSpeaker = unknownName();
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
  if (!game.users.activeGM?.isSelf) {
    ui.notifications.warn(L("ArchiveNotActiveGM", { name: esc(game.users.activeGM?.name ?? "?") }));
    return null;
  }
  if (archiving) {
    ui.notifications.warn(L("ArchiveBusy"));
    await archiving.catch(() => null);
    return null;
  }
  let bar = null;
  const done = () => bar?.update({ pct: 1 });
  const run = (async () => {
    const msgs = game.messages.contents.slice().sort((a, b) => a.timestamp - b.timestamp);
    if (!msgs.length) return null;
    bar = ui.notifications.info(L(msgs.length === 1 ? "ArchivingOne" : "ArchivingMany", { n: msgs.length }), { progress: true });
    const rows = [];
    for (let i = 0; i < msgs.length; i++) {
      rows.push(await archiveRow(msgs[i]));
      if (i % 25 === 0) bar.update({ pct: (i / msgs.length) * 0.9 });
    }
    // Messages from before any session go with the session being archived (see sessionAt).
    const groups = new Map();
    for (const r of rows) {
      const sid = sessionAt(r.t) ?? sessionId;
      if (!groups.has(sid)) groups.set(sid, []);
      groups.get(sid).push(r);
    }
    const newName = () => `chat-${foundry.utils.randomID(16).toLowerCase()}.json`;
    const save = async (name, body) => {
      const res = await FP().upload("data", fileDir(), new File([JSON.stringify(body)], name, { type: "application/json" }), {}, { notify: false });
      if (!res) throw new Error(L("ArchiveSaveFailed"));
      const back = await fetch(`${fileDir()}/${name}?t=${now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (back?.messages?.length !== body.messages.length) throw new Error(L("ArchiveReadBackFailed"));
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
        ui.notifications.warn(L("ArchivePublicListFailed"));
      }
    }
    const where = made.map((m) => (made.length > 1 ? L("ArchivedWithN", { n: m.entry.n, name: esc(m.name ?? L("ASession")) }) : L("ArchivedWith", { name: esc(m.name ?? L("TheSession")) }))).join(", ");
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
    if (left) ui.notifications.warn(L("ArchivedNotCleared", { n: rows.length, where, left }), { permanent: true });
    else ui.notifications.info(L(rows.length === 1 ? (clear ? "ArchivedOneCleared" : "ArchivedOne") : clear ? "ArchivedManyCleared" : "ArchivedMany", { n: rows.length, where: made.length > 1 ? `(${where})` : where }));
    refreshOpenApps();
    return made.map((m) => ({ session: m.sid, ...m.entry }));
  })();
  archiving = run;
  try {
    return await run;
  } catch (e) {
    console.error(MOD, e);
    done();
    ui.notifications.error(L("ArchiveFailed", { error: esc(e.message) }), { permanent: true });
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
  if (!(await isRecorder())) return 0;
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
    ui.notifications.error(L("ListFolderFailed"));
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

/** Text of an archived message's HTML, with block elements on their own lines. */
function plainText(node) {
  const BLOCK = /^(P|DIV|LI|BR|HR|H[1-6]|SECTION|HEADER|FOOTER|OL|UL|TABLE|TR|BLOCKQUOTE)$/;
  let out = "";
  const walk = (n) => {
    if (n.nodeType === 3) out += n.nodeValue.replace(/\s+/g, " ");
    else if (n.nodeType === 1) {
      const block = BLOCK.test(n.tagName);
      if (block) out += "\n";
      for (const c of n.childNodes) walk(c);
      if (block) out += "\n";
    }
  };
  walk(node);
  return out.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

/** Text made safe for Markdown: inline marks and a leading heading, quote or list marker are escaped. */
const mdEscape = (t) => String(t ?? "").replace(/([\\`*_[\]<>|~])/g, "\\$1").replace(/^(\s*)(#|>|[-+]|\d+[.)])(?=\s|$)/, "$1\\$2");

/**
 * One archived message as Markdown: who spoke and when, then a roll's title, total and result, an item card's
 * name, or the message's text. `gm` keeps whispers and DCs (only in the GM's copy). `day` is the session's date:
 * a message from another day shows its date too. Null for a message with nothing to show.
 */
function messageMarkdown(m, { gm, day }) {
  const doc = new DOMParser().parseFromString(m.html ?? "", "text/html");
  const el = doc.querySelector(".chat-message") ?? doc.body;
  const q = (sel) => el.querySelector(sel);
  const txt = (x) => (x ? plainText(x).replace(/\n/g, " ") : "");
  const at = new Date(m.t);
  const time = at.toLocaleDateString() === day
    ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const who = m.speaker || m.author || L("Unknown");
  const tags = [m.author && m.author !== who ? m.author : "", time];
  if (gm && m.whisper?.length) tags.push(L("MdWhisperTo", { names: m.whisper.join(", ") }));
  if (gm && m.blind) tags.push(L("MdBlind"));
  const head = `**${mdEscape(who)}** (${mdEscape(tags.filter(Boolean).join(", "))})`;
  const content = q(".message-content");
  const lines = [];
  const totals = [...el.querySelectorAll(".dice-total")].map((x) => x.textContent.trim()).filter(Boolean);
  if (totals.length) {
    const title = txt(q(".flavor-text h4.action")) || txt(q(".flavor-text strong")) || txt(q(".flavor-text")) || L("Roll");
    // PF2e marks the result adjusted and unadjusted only when something changed it.
    const dos = q(".degree-of-success");
    const degree = txt(dos?.querySelector(".adjusted")) || txt(dos?.querySelector(".unadjusted")) || txt(dos).replace(/^Result:\s*/i, "");
    const dc = gm ? txt(q(".target-dc")) : "";
    lines.push(`${mdEscape(title)}: **${mdEscape(totals.join(", "))}**${degree ? `, ${mdEscape(degree)}` : ""}${dc ? ` (${mdEscape(dc)})` : ""}`);
    content?.querySelectorAll(".dice-roll, button, .card-buttons, .damage-application").forEach((x) => x.remove());
  } else {
    const card = content?.querySelector(".item-card, .chat-card");
    const flavor = txt(q(".flavor-text"));
    if (card) lines.push(`*${mdEscape(txt(card.querySelector("header h3, .card-header h3, h3")) || flavor || L("Item"))}*`);
    else if (flavor) lines.push(`*${mdEscape(flavor)}*`);
  }
  if (content && !content.querySelector(".item-card, .chat-card")) {
    const body = plainText(content);
    if (body) lines.push(...body.split("\n").map(mdEscape));
  }
  return lines.length ? [head, ...lines].join("  \n") : null;
}

/** A session's archived chat as one Markdown file: the GM's copy, or the players' copy. { md, missing } or null. */
async function chatMarkdown(sessionId, { gm }) {
  const s = Store.index.sessions.find((x) => x.id === sessionId);
  const list = gm ? archivesOf(sessionId) : publicArchivesOf(sessionId);
  const rows = [];
  let missing = 0;
  for (const a of list) {
    const data = await fetch(`${fileDir()}/${a.file}?t=${now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (data?.messages) rows.push(...data.messages);
    else missing++;
  }
  if (!rows.length) return null;
  rows.sort((x, y) => x.t - y.t);
  const day = new Date(s?.start ?? rows[0].t).toLocaleDateString();
  const title = L(gm ? "MdChatTitleGM" : "MdChatTitle", { name: mdEscape(s?.name ?? L("Session")) });
  const note = missing ? `*${L(missing === 1 ? "MdMissingOne" : "MdMissingMany", { n: missing })}*\n\n` : "";
  const body = rows.map((m) => messageMarkdown(m, { gm, day })).filter(Boolean).join("\n\n");
  return { md: `# ${title}\n\n${s?.start ? `${fmtDate(s.start)}\n\n` : ""}${note}${body}\n`, missing };
}

/** Download a session's archived chat as Markdown. The GM picks the players' copy or the GM's; players get theirs. */
async function exportChat(sessionId) {
  let gm = false;
  if (game.user.isGM) {
    const pick = await foundry.applications.api.DialogV2.wait({
      window: { title: L("ExportChatTitle") },
      content: `<label class="pcl-check"><input type="radio" name="copy" value="pub" checked> ${L("ExportChatPlayers")}</label>
        <label class="pcl-check"><input type="radio" name="copy" value="gm"> ${L("ExportChatGM")}</label>`,
      buttons: [
        { action: "export", label: L("Export"), icon: "fa-solid fa-file-export", default: true, callback: (ev, button) => button.form.elements.copy.value },
        { action: "cancel", label: L("Cancel") },
      ],
      rejectClose: false,
    });
    if (pick !== "pub" && pick !== "gm") return;
    gm = pick === "gm";
  }
  const out = await chatMarkdown(sessionId, { gm });
  if (!out) return ui.notifications.warn(L(gm ? "ExportNoChat" : "ExportNoPlayersChat"));
  if (out.missing) ui.notifications.warn(L(out.missing === 1 ? "ExportMissingOne" : "ExportMissingMany", { n: out.missing }));
  const s = Store.index.sessions.find((x) => x.id === sessionId);
  const name = (s?.name ?? "session").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase() || "session";
  const date = s?.start ? `-${new Date(s.start).toISOString().slice(0, 10)}` : "";
  foundry.utils.saveDataToFile(out.md, "text/markdown", `${name}${date}-chat${gm ? "-gm" : ""}.md`);
}

/**
 * A session's archived chat, oldest first, with search and filters. The GM reads the whole log; a player, the
 * players' copy.
 */
class ChatArchiveApp extends keyboardWindow(rememberWindow(foundry.applications.api.ApplicationV2, { module: MOD, name: "archive", from: `${MOD}.size.archive` }), { module: MOD, scope: ".pcl-app", ownKeys: true }) {
  static DEFAULT_OPTIONS = {
    id: "pcl-chat-archive",
    classes: ["pcl-app", "pcl-archive-app"],
    tag: "div",
    window: { title: "PCL.ChatArchiveTitle", icon: "fa-solid fa-comments", resizable: true },
    position: { width: 520, height: 760 },
    actions: { pclMore: ChatArchiveApp.#onMore, pclExportChat: ChatArchiveApp.#onExportChat },
  };

  static open(sessionId) {
    if (!canReadChat()) return ui.notifications.warn(L("ChatClosed"));
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
      el.innerHTML = `<section class="pcl-body"><p class="pcl-empty">${L("ChatClosed")}</p></section>`;
      return el;
    }
    const gm = game.user.isGM;
    const ix = Store.index;
    this.sig = ChatArchiveApp.signature();
    const withChat = [...ix.sessions].reverse().filter((s) => (gm ? archivesOf(s.id).length : s.chat?.length));
    const deleted = gm ? deletedWithChat() : [];
    withChat.push(...deleted);
    if (!this.state.sid || !withChat.some((s) => s.id === this.state.sid)) this.state.sid = withChat[0]?.id ?? null;
    if (!this.state.sid) {
      el.innerHTML = `<section class="pcl-body"><p class="pcl-empty">${L(gm ? "NoChatGM" : "NoChat")}</p></section>`;
      return el;
    }
    const rows = await this.load();
    const s = this.state;
    const q = s.q.trim().toLowerCase();
    const speakers = [...new Set(rows.map((m) => m.speaker).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (s.who && !speakers.includes(s.who)) s.who = "";
    const shown = rows.filter((m) => (!s.who || m.speaker === s.who) && (!s.rolls || m.roll) && (s.whispers || !m.whisper.length) && (!q || m.text.includes(q)));
    const clean = (h) => foundry.utils.cleanHTML(h);
    const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(label)}</option>`;
    el.innerHTML = `<header class="pcl-head pcl-archive-head">
        <select name="sid" aria-label="${L("Session")}">${withChat.filter((x) => !x.deleted).map((x) => opt(x.id, `${x.name} · ${fmtDate(x.start)}`, x.id === s.sid)).join("")}${deleted.length ? `<optgroup label="${L("DeletedSessions")}">${deleted.map((x) => opt(x.id, `${x.name} · ${fmtDate(x.start)}`, x.id === s.sid)).join("")}</optgroup>` : ""}</select>
        <input type="search" name="q" value="${esc(s.q)}" placeholder="${L("Search")}" aria-label="${L("Search")}">
        <select name="who" aria-label="${L("Speaker")}">${opt("", L("Everyone"), !s.who)}${speakers.map((n) => opt(n, n, n === s.who)).join("")}</select>
        <label><input type="checkbox" name="rolls"${s.rolls ? " checked" : ""}> ${L("RollsOnly")}</label>
        ${gm ? `<label><input type="checkbox" name="whispers"${s.whispers ? " checked" : ""}> ${L("Whispers")}</label>` : ""}
        <span class="pcl-archive-count">${L("NOfM", { n: shown.length, m: rows.length })}${this.missing ? ` · ${L(this.missing === 1 ? "FilesMissingOne" : "FilesMissingMany", { n: this.missing })}` : ""}</span>
        <button type="button" class="pcl-archive-export" data-action="pclExportChat"${labelAttr(L("ExportChatButton"))}><i class="fa-solid fa-file-export" aria-hidden="true"></i></button>
      </header>
      <section class="pcl-body"><ol class="chat-log pcl-archive-log">${shown.slice(0, s.shown).map((m) => clean(m.html)).join("")}</ol>
      ${shown.length > s.shown ? `<button type="button" class="pcl-more" data-action="pclMore">${L("ShowMore", { n: Math.min(PAGE, shown.length - s.shown) })}</button>` : ""}</section>`;
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

  static #onExportChat() {
    if (this.state.sid) exportChat(this.state.sid);
  }

  static #onMore() {
    this.state.shown += PAGE;
    this.keepScroll = true;
    this.render();
  }

  /** What this window lists: who may read, and which files each session has. */
  static signature() {
    const gm = game.user.isGM;
    return JSON.stringify([canReadChat(), Store.index.sessions.map((s) => [s.id, s.name, (gm ? archivesOf(s.id) : s.chat ?? []).map((a) => a.file)]), gm ? deletedWithChat().map((d) => d.id) : []]);
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


export { gmStore, ensureGmStore, archivesOf, deletedWithChat, forgetArchives, fileKey, unknownName, nameHidden, archiveRow, isPublic, clockGap, sampleClock, serverGap, sessionAt, archiving, archiveChat, publicArchivesOf, addPublicArchive, repairPublicArchives, playersReadChat, canReadChat, rebuildChatIndex, archiveTarget, PAGE, plainText, mdEscape, messageMarkdown, chatMarkdown, exportChat, ChatArchiveApp };
