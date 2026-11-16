# PF2e Campaign Ledger: guide

The details the [README](../README.md) leaves out.

## Chat archive

"End session" offers to archive the chat log with the session and clear it (the box is ticked; the "Offer to archive the chat at End session" setting turns the offer off). "Archive chat" at the top of the ledger does the same at any time, into the running session, or the latest one. When the session already has an archive, the prompt says how many messages came since.

Each message is filed with the session it was posted in, so a recap or a whisper left over from the last session goes with that session, not the new one. Only the active GM archives (either of their tabs). Every message is saved as it looked in chat, the files are read back to check them, and only then are those messages deleted; anything posted meanwhile stays. The recap is posted after the chat is cleared.

Each archive is two files. The GM's copy has every message, whispers and blind rolls included, with what the GM saw (DCs, modifiers). The players' copy has only the messages everyone saw, as the players saw them: PF2e's GM-only parts (DCs, modifiers, roll formulas) are taken out, and a speaker whose name the players couldn't see shows as "Unknown". Players read their copy when they can open the ledger and "Players can read the archived chat" is on.

The GM's copy has a random file name and is listed on a GM-only journal entry, "Campaign Ledger (GM data)". Don't delete that entry. If it's ever gone, `game.modules.get("pf2e-campaign-ledger").api.rebuildChatIndex()` lists the archive files again. If the players' list loses an archive (after an Import, say), it's put back the next time the GM loads the world.

**Deleted sessions.** Deleting a session, or resetting the ledger, leaves its archived chat on the server. The archive window lists it under "Deleted sessions" for the GM, unless you ticked "Take its archived chat off the list too" when deleting. The files themselves are never deleted by the ledger; remove them from the world's `pf2e-campaign-ledger` folder by hand if you want them gone.

## Who was there

With Bayard's Campaign Journal on, a session's "Who was there" comes from the "At the table" ticks of the Journal recap whose played date is the session's day: each ticked player's character, or the player's name when they have none. Without such a recap, it's the party characters who did something in the session (a Hero Point reset doesn't count). Each ended session keeps its totals in the session list, so the Sessions tab doesn't read every session file.

## Quests

With PF2e Campaign Trackers on, the recording GM notes when a quest is revealed and when an objective or step the players can see is marked done or failed, in the running session (Trackers keeps no time for these). Marked open again, it comes back out. Changes while no session is running aren't recorded, and don't start one. The recap counts them by quest.

## Correcting an entry

Attribution is automatic and sometimes wrong. In an encounter's round-by-round log, the GM's pen on any line opens a small window: change who did it (or, for damage taken, a down, healing or a revive, who gets the credit), or delete the line. The change is saved with the session. A GM who has the world open in two tabs corrects the running session from the tab that's recording.

## Session numbers as Markdown

The page icon on the Sessions tab saves a session's numbers as a Markdown file: who was there, the recap's highlights, and the party's table (characters, then allies and companions). Players get the same file from their copy of the ledger, without the market line, which is the GM's.

## Two GM tabs, and saving

One GM with the world open in two browser tabs records once: the tabs agree which one records, and when that one closes, reloads or goes to sleep, another takes over within a few seconds, with nothing missed. A tab that was only busy (a long scene load) and comes back may have handled the same rolls as the other tab meanwhile; those rolls, and changes to characters linked to their actors, count once. End session from the tab that isn't recording asks the recording tab to do it, so the session's last few seconds aren't left out. While another tab is open, each save reads the file first and keeps what the other tab added.

Sessions save 30 seconds after the first unsaved event, at the end of each round, when combat ends and when the session ends. Players' open ledgers update after each save.

## API

`game.modules.get("pf2e-campaign-ledger").api`:

- `open()`: open the ledger.
- `sessions()`: the sessions, oldest first: `{ id, name, arc, arcName, start, end, running }`.
- `stats(scope)`: totals per character and creature, as the tables count them. `scope` is `"all"`, `"session:<id>"`, `"arc:<id>"` or `"arc:none"`. Players get the party rows only, and nothing when the ledger isn't open to them.
- `startSession()`, `endSession()`, `resumeSession()`.
- `importLedger(json)`: import an export (the JSON text).
- `archiveChat(sessionId)`, `viewChat(sessionId)`, `archivesOf(sessionId)` (GM), `publicArchivesOf(sessionId)`, `rebuildChatIndex()`.

**Abilities from macros.** A macro that posts its own chat message counts as an ability use when the message carries `flags: { "pf2e-campaign-ledger": { ability: "Keep Them Breathing" } }`, or when it's set afterward with `message.setFlag("pf2e-campaign-ledger", "ability", "Vicious Swing")`.

## Where the data lives

One JSON file per session in `Data/worlds/<your world>/pf2e-campaign-ledger/` (`<session id>.json`), and one per chat archive (`chat-<random>.json`) beside them. The list of sessions and arcs is a world setting. Back up the world folder and you've backed up the ledger.
