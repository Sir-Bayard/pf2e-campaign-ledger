PF2e Campaign Ledger 0.3.5
Foundry VTT 14, Pathfinder 2e system 8.0 or later.

WHAT IT DOES
Records table statistics as you play and shows them in a dashboard window:
attacks, hit rate, crits dealt and taken, damage dealt and rolled, damage
taken, healing, kills, downed, dying, deaths, recovery checks, saves, skills,
spells cast, actions and feats used, natural 20s and 1s, rerolls and Hero
Points spent. Everything is grouped by session, arc and encounter, and you can
view the whole campaign, one arc or one session.

INSTALL
Easiest: in Foundry, Install Module, then paste
  https://github.com/Sir-Bayard/pf2e-campaign-ledger/releases/latest/download/module.json
into Manifest URL. Or by hand:
1. Close the world, or stay on the Setup screen.
2. Unzip module.zip (from the latest release) into a new folder Data/modules/pf2e-campaign-ledger,
   so you end up with Data/modules/pf2e-campaign-ledger/module.json.
3. Launch the world. Go to Game Settings > Manage Modules, tick
   "PF2e Campaign Ledger" and save.
4. Turn off "PF2e Campaign Statistics" in the same list so rolls aren't
   recorded twice. Its journal can stay; the ledger doesn't read it.

UPDATING
Replace the module folder in Data/modules with the new one and reload the
world. Recorded data is kept.

OPENING IT
Token controls on the left: the book icon at the bottom of the list.
Also under Game Settings > Configure Settings > PF2e Campaign Ledger.
Macro: game.modules.get("pf2e-campaign-ledger").api.open()

TABS
Party       Everyone side by side. Click a column to sort.
Characters  One character in detail: attacks by weapon, saves, skills,
            spells, abilities and kills.
Encounters  Every combat. Click one for the per-combatant breakdown (attacks,
            damage, spells, saves forced, skills, abilities, healing, damage
            taken, kills, downs) and a round-by-round log.
Dice        Every d20 rolled, as a chart of how often each number came up,
            with average, median, most common, natural 20s and 1s, and luck.
            Pick a character on the left and a kind of check at the top.
Sessions    Rename sessions, sort them into arcs, post a recap, export, reset.

SESSIONS AND ARCS
A session starts by itself on the first roll and is named "Session N".
Rename it on the Sessions tab. "End session" closes it; the next roll starts
a new one. "New session" ends the current one and starts the next right away.
"Resume last session" reopens the most recently ended session if it was ended
too soon.
If nobody ends a session, it ends by itself: when the next roll comes more
than 10 hours after the session's last event (the "Hours between sessions"
setting; 0 turns it off), the old session is closed as of that last event, a
new one starts, and the GM gets a whisper saying so.
When a session starts recording, the GM gets a whisper in chat saying which
session, its arc and the time (the "Whisper when recording starts" setting
turns it off).
"+ Arc" adds an arc and makes it current. New sessions join the current arc.
You can move any session to a different arc from the Sessions tab.

