import { keyboardWindow } from "./kit/keyboard.mjs";
import { esc, labelAttr, tipAttr } from "./kit/safe-text.mjs";
import { singleWindow } from "./kit/single-window.mjs";
import { rememberWindow } from "./kit/window-memory.mjs";
import { aggregate } from "./aggregate.mjs";
import { ChatArchiveApp, archiveChat, archiveTarget, archivesOf, forgetArchives, playersReadChat } from "./archive.mjs";
import { DEFAULT_INDEX, L, MOD, SAVES, now, uid } from "./constants.mjs";
import { notRecording, tabs } from "./lead.mjs";
import { describe, diceData, diceStats, entryWord, exportStats, histogram, luckText, namesOf, postRecap, presentFor, storeSummaries, storedSum, summaries, summaryOf, summaryValue, trendChart } from "./recap.mjs";
import { Rec } from "./recorder.mjs";
import { endSession, importLedger, resumeSession, startSession } from "./sessions.mjs";
import { Store, announceSaved } from "./store.mjs";
import { fmtDate, fmtDuration, isAlly, pct, saveLabel, skillLabel } from "./util.mjs";

/* The Campaign Ledger window: its tabs, and the GM's tools in it. */

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

/** The Party tab's columns, in the language of the moment (built when drawn, after the language is loaded). */
const partyColumns = () => [
  { key: "n", label: L("ColCharacter"), group: "", fmt: (a) => esc(a.n), text: true },
  { key: "atk", label: L("ColAttacks"), group: L("GroupOffense") },
  { key: "hitRate", label: L("ColHitRate"), group: L("GroupOffense"), fmt: (a) => pct(a.hit, a.atkKnown), tip: L("TipHitRate") },
  { key: "crit", label: L("ColCrits"), group: L("GroupOffense") },
  { key: "dealt", label: L("ColDamage"), group: L("GroupOffense"), tip: L("TipDamage"), tipf: (a) => L("Rolled", { n: a.dmg }) },
  { key: "ff", label: L("ColFriendlyFire"), group: L("GroupOffense"), tip: L("TipFriendlyFire") },
  { key: "dealtBest", label: L("ColBestHit"), group: L("GroupOffense"), fmt: (a) => (a.dealtBest ? `${a.dealtBest}` : "–"), tipf: (a) => a.dealtBestIt ?? "" },
  { key: "kills", label: L("ColKills"), group: L("GroupOffense") },
  { key: "spellN", label: L("ColSpells"), group: L("GroupSpells"), tip: L("TipSpells") },
  { key: "forcedFail", label: L("ColSavesForced"), group: L("GroupSpells"), fmt: (a) => (a.forced ? `${a.forcedFail}/${a.forced}` : "–"), tip: L("TipSavesForced") },
  { key: "skillPass", label: L("ColSkills"), group: L("GroupSpells"), fmt: (a) => (a.skillN ? `${a.skillPass}/${a.skillKnown}` : "–"), tip: L("TipSkills") },
  { key: "taken", label: L("ColTaken"), group: L("GroupDefense"), tip: L("TipTaken") },
  { key: "critTaken", label: L("ColCritsTaken"), group: L("GroupDefense") },
  { key: "down", label: L("ColDowned"), group: L("GroupDefense") },
  { key: "dead", label: L("ColDeaths"), group: L("GroupDefense") },
  { key: "healDone", label: L("ColHealing"), group: L("GroupSupport"), tip: L("TipHealing"), tipf: (a) => L("Rolled", { n: a.heal }) },
  { key: "revivedBy", label: L("ColRevived"), group: L("GroupSupport"), tip: L("TipRevived") },
  { key: "saveRate", label: L("ColSaves"), group: L("GroupDice"), fmt: (a) => pct(a.savePass, a.saveN), tip: L("TipSaves") },
  { key: "nat20", label: L("ColNat"), group: L("GroupDice"), fmt: (a) => (a.nat20 || a.nat1 ? `${a.nat20} / ${a.nat1}` : "–"), tip: L(game.settings.get(MOD, "initiativeNat") === false ? "TipNatNoInitiative" : "TipNat") },
  { key: "hero", label: L("ColHero"), group: L("GroupDice"), tip: L("TipHero") },
  { key: "rerolls", label: L("ColRerolls"), group: L("GroupDice"), fmt: (a) => (a.rerolls ? `${a.rerollsBetter}/${a.rerolls}` : "–"), tip: L("TipRerolls") },
];

class LedgerApp extends keyboardWindow(rememberWindow(foundry.applications.api.ApplicationV2, { module: MOD, name: "main", from: `${MOD}.size` }), { module: MOD, scope: ".pcl-app", ownKeys: true }) {
  static DEFAULT_OPTIONS = {
    id: "pf2e-campaign-ledger",
    classes: ["pcl-app"],
    tag: "div",
    window: {
      title: "PCL.Title", icon: "fa-solid fa-book-open-reader", resizable: true,
      controls: [
        { icon: "fa-solid fa-file-export", label: "PCL.ExportEverything", action: "exportData" },
        { icon: "fa-solid fa-file-import", label: "PCL.ImportExport", action: "importData" },
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
      exportStats: LedgerApp.#onExportStats,
      correctEntry: LedgerApp.#onCorrectEntry,
    },
  };

  // The tab, scope and sort survive closing the window
  static lastState = null;
  state = LedgerApp.lastState ?? { tab: "party", scope: Store.index.active ? `session:${Store.index.active}` : "all", sort: { key: "dealt", dir: -1 }, char: null, enc: null, diceWho: "party", diceKind: "all" };
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
      el.innerHTML = `<section class="pcl-body"><p class="pcl-empty">${L("LedgerClosed")}</p></section>`;
      return el;
    }
    el.innerHTML = this.#header(ctx) + this.#tabs() + `<section class="pcl-body" id="pcl-panel" role="tabpanel" aria-labelledby="pcl-tab-${this.state.tab}" data-focus-pane="body" data-focus-start data-keep-scroll="body" tabindex="-1">${this.#body(ctx)}</section>`;
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

