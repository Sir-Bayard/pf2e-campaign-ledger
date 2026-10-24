# Changelog

## 0.4.3

- The Revert button on PF2e's damage or healing card now takes back what the ledger recorded for that card: the damage or healing dealt and taken, and any kill, down or revive it caused. The undo itself is no longer counted as healing (or as damage).
- A kill, down or revive from HP changed by hand goes to whoever last hit (or healed) that creature in the last minute, and a missed attack no longer counts as a hit. With no recent hit it goes to whoever's turn it is, but only when they're on the other side (the same side, for healing); otherwise it's left unattributed.
- Saves rolled through PF2e Toolbelt's Target Helper: two different saves with the same die and total are no longer taken for one. A save Toolbelt copies onto the spell's damage card still counts once, also when that card changes again later.
- A damage card that changed no HP (all absorbed by a shield, or only persistent damage added) no longer takes over the damage, kill or down of a card posted just before it on the same creature.
- Clearer wording on the import error message.

## 0.4.2

- The Arcs list says "1 session" instead of "1 sessions".
- In the chat archive, a whisper's "To:" line sits under the sender instead of running into the time.

## 0.4.1

- Archiving files each message with the session it was posted in (the last one started before it), so the last session's recap and anything posted between sessions no longer land at the top of the next session's archive. One archive run can add to several sessions.

## 0.4.0

- Chat archive: End session offers to archive the chat log with the session and clear it; "Archive chat" does it at any time. Archived chat opens from the Sessions tab with search and filters. The GM's copy has everything; players read a copy of the public messages without PF2e's GM-only parts. Only the active GM archives. Settings "Offer to archive the chat at End session" and "Players can read the archived chat" (both on).

## 0.3.5

- A session nobody ended ends by itself when the next roll comes more than 10 hours after its last event (setting "Hours between sessions"); the GM is whispered and a new session starts. "Resume last session" reopens the last ended session.
- Import: an export can be read back in from the Sessions tab or the window's header menu. Sessions and arcs are matched by id, missing events are added, nothing is deleted. Export is also in the header menu.
- The "Open the ledger" button in Settings now respects "Players can open the ledger"; a player with it off gets an empty window. The GM-only buttons check for the GM on the way in as well.
- Enemies with no token on the map are named by the prototype token, never by the actor's own name (stat-block names stayed out of the players' view before only when a token was on the current scene).
- Encounters are named after the scene's navigation name, and the GM can rename one from the Encounters tab (pencil).
- Hero Points: only a point that goes down with a reroll following within 10 seconds counts as spent (or all at once while dying). Resets are kept as lost and not counted; Workbench's Hero Point Handler no longer inflates it.
- NPCs with alliance "party" count on the party's side (damage splits, kills vs downs, saves forced).
- Damage taken is only counted when HP itself changed; temporary HP that went with the hit is folded in (temp). Clearing temporary HP alone, or HP rising with its maximum, is no longer damage or healing.
- The window only redraws when something it shows has changed and not while you're typing in one of its fields; the scroll position and the open tab are kept, also after closing and reopening it. The Encounters tab groups events once instead of once per encounter.
- Smaller: End session asks first; the Party note said damage was "as rolled" (it is as applied); players refetch a session that just ended; a dying badge toggle no longer counts a second death; Reset and deleting the running session forget the running combat; a scope pointing at a deleted session falls back to the whole campaign; events are tagged to the running encounter even when the GM is looking at another scene; Toolbelt rerolls find the exact earlier save.

## 0.3.4

- Persistent damage is credited to whoever put that damage type on the creature (the acid flask's acid, the spell's fire), read from the persistent part of their damage roll, and only failing that to whoever last hit it. It used to be credited to the creature taking it (PF2e rolls it from the condition, so the card names the victim as the source). Other damage a creature does to itself goes to its last attacker. Marked pd: true.
- A session file that can't be read (server down, a broken file) is no longer treated as an empty session and overwritten by the next save: recording stops with an error until it can be read.
- A failed save of the session file now tells the GM once; the events stay in memory and the next roll tries again.

## 0.3.3

- A GM whisper when a session starts recording (setting startNotice).
