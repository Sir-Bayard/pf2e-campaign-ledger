/* Names and values shared by every file. */

const MOD = "pf2e-campaign-ledger";
const OUTCOMES = ["criticalFailure", "failure", "success", "criticalSuccess"];
const SAVES = ["fortitude", "reflex", "will"];
const ATTRIBUTION_WINDOW = 60 * 1000;

const FP = () => foundry.applications.apps.FilePicker.implementation;
const now = () => Date.now();
const uid = () => foundry.utils.randomID(10);
const fileDir = () => `worlds/${game.world.id}/${MOD}`;

const SAVE_EVERY = 30 * 1000;

/** Text from lang/en.json (PCL.<key>), with {placeholders} filled from `data`. */
const L = (key, data = null) => (data ? game.i18n.format(`PCL.${key}`, data) : game.i18n.localize(`PCL.${key}`));

const DEFAULT_INDEX = { version: 1, arcs: [], sessions: [], active: null, currentArc: null, updated: 0 };
/** Returned by a mutateIndex change that turns out to have nothing to write. */
const SKIP = Symbol("skip");


export { MOD, OUTCOMES, SAVES, ATTRIBUTION_WINDOW, FP, now, uid, fileDir, SAVE_EVERY, L, DEFAULT_INDEX, SKIP };