  /** A live refresh: only when the data moved on, and not under a field the user is typing in. */
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
      const arc = e.target.value || null;
      await Store.mutateIndex((ix) => {
        ix.currentArc = arc;
      });
    });
    for (const input of this.element.querySelectorAll("[data-edit]")) {
      input.addEventListener("change", (e) => this.#onEdit(e.target));
    }
  }

  /* ---------- pieces ---------- */

  #header({ ix }) {
    const arcName = (id) => ix.arcs.find((a) => a.id === id)?.name ?? L("NoArc");
    const opts = [`<option value="all">${L("WholeCampaign")}</option>`];
    for (const a of ix.arcs) opts.push(`<option value="arc:${esc(a.id)}">${L("ArcName", { name: esc(a.name) })}</option>`);
    for (const s of [...ix.sessions].reverse()) opts.push(`<option value="session:${s.id}">${esc(s.name)} · ${fmtDate(s.start)}</option>`);
    const scope = opts.join("").replace(`value="${this.state.scope}"`, `value="${this.state.scope}" selected`);
    const active = ix.sessions.find((s) => s.id === ix.active);
    const live = active
      ? `<span class="pcl-live"><i class="fa-solid fa-circle"></i> ${L("RecordingName", { name: esc(active.name), arc: esc(arcName(active.arc)) })}</span>`
      : `<span class="pcl-idle">${L("NoSession")}</span>`;
    let gm = "";
    if (this.isGM) {
      const arcOpts = [`<option value="">${L("NoArc")}</option>`, ...ix.arcs.map((a) => `<option value="${esc(a.id)}" ${a.id === ix.currentArc ? "selected" : ""}>${esc(a.name)}</option>`)].join("");
      gm = `<div class="pcl-gm">
        <label>${L("CurrentArc")} <select name="currentArc">${arcOpts}</select></label>
        <button type="button" data-action="addArc"><i class="fa-solid fa-plus"></i> ${L("Arc")}</button>
        ${active ? `<button type="button" data-action="endSession"><i class="fa-solid fa-stop"></i> ${L("EndSession")}</button>` : ""}
        <button type="button" data-action="startSession"><i class="fa-solid fa-play"></i> ${L("NewSession")}</button>
        ${game.messages.size && ix.sessions.length ? `<button type="button" data-action="archiveChat"${tipAttr(L("ArchiveChatTip", { name: (active ?? archiveTarget())?.name ?? L("TheSession") }))}><i class="fa-solid fa-box-archive"></i> ${L("ArchiveChat")}</button>` : ""}
        ${!active && ix.sessions.some((s) => s.end) ? `<button type="button" data-action="resumeSession"${tipAttr(L("ResumeTip"))}><i class="fa-solid fa-rotate-left"></i> ${L("ResumeLast")}</button>` : ""}
      </div>`;
    }
    return `<header class="pcl-head">
      <div class="pcl-scope"><label>${L("Showing")} <select name="scope" aria-label="${L("Showing")}">${scope}</select></label>
      <button type="button" data-action="refresh"${labelAttr(L("Reload"))}><i class="fa-solid fa-rotate" aria-hidden="true"></i></button></div>
      ${live}${gm}</header>`;
  }

  #tabs() {
    const t = [["party", L("TabParty"), "fa-users"], ["character", L("TabCharacters"), "fa-user"], ["encounters", L("TabEncounters"), "fa-swords"], ["dice", L("TabDice"), "fa-dice-d20"], ["sessions", L("TabSessions"), "fa-calendar-days"]];
    return `<div class="pcl-tabs" role="tablist" aria-label="${L("LedgerTabs")}">${t.map(([id, label, icon]) => {
      const sel = this.state.tab === id;
      return `<button type="button" role="tab" data-action="pclTab" data-tab="${id}" class="${sel ? "active" : ""}" aria-selected="${sel}" aria-controls="pcl-panel" id="pcl-tab-${id}"${sel ? " data-focus-home" : ""}><i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}</button>`;
    }).join("")}</div>`;
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
    if (!party.length) return `<p class="pcl-empty">${L("NothingYet")}</p>`;
    const { key, dir } = this.state.sort;
    const PARTY_COLUMNS = partyColumns();
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
    const head1 = groups.map((g) => `<th colspan="${g.span}" class="pcl-group">${esc(g.name)}</th>`).join("");
    const head2 = PARTY_COLUMNS.map((c) => {
      const arrow = c.key === key ? (dir < 0 ? " ▾" : " ▴") : "";
      const sortState = c.key === key ? ` aria-sort="${dir < 0 ? "descending" : "ascending"}"` : "";
      return `<th${sortState}><button type="button" class="pcl-sort" data-action="sort" data-key="${c.key}"${c.tip ? tipAttr(c.tip) : ""}>${esc(c.label)}${arrow}</button></th>`;
    }).join("");
    const row = (a) => `<tr>${PARTY_COLUMNS.map((c) => {
      const v = c.fmt ? c.fmt(a) : (a[c.key] ?? 0) || "–";
      const lead = !c.text && party.length > 1 && best[c.key] > 0 && a[c.key] === best[c.key] && !["nat1", "taken", "critTaken", "down", "dead", "ff"].includes(c.key);
      const tip = c.tipf ? c.tipf(a) : "";
      return `<td class="${c.text ? "pcl-name" : ""} ${lead ? "pcl-lead" : ""}" ${tip ? `data-tooltip-text="${esc(tip)}"` : ""}>${v}</td>`;
    }).join("")}</tr>`;
    const allies = party.filter(isAlly);
    const chars = party.filter((a) => !isAlly(a));
    const rows = chars.map(row).join("") + (allies.length ? `<tr class="pcl-subhead"><th colspan="${PARTY_COLUMNS.length}">${L("Allies")}</th></tr>${allies.map(row).join("")}` : "");
    return this.#highlights(party, data) + `<table class="pcl-table pcl-party"><thead><tr>${head1}</tr><tr>${head2}</tr></thead><tbody>${rows}</tbody></table>
      <p class="pcl-note">${L("PartyNote")}</p>`;
  }

  #highlights(party, data) {
    const top = (key, label, icon, fmt = (a) => a[key]) => {
      const a = [...party].sort((x, y) => (y[key] ?? 0) - (x[key] ?? 0))[0];
      if (!a || !(a[key] > 0)) return "";
      return `<div class="pcl-card"><i class="fa-solid ${icon}"></i><div><span class="pcl-card-label">${label}</span><strong>${esc(a.n)}</strong><span class="pcl-card-sub">${fmt(a)}</span></div></div>`;
    };
    const encs = data.encounters.length;
    return `<div class="pcl-cards">
      <div class="pcl-card"><i class="fa-solid fa-calendar"></i><div><span class="pcl-card-label">${L("TabSessions")}</span><strong>${data.sessions.length}</strong><span class="pcl-card-sub">${L(encs === 1 ? "EncountersOne" : "EncountersMany", { n: encs })}</span></div></div>
      ${top("dealtBest", L("CardBiggestHit"), "fa-burst", (a) => `${a.dealtBest}${a.dealtBestIt ? ` · ${esc(a.dealtBestIt)}` : ""}`)}
      ${top("crit", L("CardCrits"), "fa-bullseye")}
      ${top("kills", L("CardKills"), "fa-skull")}
      ${top("nat20", L("CardNat20"), "fa-dice-d20")}
      ${top("nat1", L("CardNat1"), "fa-face-grimace")}
      ${top("taken", L("CardTaken"), "fa-shield-halved")}
      ${top("healDone", L("CardHealing"), "fa-heart-pulse")}
      ${top("spellN", L("CardSpells"), "fa-wand-sparkles")}
      ${top("skillPass", L("CardSkills"), "fa-hand-sparkles")}
    </div>`;
  }

  #character({ stats }) {
    const party = [...stats.values()].filter((a) => a.p).sort((a, b) => a.n.localeCompare(b.n));
    if (!party.length) return `<p class="pcl-empty">${L("NothingYet")}</p>`;
    if (!party.some((a) => a.k === this.state.char)) this.state.char = party[0].k;
    const a = stats.get(this.state.char);
    const opt = (p) => `<option value="${esc(p.k)}" ${p.k === a.k ? "selected" : ""}>${esc(p.n)}</option>`;
    const allies = party.filter(isAlly);
    const select = `<select name="char" aria-label="${L("ColCharacter")}">${allies.length ? `<optgroup label="${L("TabCharacters")}">${party.filter((p) => !isAlly(p)).map(opt).join("")}</optgroup><optgroup label="${L("Allies")}">${allies.map(opt).join("")}</optgroup>` : party.map(opt).join("")}</select>`;
    const table = (cols, rows) => rows.length
      ? `<table class="pcl-table"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td class="${i === 0 ? "pcl-name" : ""}">${v}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : `<p class="pcl-empty">${L("NoneYet")}</p>`;
    const weapons = Object.entries(a.weapons).sort((x, y) => y[1].n - x[1].n)
      .map(([n, w]) => [esc(n), w.n || "–", pct(w.hit, w.known), w.crit || "–", w.dealt || "–", w.dmg || "–"]);
    const saves = SAVES.map((s) => [saveLabel(s), a.saves[s][0] || "–", pct(a.saves[s][1], a.saves[s][3]), a.saves[s][2] || "–"]);
    const skills = Object.entries(a.skills).sort((x, y) => y[1].n - x[1].n)
      .map(([s, v]) => [esc(skillLabel(s)), v.n, v.known ? pct(v.pass, v.known) : "–", v.nat20 || "–", v.nat1 || "–"]);
    const abilities = Object.entries(a.abilities).sort((x, y) => y[1].n - x[1].n).map(([n, v]) => [esc(n), v.n]);
    const spells = Object.entries(a.spells).sort((x, y) => y[1].n - x[1].n)
      .map(([n, s]) => [esc(n), s.n, s.ca ? L("Cantrip") : s.fo ? L("Focus") : s.rk ? L("RankN", { n: s.rk }) : "–"]);
    const kills = Object.entries(a.killed).sort((x, y) => y[1] - x[1]).map(([n, c]) => (c > 1 ? L("Times", { name: esc(n), n: c }) : esc(n))).join(", ");
    const fact = (label, value) => `<div class="pcl-fact"><span>${label}</span><strong>${value}</strong></div>`;
    // The first value always shows; the rest only when there is something to say
    const parts = (first, ...xs) => [first, ...xs.filter(Boolean)].join(" · ");
    return `<div class="pcl-char-head"><label>${L("ColCharacter")} ${select}</label></div>
      <div class="pcl-facts">
        ${fact(L("TabEncounters"), a.encounters.size)}
        ${fact(L("ColAttacks"), L("FactAttacks", { n: a.atk, rate: pct(a.hit, a.atkKnown) }))}
        ${fact(L("ColCrits"), L("FactCrits", { dealt: a.crit, taken: a.critTaken }))}
        ${fact(L("FactDamageDealt"), parts(a.dealt, L("Rolled", { n: a.dmg }), a.dealtBest && L("FactBest", { n: a.dealtBest }), a.ff && L("FactOwnSide", { n: a.ff })))}
        ${fact(L("FactDamageTaken"), parts(a.taken, a.takenBest && (a.takenBestBy ? L("FactWorstBy", { n: a.takenBest, by: esc(a.takenBestBy) }) : L("FactWorst", { n: a.takenBest }))))}
        ${fact(L("ColHealing"), L("FactHealing", { given: a.healDone, rolled: a.heal, received: a.healed }))}
        ${fact(L("ColDowned"), parts(a.down, a.dyingMax && L("FactWorstDying", { n: a.dyingMax }), a.dead && L("FactDied", { n: a.dead })))}
        ${fact(L("FactRecovery"), a.rec ? L("FactPassed", { n: a.recPass, of: a.rec }) : "–")}
        ${fact(L("FactRevived"), a.revivedBy)}
        ${fact(L("FactNat"), `${a.nat20} / ${a.nat1}`)}
        ${fact(L("FactHero"), a.hero)}
        ${fact(L("FactFocus"), a.focus)}
      </div>
      <div class="pcl-grid">
        <div><h3>${L("ColAttacks")}</h3>${table([L("ThWeapon"), L("ColAttacks"), L("ColHitRate"), L("ColCrits"), L("ThDealt"), L("ThRolled")], weapons)}</div>
        <div><h3>${L("ThSavingThrows")}</h3>${table([L("ThSave"), L("ThRolls"), L("ThPassed"), L("ThCritFails")], saves)}</div>
        <div><h3>${L("ColSkills")}</h3>${table([L("ThSkill"), L("ThRolls"), L("ThPassed"), L("MdNat20"), L("MdNat1")], skills)}</div>
        <div><h3>${L("ThSpellsCast")}</h3>${table([L("ThSpell"), L("ThCasts"), L("ThKind")], spells)}</div>
        <div><h3>${L("ThAbilitiesUsed")}</h3>${table([L("ThAction"), L("ThUses")], abilities)}</div>
      </div>
      <h3>${L("ColKills")}</h3><p>${kills || L("NoneYet")}</p>`;
  }

  #encounters({ data, ix }) {
    if (!data.encounters.length) return `<p class="pcl-empty">${L("NoEncounters")}</p>`;
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
        detail = `<tr class="pcl-detail" id="pcl-enc-${esc(enc.id)}"><td colspan="10"><table class="pcl-table"><thead><tr><th>${L("ThCombatant")}</th><th>${L("ColAttacks")}</th><th>${L("ColHitRate")}</th><th>${L("ColCrits")}</th><th>${L("ColDamage")}</th><th${tipAttr(L("ThSpellsCast"))}>${L("ColSpells")}</th><th${tipAttr(L("TipEncForced"))}>${L("ColSavesForced")}</th><th${tipAttr(L("TipEncSkills"))}>${L("ColSkills")}</th><th${tipAttr(L("TipEncAbilities"))}>${L("ThAbilities")}</th><th>${L("ColHealing")}</th><th>${L("ColTaken")}</th><th>${L("ColKills")}</th><th>${L("ColDowned")}</th></tr></thead><tbody>
          ${list.map((a) => `<tr class="${a.p ? "" : "pcl-foe"}"><td class="pcl-name">${esc(a.n)}</td><td>${a.atk || "–"}</td><td>${pct(a.hit, a.atkKnown)}</td><td>${a.crit || "–"}</td><td>${a.dealt || "–"}</td><td>${a.spellN || "–"}</td><td>${a.forced ? `${a.forcedFail}/${a.forced}` : "–"}</td><td>${a.skillN ? `${a.skillPass}/${a.skillKnown}` : "–"}</td><td>${a.abilityN || "–"}</td><td>${a.healDone || "–"}</td><td>${a.taken || "–"}</td><td>${a.kills || "–"}</td><td>${a.down || "–"}</td></tr>`).join("")}
          </tbody></table>${this.#roundLog(evs)}</td></tr>`;
      }
      return `<tr class="pcl-click" data-action="encounter" data-id="${esc(enc.id)}">
        <td><button type="button" class="pcl-rowbtn" data-action="encounter" data-id="${esc(enc.id)}" aria-expanded="${open}" aria-controls="pcl-enc-${esc(enc.id)}" aria-label="${esc(L("EncounterLabel", { date: fmtDate(enc.start), name: enc.name || enc.scene }))}">${fmtDate(enc.start)}</button></td><td>${esc(sessName(enc.sid))}</td><td class="pcl-name">${esc(enc.name || enc.scene)}${this.isGM ? ` <button type="button" class="pcl-icon" data-action="renameEncounter" data-id="${esc(enc.id)}" data-sid="${esc(enc.sid)}"${labelAttr(L("RenameName", { name: enc.name || enc.scene }))}><i class="fa-solid fa-pencil" aria-hidden="true"></i></button>` : ""}</td>
        <td>${enc.rounds}</td><td>${fmtDuration((enc.end ?? now()) - enc.start)}${enc.end ? "" : ` ${L("Running")}`}</td>
        <td>${sum(party, "dealt") || "–"}</td><td>${sum(foes, "dealt") || "–"}</td><td>${sum(party, "kills") || "–"}</td>
        <td>${sum(party, "down") || "–"}</td><td>${sum(party, "crit")} / ${sum(foes, "crit")}</td></tr>${detail}`;
    }).join("");
    const th = ["ThDate", "Session", "ThEncounter", "ThRounds", "ThLength", "ThPartyDamage", "ThEnemyDamage", "ThFoesFelled", "ThPCsDowned", "ThCrits"].map((k) => `<th>${L(k)}</th>`).join("");
    return `<table class="pcl-table pcl-enc"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>
      <p class="pcl-note">${L(this.isGM ? "EncNoteGM" : "EncNote")}</p>`;
  }

  #roundLog(evs) {
    // Each correction button's name says whose entry it is; a repeat (two Strikes in a round) gets a number
    const named = new Map();
    const fixName = (e) => {
      const base = L(e.tg?.n ? "CorrectTarget" : "Correct", { name: e.a?.n ?? L("NobodyLower"), round: e.r, entry: entryWord(e.k), target: e.tg?.n ?? "" });
      const n = (named.get(base) ?? 0) + 1;
      named.set(base, n);
      return n > 1 ? `${base} (${n})` : base;
    };
    const lines = evs
      .filter((e) => e.r && (this.isGM || e.a?.p))
      .sort((x, y) => x.r - y.r || (x.t ?? 0) - (y.t ?? 0))
      .map((e) => ({ r: e.r, html: describe(e), foe: !e.a?.p, fix: this.isGM && e.id ? ` <button type="button" class="pcl-icon pcl-fix" data-action="correctEntry" data-eid="${esc(e.id)}" data-sid="${esc(e.sid)}"${labelAttr(fixName(e))}><i class="fa-solid fa-pen" aria-hidden="true"></i></button>` : "" }))
      .filter((l) => l.html);
    if (!lines.length) return "";
    const rounds = [];
    for (const l of lines) {
      if (rounds.at(-1)?.r !== l.r) rounds.push({ r: l.r, lines: [] });
      rounds.at(-1).lines.push(l);
    }
    return `<h3>${L("RoundByRound")}</h3><div class="pcl-log">${rounds.map((g) => `<div class="pcl-round"><h4>${L("RoundN", { n: g.r })}</h4><ul>${g.lines.map((l) => `<li class="${l.foe ? "pcl-foe-line" : ""}">${l.html}${l.fix}</li>`).join("")}</ul></div>`).join("")}</div>`;
  }

  #dice({ data }) {
    const KINDS = [["all", L("KindAll")], ["atk", L("ColAttacks")], ["save", L("ColSaves")], ["skill", L("ColSkills")], ["perc", L("KindPerception")], ["rec", L("FactRecovery")]];
    const all = diceData(data.events);
    const kind = this.state.diceKind;
    const valsFor = (entries) => entries.flatMap((x) => x.rolls.filter((r) => kind === "all" || r.kind === kind).map((r) => r.v));
    const party = [...all.values()].filter((x) => x.p).sort((a, b) => a.n.localeCompare(b.n));
    const foes = [...all.values()].filter((x) => !x.p);
    const who = [["party", L("WholeParty"), party], ...party.map((x) => [x.k, x.n, [x]])];
    if (this.isGM) who.push(["foes", L("Enemies"), foes]);
    if (!who.some(([k]) => k === this.state.diceWho)) this.state.diceWho = "party";
    const [, label, entries] = who.find(([k]) => k === this.state.diceWho);
    const st = diceStats(valsFor(entries));
    const list = who.map(([k, n]) => `<button type="button" data-action="diceWho" data-who="${esc(k)}" class="${k === this.state.diceWho ? "active" : ""}" aria-pressed="${k === this.state.diceWho}">${esc(n)}</button>`).join("");
    const kinds = KINDS.map(([k, n]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${n}</option>`).join("");
    const tile = (l, v) => `<div class="pcl-tile"><span>${l}</span><strong>${v}</strong></div>`;
    const main = st
      ? `<div class="pcl-tiles">${tile(L("ThRolls"), st.n)}${tile(L("Average"), st.mean.toFixed(1))}${tile(L("Median"), st.median)}${tile(L("MostCommon"), st.mode)}${tile(L("Natural20s"), st.nat20)}${tile(L("Natural1s"), st.nat1)}${tile(L("Luck"), luckText(st))}</div>
         <figure class="pcl-chart" aria-label="${esc(L("HistLabel", { name: label }))}">${histogram(st)}</figure>`
      : `<p class="pcl-empty">${L("NoRolls")}</p>`;
    const rows = [...party, ...(this.isGM && foes.length ? [{ k: "foes", n: L("Enemies"), p: false, group: foes }] : [])]
      .map((x) => ({ n: x.n, foe: !x.p, st: diceStats(valsFor(x.group ?? [x])) }))
      .filter((x) => x.st)
      .sort((a, b) => b.st.mean - a.st.mean);
    const table = rows.length
      ? `<h3>${L("RollingWell")}</h3><table class="pcl-table"><thead><tr>${["ColCharacter", "ThRolls", "Average", "Luck", "MdNat20", "MdNat1"].map((k) => `<th>${L(k)}</th>`).join("")}</tr></thead><tbody>${rows.map((x) => `<tr class="${x.foe ? "pcl-foe" : ""}"><td class="pcl-name">${esc(x.n)}</td><td>${x.st.n}</td><td>${x.st.mean.toFixed(1)}</td><td>${luckText(x.st)}</td><td>${x.st.nat20 || "–"}</td><td>${x.st.nat1 || "–"}</td></tr>`).join("")}</tbody></table>`
      : "";
    return `<div class="pcl-dice">
        <nav class="pcl-dice-list">${list}</nav>
        <div class="pcl-dice-main"><div class="pcl-dice-top"><strong>${esc(label)}</strong><label>${L("ThRolls")} <select name="diceKind">${kinds}</select></label></div>${main}</div>
      </div>${table}
      <p class="pcl-note">${L("DiceNote")}</p>`;
  }

  #sessions({ ix }) {
    const chatIcon = (s) => {
      const n = this.isGM ? archivesOf(s.id).reduce((t, a) => t + a.n, 0) : playersReadChat() ? (s.chat ?? []).reduce((t, a) => t + a.n, 0) : 0;
      return n ? `<button type="button" class="pcl-icon" data-action="viewChat" data-id="${esc(s.id)}"${labelAttr(L(n === 1 ? "ArchivedChatOne" : "ArchivedChatMany", { n }))}><i class="fa-solid fa-comments" aria-hidden="true"></i></button> ` : "";
    };
    const arcOpts = (sel) => [`<option value="">${L("NoArc")}</option>`, ...ix.arcs.map((a) => `<option value="${esc(a.id)}" ${a.id === sel ? "selected" : ""}>${esc(a.name)}</option>`)].join("");
    // Who was there and the trend lines come from each ended session's stored summary. A session without one (older
    // than summaries, or the running one) is read, then the tab redraws, and the recording GM stores what's missing.
    // A session that couldn't be read is tried again only when the window is opened again.
    this.unreadable ??= new Set();
    const missing = ix.sessions.filter((s) => !storedSum(s) && !Store.cache.has(s.id) && !this.unreadable.has(s.id)).map((s) => s.id);
    // Ended sessions read but without a stored summary get one (the recording GM's tab writes them, once)
    const storeMissing = async () => {
      if (!game.user.isGM || !tabs.isLead()) return;
      const fill = new Map();
      for (const s of Store.index.sessions) if (s.end && !storedSum(s) && Store.cache.has(s.id)) fill.set(s.id, summaryValue(Store.cache.get(s.id)));
      if (fill.size) await storeSummaries(fill).catch((e) => console.error(MOD, e));
    };
    if (missing.length && !this.filling) {
      this.filling = Promise.allSettled(missing.map((id) => Store.load(id))).then(async (results) => {
        results.forEach((r, i) => r.status === "rejected" && this.unreadable.add(missing[i]));
        await storeMissing();
        this.filling = null;
        if (this.state.tab === "sessions") this.render();
      });
    } else if (!this.filling && ix.sessions.some((s) => s.end && !storedSum(s) && Store.cache.has(s.id))) {
      this.filling = storeMissing().finally(() => (this.filling = null));
    }
    const sum = (s) => storedSum(s) ?? (Store.cache.has(s.id) ? summaryOf(s.id, Store.cache.get(s.id)) : null);
    const rows = [...ix.sessions].reverse().map((s) => {
      const name = this.isGM ? `<input type="text" data-edit="sessionName" data-id="${esc(s.id)}" value="${esc(s.name)}" aria-label="${L("SessionName")}">` : esc(s.name);
      const arc = this.isGM ? `<select data-edit="sessionArc" data-id="${esc(s.id)}" aria-label="${esc(L("ArcOf", { name: s.name }))}">${arcOpts(s.arc)}</select>` : esc(ix.arcs.find((a) => a.id === s.arc)?.name ?? "–");
      const state = s.id === ix.active ? `<span class="pcl-live"><i class="fa-solid fa-circle"></i> ${L("Recording")}</span>` : fmtDuration((s.end ?? s.start) - s.start);
      const gm = this.isGM
        ? `<button type="button" class="pcl-icon" data-action="recap" data-id="${esc(s.id)}"${labelAttr(L("PostRecapOf", { name: s.name }))}><i class="fa-solid fa-scroll" aria-hidden="true"></i></button> <button type="button" class="pcl-icon" data-action="deleteSession" data-id="${esc(s.id)}"${labelAttr(L("DeleteName", { name: s.name }))}><i class="fa-solid fa-trash" aria-hidden="true"></i></button>`
        : "";
      const known = sum(s);
      const present = known ? presentFor(s, namesOf(known.present)) : null;
      return `<tr><td class="pcl-name">${name}</td><td>${arc}</td><td>${fmtDate(s.start)}</td><td>${state}</td><td class="pcl-present">${present ? esc(present.join(", ")) || "–" : this.unreadable.has(s.id) ? L("CouldntRead") : "…"}</td>
        <td class="pcl-actions"><button type="button" class="pcl-icon" data-action="viewSession" data-id="${esc(s.id)}"${labelAttr(L("ShowName", { name: s.name }))}><i class="fa-solid fa-eye" aria-hidden="true"></i></button> ${chatIcon(s)}<button type="button" class="pcl-icon" data-action="exportStats" data-id="${esc(s.id)}"${labelAttr(L("SaveNumbersOf", { name: s.name }))}><i class="fa-solid fa-file-lines" aria-hidden="true"></i></button> ${gm}</td></tr>`;
    }).join("");
    const points = ix.sessions.map((s) => ({ name: s.name, v: sum(s) })).filter((p) => p.v);
    const trend = (title, f, fmt) => trendChart(title, points.map((p) => ({ name: p.name, v: f(p.v) })), fmt);
    const trends = points.length >= 2
      ? `<h3>${L("AcrossSessions")}</h3><div class="pcl-trends">${trend(L("TrendHitRate"), (v) => (v.known ? v.hit / v.known : null), (v) => `${Math.round(v * 100)}%`)}${trend(L("FactDamageDealt"), (v) => v.dealt, String)}${trend(L("FactDamageTaken"), (v) => v.taken, String)}${trend(L("TrendDowned"), (v) => v.down, String)}</div>`
      : "";
    const arcs = this.isGM
      ? `<h3>${L("Arcs")}</h3><table class="pcl-table pcl-arcs"><tbody>${ix.arcs.map((a) => `<tr><td><input type="text" data-edit="arcName" data-id="${esc(a.id)}" value="${esc(a.name)}" aria-label="${L("ArcNameLabel")}"></td><td>${((n) => L(n === 1 ? "SessionsOne" : "SessionsMany", { n }))(ix.sessions.filter((s) => s.arc === a.id).length)}</td></tr>`).join("") || `<tr><td>${L("NoArcs")}</td></tr>`}</tbody></table>`
      : "";
    const tools = this.isGM
      ? `<div class="pcl-tools"><button type="button" data-action="exportData"><i class="fa-solid fa-file-export"></i> ${L("ExportEverything")}</button>
         <button type="button" data-action="importData"${tipAttr(L("ImportTip"))}><i class="fa-solid fa-file-import"></i> ${L("Import")}</button>
         <button type="button" data-action="reset" class="pcl-danger"><i class="fa-solid fa-trash-can"></i> ${L("ResetLedger")}</button></div>`
      : "";
    const th = ["Session", "Arc", "ThDate", "ThLength", "WhoWasThere"].map((k) => `<th>${L(k)}</th>`).join("");
    return `${ix.sessions.length ? `<table class="pcl-table pcl-sessions"><thead><tr>${th}<th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="pcl-empty">${L("NoSessions")}</p>`}${trends}${arcs}${tools}`;
  }

  /* ---------- handlers ---------- */

  async #onEdit(target) {
    if (!game.user.isGM) return;
    const { edit, id } = target.dataset;
    const value = target.value;
    await Store.mutateIndex((ix) => {
      if (edit === "sessionName") {
        const s = ix.sessions.find((s) => s.id === id);
        if (s) s.name = value.trim() || s.name;
      } else if (edit === "sessionArc") {
        const s = ix.sessions.find((s) => s.id === id);
        if (s) s.arc = value || null;
      } else if (edit === "arcName") {
        const a = ix.arcs.find((a) => a.id === id);
        if (a) a.name = value.trim() || a.name;
      }
    });
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
    const why = sid === Store.index.active ? await notRecording() : null;
    if (why) return ui.notifications.warn(L("RenameElsewhere", { why: esc(why) }));
    const data = await Store.load(sid);
    const enc = data.encounters.find((e) => e.id === id);
    if (!enc) return;
    const name = await foundry.applications.api.DialogV2.prompt({
      window: { title: L("RenameEncounter") },
      content: `<p>${L("RenameEncounterText")}</p><label class="pcl-check">${L("Name")} <input type="text" name="name" value="${esc(enc.name ?? "")}" placeholder="${esc(enc.scene)}" autofocus></label>`,
      ok: { label: L("Rename"), callback: (ev, button) => button.form.elements.name.value.trim() },
    });
    if (name === null || name === undefined) return;
    if (name) enc.name = name;
    else delete enc.name;
    if (await Store.save(sid)) announceSaved([sid]);
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
    const since = archivesOf(s.id).length;
    const count = L(n === 1 ? (since ? "MessagesOneSince" : "MessagesOne") : since ? "MessagesManySince" : "MessagesMany", { n });
    const box = offer ? `<label class="pcl-check"><input type="checkbox" name="archive" checked> ${L("EndArchiveBox", { count })}</label>` : "";
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: L("EndSession") },
      content: `<p>${L(game.settings.get(MOD, "recap") === "all" ? "EndAskRecap" : "EndAsk", { name: esc(s.name) })}</p>${box}`,
      buttons: [
        { action: "end", label: L("EndSession"), icon: "fa-solid fa-stop", default: true, callback: (ev, button) => ({ archive: !!button.form.elements.archive?.checked }) },
        { action: "cancel", label: L("Cancel") },
      ],
      rejectClose: false,
    });
    if (!choice || choice === "cancel") return;
    if (Store.index.active !== s.id) {
      ui.notifications.warn(L("AlreadyEnded", { name: esc(s.name) }));
      return this.render();
    }
    await endSession({ archive: choice.archive });
    this.render();
  }

  static async #onResumeSession() {
    if (!game.user.isGM) return;
    const s = await resumeSession();
    if (!s) return ui.notifications.warn(L("NothingToResume"));
    this.state.scope = `session:${s.id}`;
    this.render();
  }

  static async #onAddArc() {
    if (!game.user.isGM) return;
    const arc = await Store.mutateIndex((ix) => {
      const made = { id: uid(), name: L("ArcN", { n: ix.arcs.length + 1 }) };
      ix.arcs.push(made);
      ix.currentArc = made.id;
      return made;
    });
    ui.notifications.info(L("ArcAdded", { name: esc(arc.name) }));
    this.render();
  }

  static async #onRecap(event, target) {
    if (!game.user.isGM) return;
    await Store.flushNow();
    const ok = await postRecap(target.dataset.id, { manual: true });
    if (!ok) ui.notifications.info(L("NothingInSession"));
  }

  static #onDiceWho(event, target) {
    this.state.diceWho = target.dataset.who;
    this.render();
  }

  static async #onDeleteSession(event, target) {
    if (!game.user.isGM) return;
    const s = Store.index.sessions.find((s) => s.id === target.dataset.id);
    if (!s) return;
    const hasChat = archivesOf(s.id).length > 0;
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: L("DeleteSession") },
      content: `<p>${L("DeleteAsk", { name: esc(s.name) })}</p>${hasChat ? `<p>${L("DeleteChatStays")}</p><label class="pcl-check"><input type="checkbox" name="chat"> ${L("DeleteChatToo")}</label>` : ""}`,
      buttons: [
        { action: "delete", label: L("Delete"), icon: "fa-solid fa-trash", callback: (ev, button) => ({ chat: !!button.form.elements.chat?.checked }) },
        { action: "cancel", label: L("Cancel"), default: true },
      ],
      rejectClose: false,
    });
    if (!choice || choice === "cancel") return;
    if (choice.chat) await forgetArchives(s.id);
    await Store.mutateIndex((ix) => {
      ix.sessions = ix.sessions.filter((x) => x.id !== s.id);
      if (ix.active === s.id) {
        ix.active = null;
        Rec.encounter = null;
      }
    });
    Store.forget(s.id);
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
      window: { title: L("ImportTitle") },
      content: `<p>${L("ImportText")}</p><label class="pcl-check">${L("ExportFile")} <input type="file" name="file" accept=".json,application/json"></label>`,
      ok: { label: L("Import"), callback: (ev, button) => button.form.elements.file.files[0] ?? null },
    });
    if (!file) return;
    try {
      const { added, merged, skipped } = await importLedger(await file.text());
      ui.notifications.info([L(added === 1 ? "ImportedOne" : "ImportedMany", { n: added, merged }), skipped ? L("ImportSkipped", { n: skipped }) : ""].filter(Boolean).join(" "));
    } catch (e) {
      console.error(MOD, e);
      ui.notifications.error(L("ImportFailed", { error: esc(e.message) }));
    }
    this.render();
  }

  static async #onReset() {
    if (!game.user.isGM) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: L("ResetTitle") },
      content: `<p>${L("ResetText")}</p><p>${L("ResetChat")}</p><p>${L("ResetAsk")}</p>`,
    });
    if (!ok) return;
    await LedgerApp.#onExport.call(this);
    Store.cache.clear();
    Store.mine.clear();
    Rec.encounter = null;
    await Store.mutateIndex((ix) => {
      for (const k of Object.keys(ix)) delete ix[k];
      Object.assign(ix, foundry.utils.deepClone(DEFAULT_INDEX));
    });
    this.state.scope = "all";
    ui.notifications.info(L("ResetDone"));
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
      window: { title: L("ArchiveChat") },
      content: `<p>${L("ArchiveAsk", { count: L(n === 1 ? (archivesOf(s.id).length ? "MessagesOneSince" : "MessagesOne") : archivesOf(s.id).length ? "MessagesManySince" : "MessagesMany", { n }), name: esc(s.name) })}</p>`,
    });
    if (!ok) return;
    await Store.flushNow();
    await archiveChat(s.id, { clear: true });
    this.render();
  }

  static #onExportStats(event, target) {
    exportStats(target.dataset.id);
  }

  /** The GM puts right who an entry credits (or deletes it), for when the automatic attribution got it wrong. */
  static async #onCorrectEntry(event, target) {
    event.stopPropagation();
    if (!game.user.isGM) return;
    const { eid, sid } = target.dataset;
    const why = sid === Store.index.active ? await notRecording() : null;
    if (why) return ui.notifications.warn(L("CorrectElsewhere", { why: esc(why) }));
    const data = await Store.load(sid);
    const ev = data.events.find((e) => e.id === eid);
    if (!ev) return;
    // Taken, down, healed and up belong to who they happened to; what can be wrong is who gets the credit (by)
    const field = ["taken", "down", "healed", "up"].includes(ev.k) ? "by" : "a";
    const people = new Map();
    for (const e of data.events) for (const w of [e.a, e.tg, e.by, e.v]) if (typeof w?.k === "string" && w.n) people.set(w.k, w);
    const list = [...people.values()].sort((x, y) => (y.p ? 1 : 0) - (x.p ? 1 : 0) || x.n.localeCompare(y.n));
    const cur = ev[field]?.k ?? "";
    // Credit can go to nobody; so can a kill, or damage and healing dealt, which may have no one behind them
    const nobody = field === "by" || ["kill", "dealt", "healdone"].includes(ev.k);
    const opts = `${nobody ? `<option value=""${cur ? "" : " selected"}>${L("Nobody")}</option>` : ""}${list.map((w) => `<option value="${esc(w.k)}"${w.k === cur ? " selected" : ""}>${w.p ? esc(w.n) : esc(L("Foe", { name: w.n }))}</option>`).join("")}`;
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: L("CorrectTitle") },
      content: `<p>${describe(ev) ?? esc(ev.k)}</p><label class="pcl-check">${L(field === "by" ? "CreditTo" : "WhoDidIt")} <select name="who">${opts}</select></label>`,
      buttons: [
        { action: "save", label: L("Save"), icon: "fa-solid fa-check", default: true, callback: (e, button) => ({ who: button.form.elements.who.value }) },
        { action: "delete", label: L("DeleteEntry"), icon: "fa-solid fa-trash" },
        { action: "cancel", label: L("Cancel") },
      ],
      rejectClose: false,
    });
    if (!choice || choice === "cancel") return;
    const live = (await Store.load(sid)).events;
    const target2 = live.find((e) => e.id === eid);
    if (!target2) return;
    if (choice === "delete") {
      Store.drop(sid, [target2]);
      live.splice(live.indexOf(target2), 1);
    } else {
      const w = choice.who ? people.get(choice.who) : null;
      if (!w && !nobody) return;
      target2[field] = w ? { k: w.k, n: w.n, p: !!w.p } : null;
    }
    Store.dirty.add(sid);
    Store.fixes++;
    summaries.delete(sid);
    if (await Store.save(sid)) announceSaved([sid]);
    Store.rev++;
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
    if (!game.user.isGM && !game.settings.get(MOD, "playerView")) return ui.notifications.warn(L("LedgerClosed"));
    return ledgerWindow.open();
  }
}

const ledgerWindow = singleWindow(() => new LedgerApp());

/** The settings menu makes its own window of whatever type it's given; this one just opens the ledger the normal way. */
class LedgerMenu extends foundry.applications.api.ApplicationV2 {
  render() {
    LedgerApp.open();
    return this;
  }
}


export { openApps, refreshTimer, refreshOpenApps, partyColumns, LedgerApp, ledgerWindow, LedgerMenu };