CHAT ARCHIVE
A long chat log slows Foundry down. "End session" offers to archive the chat
with the session and clear it (the box is ticked; the "Offer to archive the
chat at End session" setting turns the offer off). "Archive chat" at the top
of the ledger does the same at any time, into the running session (or the
latest one). Each message is filed with the session it was posted in: a
recap or a whisper left over from the last session goes with that session,
not the new one. Only the active GM archives. Every message is saved as it
looked in chat, the files are read back to check them, and only then are
those messages deleted; anything posted meanwhile stays. The recap is posted
after the chat is cleared.
The speech bubbles on the Sessions tab open a session's archived chat:
search, a speaker filter, rolls only, and for the GM whispers on or off.
Each archive is two files. The GM's copy has every message, whispers and
blind rolls included, with what the GM saw (DCs, modifiers). The players'
copy has only the messages everyone saw, as the players saw them: PF2e's
GM-only parts (DCs, modifiers, roll formulas) are taken out, and a speaker
whose name the players couldn't see shows as "Unknown". Players read
their copy when they can open the ledger and "Players can read the archived
chat" is on.
The GM's copy is kept out of the players' view (a random file name, listed
on a GM-only journal entry, "Campaign Ledger (GM data)"; don't delete it),
but like GM journals and stat blocks it isn't out of reach of a player who
digs in the browser console. Foundry sends every journal, compendium and
setting to every client; chat whispers are the only thing the server itself
withholds.
If that journal entry is ever deleted, game.modules.get("pf2e-campaign-
ledger").api.rebuildChatIndex() lists the archive files again. If the
players' list loses an archive (after an Import, say), it is put back the
next time the GM loads the world.

SESSION RECAP
Ending a session posts a recap card to chat: biggest hit, most damage, most
crits, foes felled, who went down and who brought them back, healing, natural
20s and 1s, and Hero Points spent. The "Session recap" setting chooses
whether it goes to everyone, is whispered to the GM, or isn't posted. The
scroll icon on the Sessions tab posts a recap for any session.

ENCOUNTERS
An encounter is recorded when you begin combat in the tracker and closes when
you end it. Rolls and damage during combat are tagged to it, with the round.
Encounters are named after the scene's navigation name (the one players see).
The GM can rename one with the pencil next to its name on the Encounters tab.

PLAYERS
Players get a read-only view: party tables, characters, encounters, dice and
sessions. Enemy rows, enemy lines in the round log and enemy dice are GM-only.
Turn the player view off with the "Players can open the ledger" setting.

RESET, EXPORT AND IMPORT
Sessions tab (and the window's header menu), GM only. "Export everything"
downloads a JSON file of the whole ledger. "Reset ledger" downloads that
export first, then clears everything. The trash icon deletes a single session.
"Import" reads an export back in: sessions and arcs it holds are added, ones
already in the ledger get any events they are missing, and nothing is
deleted. Deleting a session or resetting leaves the session files on disk;
they are safe to remove by hand.

PAUSING
Turn off "Record statistics" in the module settings for test rolls or a
one-shot. Nothing is recorded until you turn it back on.

HOW IT COUNTS
- Damage is damage dealt: what came off HP and temporary HP when damage was
  applied from a chat card, after resistances, not counting overkill. The
  amount rolled is shown alongside it. Healing works the same way.
- Damage taken is what actually came off a character's HP, however it was
  applied, plus any temporary HP that went with the same hit. Temporary HP
  cleared on its own isn't damage, and HP that rises together with the
  maximum (a level, a rest that raised it) isn't healing.
- Kills, downs and revives are credited to whoever applied the damage or
  healing. If HP was changed by hand, they go to whoever last hit or healed
  that creature in the past minute, or to the creature whose turn it is.
- Hit % and save % only count rolls with a known result. A strike with no
  target, or a save with no DC, still counts as a roll but not toward the
  percentage.
- Saves rolled from PF2e Toolbelt's Target Helper (the save bar on spell and
  damage cards) are recorded, and a reroll there replaces the earlier result.
- Actions and feats count when their card is posted to chat. The same
  character using the same ability within 5 seconds counts once.
- Spells, skills and abilities count as contributions alongside attacks.
  "Saves forced" credits a spell or ability's user with the saves it forced
  on the other side, shown as failed / rolled. This works for saves rolled
  from a spell or damage card, including Target Helper; a save rolled from
  the sheet with no card doesn't say who forced it. "Skills" is skill
  checks that succeeded / skill checks against a DC, with initiative left
  out. Sessions before 0.3.2 have no saves forced.
- Dice: every d20 counts, including the first roll of a reroll. Fortune and
  misfortune rolls (roll twice, keep one) are left out of the Dice tab
  because they skew the curve. Luck is the average roll minus 10.5.
- Enemies are recorded by token name, so give them names your players are
  allowed to see. When no token can be found, the prototype token's name is
  used; the actor's own name never is. NPCs whose alliance is "party"
  (hirelings, allies) count on the party's side.
- Hero Points count as spent when one goes down and a reroll follows within
  10 seconds (or all at once while dying, to stabilise). Any other decrease,
  such as a reset by the GM or by Workbench's Hero Point Handler, is kept as
  lost and not counted.
- Only the GM's client records. If no GM is logged in, nothing is recorded.
- Sessions recorded before 0.3.0 have no damage dealt, since that wasn't
  recorded yet. Their rolled damage is still there.

MACROS
A macro that posts its own chat message can count as an ability use by adding
this flag to the message:
  flags: { "pf2e-campaign-ledger": { ability: "Keep Them Breathing" } }
The flag can also be set afterward with
  message.setFlag("pf2e-campaign-ledger", "ability", "Vicious Swing")

WHERE THE DATA LIVES
One JSON file per session in Data/worlds/<your world>/pf2e-campaign-ledger/,
and one per chat archive (chat-<random>.json) beside them.
The list of sessions and arcs is a world setting. Back up the world folder
and you've backed up the ledger.

CHANGES
0.4.1
- Archiving files each message with the session it was posted in (the last
  one started before it), so the last session's recap and anything posted
  between sessions no longer land at the top of the next session's archive.
  One archive run can add to several sessions.

0.4.0
- Chat archive: End session offers to archive the chat log with the session
  and clear it; "Archive chat" does it at any time. Archived chat opens from
  the Sessions tab with search and filters. The GM's copy has everything;
  players read a copy of the public messages without PF2e's GM-only parts.
  Only the active GM archives. Settings "Offer to archive the chat at End
  session" and "Players can read the archived chat" (both on).
0.3.5 (from the 20 Oct review, continued)
- A session nobody ended ends by itself when the next roll comes more than
  10 hours after its last event (setting "Hours between sessions"); the GM is
  whispered and a new session starts. "Resume last session" reopens the last
  ended session.
- Import: an export can be read back in from the Sessions tab or the window's
  header menu. Sessions and arcs are matched by id, missing events are added,
  nothing is deleted. Export is also in the header menu.
- The "Open the ledger" button in Settings now respects "Players can open the
  ledger"; a player with it off gets an empty window. The GM-only buttons
  check for the GM on the way in as well.
- Enemies with no token on the map are named by the prototype token, never
  by the actor's own name (stat-block names stayed out of the players' view
  before only when a token was on the current scene).
- Encounters are named after the scene's navigation name, and the GM can
  rename one from the Encounters tab (pencil).
- Hero Points: only a point that goes down with a reroll following within
  10 seconds counts as spent (or all at once while dying). Resets are kept as
  lost and not counted; Workbench's Hero Point Handler no longer inflates it.
- NPCs with alliance "party" count on the party's side (damage splits,
  kills vs downs, saves forced).
- Damage taken is only counted when HP itself changed; temporary HP that
  went with the hit is folded in (temp). Clearing temporary HP alone, or HP
  rising with its maximum, is no longer damage or healing.
- The window only redraws when something it shows has changed and not while
  you're typing in one of its fields; the scroll position and the open tab
  are kept, also after closing and reopening it. The Encounters tab groups
  events once instead of once per encounter.
- Smaller: End session asks first; the Party note said damage was "as
  rolled" (it is as applied); players refetch a session that just ended;
  a dying badge toggle no longer counts a second death; Reset and deleting
  the running session forget the running combat; a scope pointing at a
  deleted session falls back to the whole campaign; events are tagged to the
  running encounter even when the GM is looking at another scene; Toolbelt
  rerolls find the exact earlier save.
0.3.4 (from the 20 Oct review)
- Persistent damage is credited to whoever put that damage type on the
  creature (the acid flask's acid, the spell's fire), read from the persistent
  part of their damage roll, and only failing that to whoever last hit it. It
  used to be credited to the creature taking it (PF2e rolls it from the
  condition, so the card names the victim as the source). Other damage a
  creature does to itself goes to its last attacker. Marked pd: true.
- A session file that can't be read (server down, a broken file) is no longer
  treated as an empty session and overwritten by the next save: recording
  stops with an error until it can be read.
- A failed save of the session file now tells the GM once; the events stay in
  memory and the next roll tries again.
0.3.3
- A GM whisper when a session starts recording (setting startNotice).
