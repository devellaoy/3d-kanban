# Controls

Back to the [README](../README.md).

| Key | Action |
| --- | --- |
| W A S D / arrows | Walk (hold Shift to run); on the ladder, W and S climb; in a car, W is the gas, S brakes and reverses, A and D steer |
| Space | Jump (you can land on desks, couches and the cars in the garage); in a car, brake |
| Mouse | Look around, the same in first and third person: click the office to capture the mouse, Esc frees it. The dot in the middle of the screen (the crosshair) is what you aim at, and closing a window puts you straight back to looking around. In third person your character turns to face where the camera looks, standing still too. The third-person camera turns with the mouse with no lag, and zooming (wheel) glides. *In 3d-kanban*, ⚙️ Settings → **🧍 You** → **Mouse sensitivity** (25–200%, 100% the usual speed, kept in your browser) sets how far the mouse turns you, captured or dragging |
| Click | Use what the crosshair is on, like E (with the basketball, hold to shoot). In third person it has to be in reach of your character's eyes and in their sight, not just the camera's (no using a desk past the end of a wall beside you). With the mouse free (a touch screen), a tap in third person uses what you tapped instead, with the same reach and sight |
| Wheel | Third person: zoom the camera in or out |
| E | Interact: hire a worker, open its terminal, read a board, take an issue's note off the board, prompt a board agent, call a meeting in the meeting room, draw on the whiteboard, read the docs at the bookshelf, watch the TV (*in 3d-kanban*, with nobody sharing a screen, its window: put a YouTube link on it, watch it big, change or stop it), sit down (or get up), ride the elevator, climb the ladder (or get off it), slide down a fire pole, grab a coffee, take a smoke break, tee off at the golf tee, pet the dog, pick up the basketball (then hold E and let go to shoot), order a drink at the rooftop bar, blow the DJ's air horn, step up to the dart board or the axe lane on the roof (then hold Space and let go to throw), get into one of the cars in the garage (behind the wheel, or beside whoever's driving) or out of it, knock through the north wall past the gong for 2 more desks (at the **🚧 Room to grow** sign). In the [castle](maps.md#the-castle): sit on the throne, where E is for whoever's first in line (or the Hand of the King, with nobody waiting), and speak to the Hand to send out a new worker |
| K | On the castle's throne: speak to the Hand of the King, to send out a new worker |
| P | Prompt: give a task to a new worker, or to the one at this desk |
| C | Changes: the files the worker at this desk changed and their diff; commit, discard or open a PR |
| B | Open a shared shell at an empty desk |
| R | Resume a sleeping worker (or restart a shell) |
| X | Send a worker home (frees the desk; a worker with its own worktree asks what to do with it). In the [castle](maps.md#the-castle), the Kingsguard takes it down to the dungeon |
| L | Hang a big sign over the desk you face (*Operations*, *Code cleanup*), in one of seven colors; again to change it or take it down |
| O | Have an agent open the pull request for a worker on its own branch (it pushes and writes it up; a kanban task's worker runs the task's PR step), or see the one it has (a worker across several projects gets one in each) |
| J | The kanban view (`/kanban`), on the project of the floor you're on; facing a kanban task's worker, that task's conversation. Its **🏢 3D** button brings you back to the same floor |
| N | Go to the worker that has waited longest on someone; again for the next one |
| F | Hang a picture from the web on a wall (scroll to size it, click to hang it) |
| Q | Put back the issue card you're carrying, or drop the basketball |
| H | These controls; in a car, honk the horn |
| T / Enter | Chat |
| Enter, in a prompt box | A new line (**Shift + Enter** too). **Ctrl/⌘ + Enter** sends; on a phone, tap the send button |
| G / 1–6 | Emote: hold G for the wheel (point and let go) or press 1–6 to wave, give a thumbs up, clap, dance, point or facepalm; everyone on your floor sees it |
| / | Search the chat and every terminal on your floor |
| Ctrl + K (⌘K on a Mac) | Command palette: find a worker, issue, PR, service, board, teammate or action; Enter opens it, Shift+Enter walks you there first |
| V | Join voice; in voice, hold to talk (you're muted when you let go) |
| M | Mute / unmute in voice |
| Tab | The ☰ menu (every window, and what shows on screen) and the floor list under the project: pick a floor to go there |
| Esc | Close any window (a terminal too) and get back to looking around |
| Ctrl + [ | Send Esc to a terminal instead, to close a menu like Claude's `/skills` or interrupt Claude. **⎋ Esc** in the terminal's header does the same |

### At a kanban task's worker

A worker hired for a [kanban task](kanban-coupling.md) (its card says `🗂️ #14 · …`, its name tag `Ada · #14`) takes some keys its own way:

| Key | Action |
| --- | --- |
| C | The task's **Changes window**: a tab per repository of the task (with its PR number), and **All changes** / **Per commit** (the branch's commits, newest picked, each with its own files and diff) / **✏️ Uncommitted (n)** while its worktree has some. While the worker is on this floor it follows its checkout live, with upstream's commit, discard and open-a-PR; otherwise the office reads the task's worktree or branch (read-only, ↻ to read again) |
| E | Its window has tabs: **🖥️ Terminal** (the terminal as usual, with the keys), **🗂️ Task #14** (the task as the kanban shows it: the conversation with its composer and history, the plan, runs and verdicts, PRs and actions). The task's changes are the window's own **🌿 Changes** button, which opens the Changes window above (no Changes tab inside). It opens on the Task tab the first time, then on the tab you last had for that worker. Typing in the task's composer, or files dropped on it, never reach the terminal |
| P | While the task is in progress, waiting or in review: **💬 Message task #14**, it goes on the task's conversation and the kanban process carries on with it; **Type straight into the terminal instead** sends it as keys. For a task in To do, Done or the archive, P is the ordinary prompt. Ask a worker → a task's worker is a message on its task the same way. A reviewer only takes its terminal. With an issue card in hand, P at an empty desk makes the issue a kanban task there |
| R | Retry the task when it waits (stopped, failed, interrupted) |
| X | Send it home: **Move task #14 to Done** is ticked when the task is in review, unticked otherwise; the worktree choices are upstream's. A reviewer's review round is abandoned |
| J | That task's conversation on the kanban |
| N | Counts it while its task waits on a person (a question, the plan's approval, a failed phase) or its review is unseen |

Hiring at an empty desk (E or P), or a new worker from **✍️ Ask a worker**, can tick **🗂️ Run as a kanban task (plan → implement → review)**: the task goes on the kanban and starts at that desk. The box starts unticked in every new dialog. The **📋 Task queue** form has the same box: ticked, **Start as a kanban task** puts the task on the kanban, where it starts at the next free desk or waits its turn (it's listed under *🗂️ Kanban on this floor* meanwhile). The kanban's **📍 Show in 3D** opens `/?floor=<id>&worker=<id>&desk=<id>`: the office takes you to that floor and desk and opens the worker's window on its task.

You can also click a nearby desk to interact with it, or click a worker in the Workers panel (**🤖 Workers**, top right) to open its terminal.

On a phone, use the 2D view at `/lite` instead: a terminal there has a row of keys under it (**1** **2** **3**, the arrows, Enter, Tab, Esc, Ctrl+C) and a box to send a prompt. See [Features](features.md).

## In the kanban view

The kanban view (`/kanban`, **🗂️ Kanban** in the ☰ menu or on the 2D view) has keys of its own:

| Key | Action |
| --- | --- |
| / | Search the cards |
| N | New task |
| Tab / Shift + Tab | Move between cards and buttons; Enter (or Space) on a card opens its detail |
| M | On a card: move it to another column (the same as its **⋯** button, and what dragging it does). Columns it can't go to are greyed out with the reason |
| ← / → | Between the detail's tabs; on the detail's left edge, make the panel wider or narrower |
| Ctrl/⌘ + Enter | Send a comment or an answer; save the new-task dialog |
| Esc | Close the window on top, then the task's detail |

## In a terminal

The prompt edits the way it does in your own terminal (iTerm2's *Natural Text Editing*, or VS Code's), in Claude Code, Codex, OpenCode and a shell alike:

| Key | Action |
| --- | --- |
| Shift + Enter | A new line in an agent's prompt, without sending it (in a shell it runs the line, like Enter) |
| Ctrl + ⌫ / ⌥ + ⌫ | Delete the word before the cursor |
| ⌘ + ⌫ | Delete to the start of the line (Mac) |
| ⌘ + ⌦ | Delete to the end of the line (Mac) |
| ⌘ + ← / → | Jump to the start / end of the line (Mac) |

Shift + Enter adds a new line in the prompt boxes too (hire, ask, queue, comments); they send with Ctrl/⌘ + Enter. In a terminal it is the agent's own new line.
