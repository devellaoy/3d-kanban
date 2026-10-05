# Code layout

Back to the [README](../README.md).

Where the code lives, and where a new feature's pieces go. The office used to grow by adding to the middle of a few big files: the server's message switch, the page's key handler, its frame loop and its store. Each of those is a registry now, and a feature is a folder of its own plus one line in each list it joins. If a change has you editing the middle of `main.ts`, `server.ts`, the store or `protocol.ts`, it probably belongs somewhere else.

There are three parts: `src/client` (the page, built by Vite, with three.js), `src/server` (Node) and `src/shared` (types and pure code both use, with no Node imports).

## The kanban

The kanban's code lives in `src/client/kanban/`, `src/server/kanban/` and `src/shared/kanban/`. It joins the registries like any feature: `kanbanHandlers` and `kanbanHooks` in `src/server/ws/handlers/index.ts` (the WS messages), `kanbanRoutes` in `src/server/http/routes/index.ts` (the HTTP routes), `openKanban` in `src/server/server.ts`, `installKanban3d` in `src/client/main.ts` (with `Parts.kanban3d` in `core/parts.ts`), which installs the lounge figures of tasks on hold (`kanban/lounge3d.ts`, fed by the `kanbanLounge` slice in `kanban/loungeslice.ts`, last in `SLICES`; the seats they take are kept from players through `reserveSeatPlaces` in `features/seating`). YouTube on the Office TV lives in `src/{client,server,shared}/youtube/` and joins the same way (`youtubeHandlers`, `youtubeView` and `youtubeListView`, the `youtube` slice (which also keeps the TV's queue and settings as `youtubeList`), `installYoutubeTv` with `Parts.youtube`). The Codex limits panel lives in `src/{client,server,shared}/codex-limits/` and joins the same way: `codexLimitsHandlers` and `codexLimitsHooks` in `src/server/ws/handlers/index.ts`, the `codexLimits` slice, `installCodexLimits` in `src/client/main.ts`, its entry in the ☰ panel lists (`ui/menu.ts`, `state/persist.ts`) and `closeCodexLimits` in the `server.ts` shutdown; the kanban reaches it through `KanbanContext.codexResetAt`. The phone lives in `src/{client,server,shared}/phone/` and joins the same way: `phoneHandlers` and `phoneHooks` in `src/server/ws/handlers/index.ts` (`phone.watch`, and another floor's workers to whoever follows it; the wire contract is `src/shared/phone/protocol.ts`), the `phone` slice last in `SLICES`, and `installPhone` in `src/client/main.ts` with `Parts.phone`, its ☰ entry in `features/hud` and its row in `ui/help.ts`; the worker cards it shares with the 2D view are `src/client/shared/workercard.ts`. Its music is the TV's player model reused: `youtube/player.ts` (`SyncedPlayer`, the iframe that follows a play) is shared by `TvScreen` and `phone/player.ts` (`PhonePlayer`), `tvControls` and `tvQueue` take a source (`tvSource`, `phone/music.ts`), the `phoneMusic` slice (`phone/music-slice.ts`) is last in `SLICES`, and `sound/ducking.ts` silences the TV and the jukebox for you while your phone's music plays. The office keeps the sessions in `server/phone/music.ts` (`PhoneMusic`, each session a `YoutubeTv` of its own) behind `server/phone/music-handlers.ts`; the 🎵 Music tab is `phone/music-ui.ts` (styles in `phone/music.css`), the HUD chip while it plays with the phone put away is `phone/music-chip.ts`, and the tab reaches the floor's TV through `Parts.youtube.controlsSource()`. The size guard covers it like everything else (see [The size guard](#the-size-guard)).

## Multiplayer

Not to be confused: `src/server/relay.ts` is the service tunnels' relay (it proxies a worker's dev-server ports), while "the relay" of multiplayer is the separate server in `src/server/multiplayer/relay/` that offices connect out to.

Multiplayer lives in `src/{client,server,shared}/multiplayer/`, with the relay in `src/server/multiplayer/relay/` (run by `kanban3d relay`). `shared/multiplayer/` holds the wire protocol and the two deny-by-default tables for what a visitor may send (`allow.ts`) and see (`filter.ts`); each is `satisfies Record<…['t'], …>`, so a new message type is a compile error until someone decides what a visitor gets. It joins the registries and the existing seams: `mpHandlers` and `mpHooks` in `src/server/ws/handlers/index.ts` (the `mp.*` messages), the dispatch gate in `src/server/ws/dispatch.ts` (`visitorAllows` in `multiplayer/gate.ts`: a visitor's message passes the allow table first), a `RemoteSocket` (`remote-socket.ts`) that stands in for the browser's socket so a visitor is an ordinary client behind the outbound filter, the pipe for the visitor's own browser socket in the upgrade path (`ws/connection.ts`, `guest.ts`), `mpRoutes` in `src/server/http/routes/index.ts` (read-only GETs through the owner's office, checked against `paths.ts`), `openMultiplayer` and `closeMultiplayer` in `src/server/server.ts`, the `multiplayer` slice (`src/client/state/slices/`), the 🌐 Multiplayer category in `ui/settings-panes.ts` (`settingsslot.ts`, loaded when first shown) and the `playersAction` entry in the HUD (`features/hud/index.ts`). `installMultiplayer` in `src/client/main.ts` adds only the visit banner.

## Client

### `main.ts` and the context

`src/client/main.ts` is the install list: it makes the scene, calls each part's `install…(ctx, …)` in turn, and boots. The order is the order everything registers in (messages, keys, ticks, store topics), and it's kept on purpose, so a new feature's line goes at the end of its group unless it has to come before something.

Every part gets `ctx`: the `Ctx` type in `core/context.ts`, built by `createCtx` in `core/ctx.ts`. It has the scene, the camera, the player, the socket (`net`), sound, settings, what you're holding, the hint bar, `shake`, and the registries. A feature imports `Ctx` as a type and never imports `main.ts` (a test checks). When a part needs another one, it says which: a small `deps` object of callbacks that `main.ts` passes in (`GongDeps` in `features/gong/index.ts`), or a `Pick` of `Parts` (`core/parts.ts`, every part `main.ts` makes, by name). Parts are only read when something happens, never while installing, so a part can reach one installed after it.

### The registries

They're in `core/registry.ts`, and each is a field of `ctx`. Every registration hands back an `Off` that takes it out again.

| Registry | What it's for |
| --- | --- |
| `ctx.messages` | Server messages. `on(type, fn)` runs `fn` once the store has applied the message (`'before'` as a third argument: before it has); `onAny(fn)` runs on every message. |
| `ctx.keys` | Key presses. `add(stage, fn)` for the stages before the office's own keys (`guard`, `activity`, `emote`), and `bind({ code, when, run })` for a key of the office's own. |
| `ctx.ticks` | What runs each frame. `add(phase, fn)`, where the phases run in `TICK_PHASES` order: `pre`, `steer`, `vehicles`, `move`, `moved`, `play`, `me`, `others`, `world`, `env`, `aim`, `hud`, `render`. Within a phase, ticks run in install order. |
| `ctx.activities` | Something you're in the middle of that takes over the controls (hanging a picture, the golf tee, a car). It gets keys before the office's own, draws the hint bar, and is stopped by `stopAll(why)` when you start something else. Its place among the others is `ACTIVITY_ORDER` in `core/ctx.ts`. |
| `ctx.interactions` | What each kind of thing you can use does: `define(kind, { reach, hint, use })`, once per kind. |
| `ctx.view` | What what you're doing does to your view each frame: something you hold on to, the field of view, covering the screen, or a filter (the drunk vision). |
| `ctx.windowOpened` | What lets go when a window opens (a shot being wound up, the emote wheel). |
| `ctx.usables` | Things to use that aren't part of the building and move about (the pictures, the dog, the ball): what each has to use, and what the aim can land on. |

`tests/client-registry.test.ts` pins how each one orders and dispatches.

### Folders

- **`features/<name>/`** is the home of a feature. `index.ts` has its `install<Name>(ctx, deps)`, and beside it is whatever it needs: `controller.ts` (what it does with you), `world.ts` (its 3D things), `sound.ts` (its sound recipes), `ui.ts` and `ui.css` (its window). `features/workers/` is the one without an `index.ts`: its install functions are in `actions.ts` and `views.ts`. `tests/client-structure.test.ts` checks `main.ts` calls every feature's install function once.
- **`core/`** is the office's own parts that aren't a feature: the renderer and scene (`scene.ts`), the frame loop (`loop.ts`), the building's maps (`worlds.ts`, `maps.ts`), floors and the elevator (`travel.ts`), arriving (`arrival.ts`), where you are (`place.ts`), and the hint bar (`hintbar.ts`, with the pieces every hint is made of in `hint.ts`).
- **`input/`** is the keyboard (`keyboard.ts`, which hands every press to `ctx.keys`), aiming and clicking (`pointer.ts`), and windows and the game taking turns with both (`focus.ts`).
- **`state/`** is the store. `store.ts` declares the core fields (who you are, the people, the floors, and the floor you're on with its workers, screens, boards and queue), and `core.ts` keeps them up to date. Everything else is a slice in `state/slices/`: a module that adds its fields and topics to `Store` and `Topics` (`declare module '../store'`), sets where they start (`init`), and says what it takes in from each server message (`on`) and from each floor you arrive on (`enter`). Slices run in the order of `SLICES` in `state/slices/index.ts`, which is the order their topics fire in, so a new one goes at the end. Features follow a topic with `store.on('<topic>', fn)`. What the browser remembers between visits is `persist.ts`.
- **`ui/`** is the app shell: the HUD, the menu and the windows (settings, the palette, terminals, changes, the queue, and the GitHub windows in `ui/github/`). Each module imports its own stylesheet (`import './palette.css'`), as a feature's `ui.ts` does (`import './ui.css'`).
- **`world/`** is the engine and the scenery: toon materials and shapes (`toon.ts`), the characters (`world/character/`), the office floor (`world/office/`), the castle (`world/castle/`), the scenic loop, the sky and the city. The types they share (what you bump into, what you can use, the seats, `Office`) are in `world/types.ts`.
- **`sound/`** is the office's sound. `OfficeSound` (`sound/index.ts`, the `ctx.sound` every part uses) is a facade over `AudioCore` (`sound/core.ts`: the audio context, its buses, where your ears are) and the recipes, each in a file of its own, here (`weather.ts`, `steps.ts`) or in its feature's folder (`features/gong/sound.ts`).
- **`shared/`** (`src/client/shared/`) is what the 3D office and the 2D view at `/lite` both use: the tab title and hiring. The 2D view loads no three.js and nothing from `core/`, `features/`, `input/`, `world/` or `player/`; `tests/client-structure.test.ts` follows `lite.ts`'s imports to check.

### Stylesheets

`style.css` is the 3D office's sheet. It pulls in `styles/base.css` (the colors, the reset, panels, buttons and the window frame, which the 2D view's `lite.css` loads too), `styles/hud.css` and `styles/loading.css`. Every other sheet sits next to its module and comes in with it. A module's sheet loads in no fixed order against `base.css`, so a module rule that overrides a base rule of the same specificity has to be more specific, or live at the end of `base.css` with the others there.

### Themes

`src/client/themes/` is how the pages get their looks (the registry is `themes/index.ts`). In the code a look is an *appearance*, because *theme* already means the holiday decorations. `themes/tokens.css` is the contract: every colour, border, radius, shadow and font the sheets use is a custom property in its first `:root` block, with the default look's values. `styles/base.css` imports `themes/index.css`, which imports the tokens and then each theme.

**Adding a theme:**

1. `themes/<id>.css`: the `:root[data-theme="<id>"]` block with a value for every token, first, and after it a short section of component overrides for what tokens can't say.
2. Its `@import` in `themes/index.css`.
3. Its row in `APPEARANCES` in `themes/index.ts` (label, icon, `colorScheme`, `themeColor`).
4. `public/offline.html` keeps its own small copy of the looks (it is shown with no network, so it can't load the sheets): a `:root[data-theme="<id>"]` block of its few variables, and the theme's colour in the id → colour map of its head script.

`tests/appearance.test.ts` checks the file, the import, that every token is defined and that `offline.html` has the block and the colour, and `tests/themes-contrast.test.ts` that each theme's text and fill pairs (text on panels, text on the status colours, a button's label) reach WCAG AA contrast. Prefer a token to an override, never use `!important`, and remember `--ink` is the *line* colour (borders, outlines), not the text colour: text uses `--text` and its siblings. The same test keeps raw colours (hex, `rgb()`) out of the sheets, so a new rule uses a token.

## Server

- **`server.ts`** is the composition root: `startServer` builds the office's context a stage at a time, starts the hook server, opens the floors, and hands the context to the HTTP handler and the WebSocket.
- **`office/`** is that context (`Ctx` in `office/context.ts`: the building-wide services, sending to browsers, the floors, the people in the office, going between floors, and the checks before something happens) and the pieces that make it.
- **`ws/`** takes the sockets. Each domain's messages are handled in `ws/handlers/<domain>.ts`, a map from message type to handler that `satisfies HandlerMap<ItsClientMsg>`, and `ws/handlers/index.ts` puts them all in one `HandlerMap<ClientMsg>`: a message type with no handler, or a handler for a type that doesn't exist, fails the typecheck. The same file lists the features that keep something per person on a floor (`features`: what each lets go of when someone is `leaving` a floor, and once their socket has `closed`) and the pieces of what someone arriving on a floor is sent (`views`, one for each field of `FloorView`, put together by `office/views.ts`).
- **`http/`** answers HTTP from a route table. Each file in `http/routes/` exports its routes, and `http/routes/index.ts` lists them in the order they're tried. Every route says its `auth` (`public`, or `session` for a signed-in browser), and the `Route` type won't let you leave it out.
- **`hooks/`** is the loopback-only hook server the workers call: their agents' hook events (`/hooks/<provider>`), the board agents' queue (`/office/queue`) and `office-workers` (`/office/workers`).
- **`workers/`** is the worker manager (`WorkerManager` in `workers/manager.ts`) and its pieces: worktrees, pull requests, tasks, terminals, ACP workers, and saving to `workers.json`. `src/server/workers.ts` re-exports it for the modules that imported it from there. Where worktrees live (the folder beside the project, the older one inside it, the `node_modules` links) is `worktree-home.ts`; the git plumbing is `worktrees.ts`.
- **`providers/`** holds one adapter per agent CLI (see [Adding an agent provider](#adding-an-agent-provider)).
- **`hosting/`** is where a repository is hosted when it isn't GitHub (see [Adding a hosting provider](#adding-a-hosting-provider)): the providers (`azure.ts`, `bitbucket.ts`, each with its pure `*-map.ts`), the credentials (`credentials.ts`), the board's hand-over (`board.ts`, which `github.ts`'s `GitHub` calls when `hosted` is set) and `repoOf`. Recognising a remote is `src/shared/hosting/remote.ts`. GitHub itself stays on `gh` in `github.ts`, `workers/pr.ts` and the kanban's integrations.

The rest of `src/server/` is a module per service or per thing a floor keeps (`dog.ts`, `jukebox.ts`, `queue.ts`, `meetings.ts` for one meeting room, `meeting-rooms.ts` for a floor's rooms, `meeting-files.ts` for reading their earlier meetings and notes off the disk (served by `http/routes/meetings.ts`, which is not on a visitor's path list; the browser's view of them is `src/client/ui/meetingpast.ts`); where the office's four rooms stand, and each one's own frame, is `shared/meetingrooms.ts`), made by the office or by each `Floor` (`floor.ts`).

## Loose furniture

The office's desks, bean bags, couch, lounge poufs, whiteboard and rugs can be moved, turned and taken out in build mode (see [Features](features.md)). It is a floor's own arrangement, `FloorPlan.furniture` in `floorplan.json`, which rides the existing `plan` message (the `floorPlan` slice) and the `furniture.move`, `furniture.remove` and `furniture.reset` messages (`shared/protocol/furniture.ts`, `server/ws/handlers/furniture.ts`, denied to visitors in `multiplayer/allow.ts`). The pure model is `shared/arrange.ts` (what each piece is, where it comes, where it stands, `arrangedPlan`: the office plan with the pieces where the floor put them, and `Layout`, the back office, meeting rooms and furniture that the walking grid `officeNav` is made from) and `shared/arrange-check.ts` (the check the server makes and the browser colours the ghost by; every piece where the office comes passes it, `tests/arrange.test.ts`). The server stays free of geometry apart from that check: seats taken out are a set of ids that `nextFreeSeat`, `beanbagsOut`, `vacantSeats`, the worker manager and the kanban's desk refusal leave out, like the back office's `wing`. The browser's `store.plan()` is the arranged plan; each fixture that builds a piece registers it with `site.movables` (`world/office/fixture.ts`) and `world/office/arrange.ts`, last on the plan, moves them all; `features/build/fixtures.ts` is the build-mode controller.

## Shared

- **`protocol.ts`** is the wire protocol. It puts the domain files in `protocol/<domain>.ts` back together (`export *`) and makes the `ClientMsg` and `ServerMsg` unions every frame is one of. Keep `import type` between domain files: some name each other's types (`floors.ts` and `presence.ts` do), which only type imports can do without a cycle at run time.
- **`providers.ts`** is the provider table: every agent a worker can run, and what the office knows about each.

The rest is data and pure code both sides use: the floor's layout, maps (`shared/maps/`), the sun, the garage and so on.

## Adding a feature

A new feature adds files of its own and one line in each list it joins. For something on the floor that everyone there sees and uses, that's:

1. **Its messages** in a protocol domain file (`src/shared/protocol/toys.ts`, say). A new domain file also goes in `protocol.ts`: its `import type`, its `export *` and its members of the unions.
2. **A server handler file**, `src/server/ws/handlers/<name>.ts`, and its line in `handlers` in `ws/handlers/index.ts`. If it keeps something per person, its `FeatureHooks` go in `features` there; if people arriving on a floor need its state, that's a field of `FloorView` (`protocol/floors.ts`) and its piece in `views`. What a floor keeps is a module of its own in `src/server/`, which `Floor` makes.
3. **A state slice**, `src/client/state/slices/<name>.ts`, and its line at the end of `SLICES` in `state/slices/index.ts`.
4. **`src/client/features/<name>/`** with its `install<Name>(ctx, deps)`, and its line in `main.ts`. If another part needs what it returns, a line in `Parts` (`core/parts.ts`) too.
5. **What you can use.** The file that calls `ctx.interactions.define('<kind>', …)` also adds the kind, by augmenting `InteractKinds` in `world/types.ts` (`declare module '../../world/types'`); `tests/client-registry.test.ts` checks every kind is defined once, in the file that adds it. Something that stands in the office is a fixture: `export const <name>: Fixture<'<field>'>` in its `world.ts`, which adds the field it gives `Office` to `OfficeHandles` the same way, and a line in `floorPlan()` in `world/office/build.ts` (which won't typecheck while a field in `OfficeHandles` has no fixture giving it). `features/gong/` does both.
6. **A help row** in `HELP_ROWS` in `src/client/ui/help.ts`.
7. **A sound recipe** in its `sound.ts` (a function or class that takes the `AudioCore`), and the method on `OfficeSound` that plays it.
8. **Its CSS** next to its ui module, imported from there.

Its HTTP routes, if it has any, go in `http/routes/`, and its tests in `tests/`.

## Adding an agent provider

One adapter file in `src/server/providers/`, one entry in `PROVIDERS` in `src/server/providers/index.ts`, and one row in `src/shared/providers.ts` (its id in `AGENT_PROVIDERS`, its entry in `PROVIDER_META`). The typecheck fails until all three are there. What reads them, and the two places that still name providers one by one, are in [Provider seams](dsh-acp-integration.md#provider-seams).

## Adding a hosting provider

GitHub goes through `gh`; every other host is a `HostingProvider` (`src/server/hosting/provider.ts`) over its REST API:

1. **Its remotes** in `src/shared/hosting/remote.ts`: its `HostKind`, how `parseRemote` and `parsePrUrl` read its URLs, its qualified repository name (`azure:org/project/repo`), `prWebUrl` and `hostLabel`. `tests/hosting-remote.test.ts` covers each form.
2. **Its provider**, `src/server/hosting/<host>.ts` (with the pure mapping into `GhPull` beside it), through `hostCall` (`http.ts`), and its entry in `HOSTS` in `src/server/hosting/index.ts`. Tests stub `fetch` (`tests/hosting-azure.test.ts`).
3. **Its token**: `authOf` in `credentials.ts`, the card in `src/client/ui/signins-hosts.ts`, and its HTTPS host in `HELPER_HOSTS` (`server/gitconfig.ts`) and `bin/office-git-credential.js` for pushes.

Everything else follows from there: the PR board (`GitHub.hosted`), the kanban's PR states and branch links (`pulls/index.ts`), `office-pr` (`kanban/integrations/hosting/`) and the prompts' note (`Composer.hostingNote`).

## The size guard

`tests/size.test.ts` holds every `.ts` and `.css` file under `src/` to 600 lines. It asks `git ls-files` for them (tracked, and new ones that aren't ignored) rather than walking the folder, so a worktree checked out inside the repo can't trip it. The files that were longer when it came in are listed in `CEILINGS`, each with the length it had then: they may shrink, but never grow past it. Once one is down to 600 lines or fewer, or gone, the test fails until you take it off the list, so the list only gets shorter.

When it fails, split the file along the registries: a feature's code goes in its folder, a message handler in its domain's file, a tick or a key in the feature it's for, and what the page keeps of it in its own slice. Raising a ceiling, or adding a file to the list, only hands the problem to the next person, so the honest way to make room is to split the file. When you shrink a listed file, lower its ceiling to its new length in the same change, so it can't grow back.
