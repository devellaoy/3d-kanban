// The rows of the controls help (openHelp in hud.ts), in the order it shows them: a key or an emoji, and
// what it does. A new control is a new row here.

import { IS_MAC } from './termkeys';

export const HELP_ROWS: readonly (readonly [string, string])[] = [
  ['W A S D', 'Walk (hold Shift to run)'],
  ['Space', 'Jump'],
  ['☕', 'Press E at the coffee machine in the kitchen for a minute of quicker walking and higher jumps. Three cups in a row gives you the jitters'],
  // Third person looks around with the mouse too.
  ['Mouse', 'Look around, in first and third person alike (click to capture the mouse, Esc to free it). The dot in the middle of the screen is what you aim at'],
  ['Click / E', "Use what you look at: hire a worker, open its terminal, read a board, call a meeting in the meeting room, watch the TV (or put a YouTube link on it), put a song on the jukebox, tee off from the balcony, sit on a couch, a beanbag, a chair or the balcony bench (walk off to get up)"],
  ['👥', 'Click someone under "In the office" to walk over to them (on another floor, you ride the elevator first). The line under their name says what they have open or where they are'],
  ['🛗', 'Every project is a floor: step into the elevator on the north wall and press E (or click the project name, top left) to go to another one or add a project. It goes down to the garage too, and back up from there'],
  ['🤖', 'An agent stands by the issues board, the PR board and the task queue. Press E at one and type what you want: it runs as an agent that knows that board. O there opens its terminal, X sends it home'],
  ['📝', 'The whiteboard on wheels between the desks and the lounge: press E to draw on it with everyone on your floor, live. What you draw stays up on the board'],
  ['🕹️', 'The arcade cabinet in the lounge plays BLOCKFALL: arrows (or WASD) move and turn, Space drops, C holds, P pauses. Everyone on the floor sees your game on it, and E there watches whoever is playing. One of your workers needing input pauses it'],
  ['🎉', 'Whenever a pull request merges, the gong next to the PR board rings, confetti rains down all over the floor and every worker gets up on its desk for a quick dance. Walk up to the gong and press E to bang it yourself'],
  ['N', "Next worker that needs you: go to whoever has waited longest (needs input, or done and nobody's looked), and again for the next one. Arrows at the edge of the screen point to the ones out of sight"],
  ['🏀', 'The hoop on the west wall, by the exit door: E at the ball picks it up. Hold E (or the mouse) and let go when the meter is in the green to sink it. It goes where you look. Q drops it. Everyone on your floor sees your shot'],
  ['🏎️', "The Lambos and Ferraris in the garage: E at one gets you behind the wheel, or beside whoever's driving it. W is the gas, S brakes and reverses, A and D steer, Space brakes, H honks and E gets you out. Everyone on your floor sees you drive by"],
  ['🍸', 'The elevator goes up to the rooftop bar: a DJ playing drum and bass under the lights, and the city all around. Press E at the bar for a drink (it goes to your head for a bit) and at the DJ booth for the air horn'],
  ['🎯', 'Up on the roof, in the corner past the DJ: a dart board and an axe-throwing lane. E at either steps up to the line. The mouse (or the arrow keys) aims, and your hand wanders more after a few drinks. Hold Space (or the mouse button) and let go in the green: three darts a visit, five axes a round, chalked up for everyone up there. E steps back'],
  ['Wheel', 'Zoom the camera in or out in third person'], // no more drag to orbit
  ['P', 'Prompt: give a task to a new or existing worker at the desk you face'],
  ['C', 'Changes: what the worker at the desk you face changed — files and diff, commit, discard, open a PR'],
  ['B', 'Open a shared shell (dev servers, git, tests) at an empty desk'],
  ['R', 'Resume a sleeping worker'],
  ['X', 'Send a worker home (frees the desk)'],
  ['L', 'Hang a big sign over the desk you face ("Operations", "Code cleanup"), or change or take down the one there'],
  ['🚧', 'Room to grow: E at the sign on the north wall past the gong knocks through into a back office with 2 more desks, and again for 2 more. The same sign walls a row back up'],
  ['F', 'Hang a picture from the web on a wall. Look at a picture and press E to move, edit or take it down'],
  ['Q', 'Put back the issue card in your hands (E at a note on the issues board, or ✋ Pick it up in an issue; then E at an empty desk, a worker or the queue board), or drop the basketball'],
  ['🐶', 'Walk up to the office dog and press E to pet it. When a worker needs input, it runs to that desk and barks. Name it in ⚙️ Settings'],
  // An agent opens the pull requests now, in every repository the worker works in.
  ['O', 'Have the worker’s agent open pull requests for its branch (in every repository it works in, following the prompt in ⚙️ Settings), or see the ones it has'],
  // The kanban view, on the floor you are on; facing a task's worker, that task.
  ['J', 'Switch to the kanban view of this floor’s project (🏢 3D there brings you back). Facing a kanban task’s worker, it opens that task’s conversation'],
  // The keys at a kanban task's worker.
  ['C 🗂️', 'At a kanban task’s worker: the task’s Changes window — a tab per repository, all changes, per commit or uncommitted; live from its checkout while it’s here, with commit, discard and open a PR'],
  ['E 🗂️', 'At a kanban task’s worker, its window has tabs: 🖥️ Terminal and 🗂️ Task #14 (the task’s conversation with its composer, plan, runs and PRs, as on the kanban). It opens on the Task tab the first time, then on the tab you last had; 🌿 Changes in its header opens the task’s Changes window'],
  ['P 🗂️', 'At a kanban task’s worker: a message on its task, which carries the kanban process on (or type straight into its terminal instead). A reviewer only takes its terminal. With an issue card in hand, P at an empty desk makes it a kanban task there'],
  ['R 🗂️', 'At a kanban task’s worker whose task waits (stopped, failed, interrupted): retry it'],
  ['X 🗂️', 'Sending a kanban task’s worker home can move its task to Done (ticked when the task is in review); a reviewer’s review round is abandoned'],
  ['T', 'Chat'],
  ['G / 1–6', 'Emote: hold G, point at one and let go (or tap G and click one), or press 1–6: wave, thumbs up, clap, dance, point, facepalm. Everyone on your floor sees it'],
  ['/', 'Search the chat and every terminal on your floor, back to before the office last restarted'],
  [IS_MAC ? '⌘K' : 'Ctrl+K', 'Command palette: type a few letters to find a worker, issue, PR, service, board, teammate or action. Enter opens it, Shift+Enter walks you over to it first'],
  ['V', 'Join voice. In voice, hold V to talk (push to talk): you’re muted once you let go. Leave voice from the ☰ menu'],
  ['M', 'Mute or unmute your mic in voice. ⚙️ Settings can have you join muted, for push to talk'],
  ['Tab', 'The ☰ menu, top right: every window, and what shows on screen. Pin what you use most to the top bar'],
  ['🌐', 'Multiplayer: connect the office to a server in ⚙️ Settings → Multiplayer, share a floor, and visit other players’ offices from ☰ → Players. A visit is read-only: you can walk, chat and play, not change anything'],
  ['Esc', 'Close any window and get back to looking around'],
  ['Ctrl + [', 'Send Esc to a terminal instead, to close a menu like Claude’s /skills or interrupt Claude. ⎋ Esc in the terminal’s header does the same'],
  ['⚙️', 'Settings (in the ☰ menu): switch between first and third person'],
];
