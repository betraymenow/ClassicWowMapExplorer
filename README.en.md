# MapExplorer

Fly over the World of Warcraft world, drawn from your own game install. Everything is read straight from the game files on your computer; nothing is hosted, uploaded or downloaded.

Built for WoW Classic, with Eastern Kingdoms and Kalimdor loaded as one seamless world.

## Get started on Windows

You need **Windows 10 or 11** and **World of Warcraft Classic** installed. Nothing else to install.
On Linux, see **[Get started on Linux](#get-started-on-linux)**.

1. Download **MapExplorer-portable.zip** from the
   **[latest release](https://github.com/Coldensjo/ClassicWowMapExplorer/releases/latest)** and unzip
   it anywhere.
2. Double-click **MapExplorer.exe**. Map Explorer opens in a window of its own.
   The first time, Windows may say *"Windows protected your PC"*, because the program isn't signed:
   click **More info**, then **Run anyway**.
3. It finds World of Warcraft by itself and the world opens. If it can't find it, click
   **Choose your World of Warcraft folder** (or drag the folder onto the window) and pick the
   folder that contains `_classic_` or `_classic_beta_`, usually
   `C:\Program Files (x86)\World of Warcraft`. The window calls it an upload, but the files never
   leave your computer.

Click to look around, fly with **W A S D**, and hold **Shift** to go faster.
Close the window when you're done.

### About the portable version

- **It's portable**: no installer and no admin rights. Keep `MapExplorer.exe` next to its `app`
  folder; to remove it, delete the folder.
- **Its own window**: the window is Microsoft Edge (or Chrome, if Edge is missing) in app mode,
  showing Map Explorer with no tabs or address bar. `MapExplorer.exe` serves the `app` folder to it
  at `http://127.0.0.1:51730`, reachable from this computer only, and stops when you close the
  window.
- **Finding the game**: it looks where World of Warcraft's installer says it is, then in the usual
  folders on each hard drive, and serves only the game's `.build.info` and `Data` folder to the
  window, read as they are.
- **Its own settings**: highlights and other settings are kept in a `data` folder beside it, apart
  from your own browser (in `%LOCALAPPDATA%\MapExplorer` if its folder is read-only).
- **Opening it again** while it's running opens another window onto the same Map Explorer.

### Running from source

On any system with Chrome or Edge, and **[Node.js](https://nodejs.org)** (the LTS version):

1. `git clone https://github.com/Coldensjo/ClassicWowMapExplorer.git` (or **Code → Download ZIP**)
2. In the project folder, run `npm install`, then `npm run dev`.
3. Open **http://localhost:5173** in Chrome or Edge. The dev server finds World of Warcraft as the
   portable version does (set `WOW_DIR` to point it elsewhere); if it can't, choose the folder as above.

## Get started on Linux

There's no portable version for Linux; Map Explorer runs from source instead. You need
**World of Warcraft Classic** installed through Wine, Lutris, Bottles, Steam (Proton) or Heroic,
a Chromium-based browser (**Chrome**, **Chromium**, **Edge** or **Brave**), **git**, and
**[Node.js](https://nodejs.org)** 22.12 or newer.

1. Install git and Node.js. Many distributions ship an older Node.js, so check with `node -v`; if
   it's older than 22.12, install the current LTS from [nodejs.org](https://nodejs.org/en/download) or with
   [nvm](https://github.com/nvm-sh/nvm):

   ```sh
   # Debian / Ubuntu
   sudo apt install git nodejs npm
   # Fedora
   sudo dnf install git nodejs npm
   # Arch
   sudo pacman -S git nodejs npm
   ```

2. Download Map Explorer and its packages:

   ```sh
   git clone https://github.com/Coldensjo/ClassicWowMapExplorer.git
   cd ClassicWowMapExplorer
   npm install
   ```

3. Start it:

   ```sh
   npm run dev
   ```

   It looks for World of Warcraft in your Wine prefixes: `$WINEPREFIX`, `~/.wine`, `~/Games`
   (Lutris), the prefixes in Lutris's game files, Heroic's prefixes, Bottles and Steam's Proton
   prefixes, including their Flatpak versions. It prints where it found the game, or
   *World of Warcraft not found*.

4. Open **http://localhost:5173** in your browser and the world opens.

If it doesn't find the game, point it at the folder that contains `_classic_` or `_classic_beta_`:

```sh
WOW_DIR="$HOME/Games/battlenet/drive_c/Program Files (x86)/World of Warcraft" npm run dev
```

or click **Choose your World of Warcraft folder** in the page and pick it there.

Press **Ctrl+C** in the terminal to stop it. To update later, run `git pull` and `npm install` in the
`ClassicWowMapExplorer` folder.

## Features

- The whole world at once: distant terrain for both continents, with full detail streamed in around you
- Terrain textures, water and other liquids, with the game's underwater look and sound
- Buildings and props placed as in the game, with animated fire, smoke and sparks; how far props, trees and NPCs show is set in the View panel
- Ground clutter: the grass, flowers and pebbles that grow on each terrain texture, swaying in the wind; how far it reaches is set in the View panel (25–400 yards)
- Sky, fog and lighting from the game's own light data, with a time-of-day control
- Zone names and zone music, including inside inns, Ironforge and other buildings
- Each area's background sounds (birds, wind, wildlife, city bustle), by day and by night, cross-faded
  as you fly between areas and fading away high above the ground; inns and other rooms have their own
- Creatures and objects from VMaNGOS: clickable, with Wowhead links, name plates, their gear and
  animations, walking their patrols, with the game's footsteps for what they walk on
- Every other map in the install (dungeons, raids, battlegrounds, unused and test maps) laid out in
  the sea south of the continents, optionally named from afar, to fly to or walk into through their entrances
- Meeting stones outside every dungeon, with its name and levels, to be summoned to or step through into the dungeon
- Highlights for chests, herbs, ore veins, fishing pools, meeting stones or anything by name, seen from afar
- Ground tints read from the game's and server's data: the graveyard dying there sends you to,
  faction territory, creature levels against yours, subzones with their exploration XP, and fishing skill
- Inns and cities where resting builds up, drawn as the server's own trigger shapes
- The flight network, drawn over the world, and rides along it the way the game routes you
- Boats and zeppelins sailing and flying their routes on the server's schedule, to go aboard and ride
- Rain, snow and sandstorms from each zone's seasonal chances, with the game's weather sounds
- The game's world map, its explored parts filled in as you fly over them, with a click to go anywhere
- A minimap from the game's own map images, and a search to go to any zone, town or map
- Walking: a character of any race the install has models for, dressed as one of its NPCs, run,
  jumped and swum around the world as in the game, with a camera that follows behind

## Controls

| Key | Action |
| --- | --- |
| Click | Capture the mouse to look around, or open info on a creature or object |
| W A S D / arrows | Move |
| Space / E, C / Q | Up, down |
| Shift | Move faster |
| G | Go through walls, floors and the ground on / off |
| Mouse wheel | Zoom |
| 1, 2 | Jump to a continent |
| O | Overview of the whole world |
| R | Return to the start position |
| T / Shift+T | Hold to run the time of day forward / back |
| N | Reset time to the local clock |
| L | Torch light on / off |
| V | Ground clutter (grass, flowers, pebbles) on / off |
| F | Switch name plate colours between Alliance and Horde |
| M | Music and sound on / off |
| I | Names of dungeons, raids and other maps in the sea on / off (off by default) |
| H | Highlights on / off |
| Tab | World map |
| Esc | Get off a flight, boat or zeppelin |
| / | Go to a zone, town or map |
| K | Performance stats on / off |
| P | Screenshot, with everything in view loaded in full detail |
| U or Alt+Z | Hide / show the interface |
| ? or F1 | List of controls |

**Walking** (the key left of 1, labelled <kbd>`</kbd> on US keyboards and <kbd>§</kbd> on Nordic ones,
or *Walk on the ground* in the Travel menu) drops a character from where the camera is, facing the
way the camera looks, to the ground below, and moves it as in World of Warcraft. The same key flies again from
where the walking camera was.

| Key | Action |
| --- | --- |
| W / S | Run forward / backpedal |
| A / D | Turn; strafe while the right mouse button is held |
| Q / E | Strafe |
| Space | Jump; in water, swim up, and at the surface jump out |
| X | In water, swim down |
| \ (the key left of Enter on many layouts) or numpad / | Walk / run |
| Left mouse button drag | Hides the mouse and turns the camera round the character (a click still selects creatures and objects) |
| Right mouse button held | Hides the mouse, which then turns the character too; both buttons run forward |
| Mouse wheel | Camera nearer / further (up to 35 yards) |

The speeds, the jump and the falling are the game's (the server emulators' constants: 7 yards a
second running, 4.5 backpedalling, 4.72 swimming). There's no steering in the air beyond the way you
jumped. Steps up to a yard high are walked up; ground steeper than 50 degrees (see *Walkable slopes*
in Highlight) can't be climbed, and you slide down it. Buildings, caves and mines are solid and can be
walked into, up their stairs and across their floors; trees, fences and other props are not.
Water deeper than about two thirds of your height is swum in, and a shore climbs out of it. Dungeon
entrances take you in on foot. Nothing fights back: it's a sandbox.

The Travel menu chooses who walks: the race and sex (those the install has models for), the classic
or HD model, and the outfit: a Stormwind City Guard's, with sword and shield (the default; guards are
human), or any NPC's look of that race, simply dressed ones first. The choice is remembered.
Flying anywhere (a flight path, Go to, the minimap, R, O) ends walking.

Every key that switches something shows what it did, low in the middle of the screen. All of them are
also in the **View** and **Sound** menus at the top left, which remember your choices between visits.

**Go to** (top right, or press /) finds any zone, town or landmark by name, and every map in the
install, including ones nothing leads to. Empty, it lists the maps by kind. The other maps also sit
in rows in the sea south of the continents, with their names floating over them (press I), so you can fly there.
Maps that are a single building (most dungeons) lie under the sea until you fly over them.

**Meeting stones** stand outside the dungeons. Click one to see its dungeon and level range, and to
enter the dungeon. The Travel menu lists them all by continent, lowest levels first: **Go to stone**
puts you in front of one, as a summons does (on foot if you're walking), and **Enter dungeon** takes you
in through the entrance nearest the stone.

The **minimap** above it shows the game's own map around you, north up. Click it to fly there, and
zoom it with the wheel or its + and − buttons.

**Highlight** (top left) marks chests, herbs, ore, fishing pools and meeting stones within 1000 yards, through
terrain and buildings; typing a name marks every creature or object with that name on the map, however far away.
The spawn data lists every place a herb or vein can appear, so there are more marks than nodes up at any one time.
**Ground** tints the terrain by region, and the panel says what applies under the camera:
- *Graveyards*: where you'd be sent after dying there, as the server picks it (the graveyards linked to
  the zone you die in, the nearest of those); dark lines mark where two meet.
- *Territory*: friendly, hostile, contested or free-for-all, as the PvP status names it.
- *Creature levels*: each area's typical creature levels, coloured as their names would be for the level you set.
- *Subzones and exploration*: every subzone in its own colour, with the XP for discovering it.
- *Fishing skill*: the skill each zone's waters are rated at, and from what skill nothing gets away.

Graveyards, territory and flight paths are for the side chosen under *Name colours* (<kbd>F</kbd>).
**Rested areas** shows the inns and cities where resting builds up.

**Travel** shows the flight paths and flies you along them, from one flight master to another through
any in between, as the game would; move or press <kbd>Esc</kbd> to get off. Under **Boats and zeppelins**
it lists the ships and zeppelins, which keep the server's timetable: each round trip takes as long
as on the realms, waiting a minute at each dock, so one is in the same place at the same moment for
everyone. *Go to* puts you on board where it is now; *Ride* takes you along, holding still while it
docks and crossing to the other continent with it, until you move or press <kbd>Esc</kbd>. The panel
says when the next one leaves the dock nearest you, and where it goes. It also opens the
**world map** (<kbd>Tab</kbd>): the game's zone maps, filled in where the camera has been down among
an area (remembered between visits), with the camera's place on it; click a zone to fly there.

**Weather** (View menu) follows each zone's chances for the season, rolled again every ten minutes as
on the realms, or is set to one kind everywhere.

The camera position is kept in the URL, so a link brings you back to the same spot; click the coordinates
(top left) to copy it. Walking, it's the walking camera's place, and the link opens there flying.
Add `?time=HH:MM` to set the time of day.


## Troubleshooting

- **"That isn't the World of Warcraft folder"**: pick the folder one level up, the one that
  contains `_classic_` or `_classic_beta_`.
- **Direct access** (under *More options*) opens faster, but Chrome and Edge refuse folders under
  `Program Files`; use the main button for those.
- If nothing shows up, check that you're in Chrome or Edge with hardware acceleration on (for the
  portable version: Edge's *Settings → System and performance*), and that your graphics driver is
  up to date.
- **The portable version opened in a normal browser tab**: neither Edge nor Chrome was found, so
  your default browser is used. Press OK in the small Map Explorer message when you're done, to stop it.
- **"No free port between 51730 and 51749"**: other programs are using those ports; close them or
  restart your computer.

## For developers

### Spawn data

Creature and object spawns, patrols and dungeon entrances in `public/spawns` come from the [VMaNGOS](https://github.com/vmangos/core) world database. To rebuild them, download the SQLite database from the VMaNGOS `db_latest` release and run:

```sh
npm run spawns -- path/to/mangos.sqlite
```

This needs `sqlite3` on the PATH. NPC hair textures come from the community listfile, expected at `.cache/listfile.csv`.

Regions in `public/spawns/regions.json`, the flight network in `public/spawns/flights.json` and the boats
and zeppelins in `public/spawns/transports.json` come from VMaNGOS (areas, graveyard links, inns, weather,
fishing, and the transports with their round trip times and game objects), each map chunk's area read from
the game's map files, creature levels from the spawn files (run `npm run spawns` first), the client's
TaxiNodes, TaxiPath and TaxiPathNode tables (the transports' routes too), GameObjectDisplayInfo for their
models, and graveyard positions (WorldSafeLocs from classic 1.13.2, downloaded
from [wago.tools](https://wago.tools) on first run, as this client no longer ships it):

```sh
npm run regions -- [wowDir] [product] [path/to/mangos.sqlite]
```

### Scripts

- `npm run dev`: start the dev server
- `npm run build`: type-check and build to `dist`
- `npm run typecheck`: type-check only
- `npm run probe`: inspect game data from Node
- `npm run spawns`: rebuild the spawn files
- `npm run regions`: rebuild the regions, flight paths, boats and zeppelins
- `npm run portable`: build the portable version into `release/` (the zip for a GitHub release);
  needs mingw-w64 (gcc, windres), ImageMagick and 7-Zip on the PATH. The launcher is
  `tools/portable/launcher.c`, its icon `public/icon.svg`

`inspector.html` is a small test page for browsing the storage and file formats.

### Layout

- `src/casc`: CASC storage reader
- `src/formats`: WoW file formats (ADT, WDT, WDL, WMO, M2, BLP, DB2)
- `src/worker`: storage and parsing in a web worker
- `src/explorer`: world data, meshes, lighting, spawns, music
- `src/viewer`: three.js renderer, controls, particles, audio
- `tools`: Node scripts for probing data and building spawns
