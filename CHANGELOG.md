# Changelog

## 1.2.0

Everything from the code review in one release (1.1.1 was never released and is folded in here).

- Companions, familiars, summons and NPCs on the party's side are shown in their own group, Allies and companions, under the characters, still counted with the party.
- Friendly fire: damage dealt to your own side is counted apart, with its own column and a line in the recap. Damage a creature does to itself counts for nobody, in older sessions too.
- Luck on the Dice tab is judged by the number of rolls: About average, Running hot or Running cold, or the difference.
- Damage and healing applied by hand show in the round-by-round log.
- The GM can correct any line of the round log: credit it to someone else, or delete it.
- The Sessions tab shows who was there, and with two sessions or more, small charts of the party's hit rate, damage dealt and taken and times downed per session.
- Save a session's numbers as Markdown (the page icon on the Sessions tab), to go beside a recap.
- The recap adds who was there, and with the author's other modules on, clues found, money spent and earned at the market, and people met.
- A session no longer starts on the GM's own rolls with no player logged in (new setting, on by default).
- A session that ended by itself has its recap whispered to the GM.
- A party member marked dead without Dying reaching its maximum is recorded as a death, once.
- Deleting a session can take its archived chat off the list; otherwise it shows under Deleted sessions in the archive window.
- The archive prompt says how many messages came since the last archive.
- The ledger opens on the running session.
- Keyboard: every control is a button or field with a name; Tab, the arrow keys between tabs, and once you've clicked in the ledger, Space and the arrows stay with it.
- Sessions save every 30 seconds and at the end of each round, and players' ledgers update without the session list being rewritten each time.
- A Target Helper update with no saves no longer starts a session.
- API: `sessions()` and `stats(scope)` replace `Store` and `aggregate`. See the guide.
- README shortened; details moved to docs/guide.md.
- One GM with the world open in two browser tabs no longer records twice: only one tab records, and when another tab takes over, what each recorded is kept. Recaps and notices aren't posted twice.
- A player's Revert on a damage card someone else posted is now taken back too: Foundry doesn't let them mark the card, so their client tells the recording GM which card it was.
- Revert also takes back the Dying and death the card caused.
- Damage a creature does to itself, and persistent damage whose source isn't known, goes to whoever last hit it only within the past minute, like other hand-applied damage.
- Who put persistent damage on a creature is forgotten when that damage ends or the combat ends; recent hits and checks are forgotten when a session ends.
- A reroll that turns a miss into a hit makes the attacker the last to hit the target (and a hit turned into a miss undoes that).
- A recovery check that lowers Dying is no longer logged as "is dying".
- The first HP change of a combatant on a scene the GM isn't viewing is recorded.
- Two changes to the session list at the same moment (a rename as a roll starts a session, say) no longer undo each other.
- New sessions are numbered one past the highest "Session N", so a deleted session's number isn't given out again.
- Opening the ledger twice quickly no longer makes two windows.
- Deleting a session or resetting the ledger says that archived chat stays on the server.
- Import skips sessions whose id can't be a file name, and says how many; arcs and encounters with odd ids are left out.
- A character renamed mid-campaign shows under its current name.
- A damaged entry in a session file no longer stops the ledger from drawing.
- Names in notices and tooltips show as plain text.
- With "Record statistics" off, rounds and combatants joining aren't recorded either (an encounter still closes when combat ends).
- Window size and place are kept per world and per user; the place saved before carries over.

## 1.1.0

- Export a session's archived chat as Markdown: the button at the top of the Chat Archive window saves who spoke and when, what they wrote, and each roll's name, total and result, oldest first. The GM chooses the players' copy or the GM copy (whispers and DCs included); players get their copy.

## 1.0.0

- The Campaign Ledger and Chat Archive windows remember their size and place, in each browser.
- Restoring a window from minimized brings it back at its full size; on Foundry 14.370 it came back as a thin strip.
- Verified on Foundry 14.370.

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
