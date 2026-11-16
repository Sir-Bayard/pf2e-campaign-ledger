import { gmTabs } from "./kit/gm-tabs.mjs";
import { L, MOD } from "./constants.mjs";
import { Rec } from "./recorder.mjs";
import { activeSession } from "./sessions.mjs";
import { Store, announceSaved } from "./store.mjs";

/* Which GM tab records: the one the kit's tab election picks, and what happens when the lead moves. */

// fresh 0: a GM tab that isn't the lead always asks the lead before letting a hook go, so a lead that has just gone (a
// reload) is noticed within 3 s instead of being taken to be there for 5
const tabs = gmTabs(MOD, { fresh: 0 });
let leading = false;

/**
 * True in the one client that records: the active GM's lead tab (a second tab of the same GM records nothing). A tab
 * that has just taken the lead drops what it had read, since the tab that led before wrote the files since.
 */
let taking = null;
async function isRecorder() {
  const lead = await tabs.leadNow();
  if (!lead && leading) await loseLead();
  if (lead && !leading) {
    leading = true;
    // Every hook waits for the take-over, so they still run in the order they came
    taking = (async () => {
      Store.cache.clear();
      Store.mine.clear();
      await resumeEncounter();
    })().finally(() => (taking = null));
  }
  if (lead && taking) await taking;
  return lead;
}

/**
 * This tab stopped recording (another tab of the same GM took over, or the page is being frozen): its last events go
 * into the file now, merged with whatever the other tab saved, and its copies are dropped, since the other tab writes
 * the files from here on.
 */
async function loseLead() {
  if (!leading) return;
  leading = false;
  clearTimeout(Store.timer);
  Store.timer = null;
  Store.firstPending = 0;
  const ids = [...Store.cache.keys()];
  const saved = [];
  try {
    for (const id of ids) if (Store.dirty.has(id) && (await Store.save(id, { force: true }))) saved.push(id);
  } finally {
    Store.cache.clear();
    Store.mine.clear();
    announceSaved(saved);
  }
}

/**
 * Why this GM client mustn't change the running session's file (the recording client would save over it), or null
 * when it may.
 */
async function notRecording() {
  if (await tabs.leadNow()) return null;
  return game.users.activeGM?.isSelf ? L("OtherTabRecording") : L("OtherGMRecording", { name: game.users.activeGM?.name ?? L("AnotherGM") });
}

/** A combat already running when this tab starts recording (a reload, a hand-over) keeps its encounter. */
async function resumeEncounter() {
  let enc = null;
  if (game.combat?.started) {
    const s = await activeSession({ create: false });
    const data = s ? await Store.load(s.id) : null;
    if (data?.encounters.some((e) => e.id === game.combat.id && !e.end)) enc = game.combat.id;
  }
  Rec.encounter = enc;
}
const recording = () => game.settings.get(MOD, "recording");


export { tabs, leading, taking, isRecorder, loseLead, notRecording, resumeEncounter, recording };
