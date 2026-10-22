import { droppedFolderToSource, filesToSource, hasDirectoryPicker, pickDirectory } from '../app/folderPicker';
import { createStorageClient } from '../worker/client';
import type { SourceInit } from '../worker/protocol';
import type { Place } from '../explorer/places';
import type { SpawnInfo } from '../explorer/spawns';
import type { MapCategory, MapListing } from '../explorer/world';
import type { HighlightGroup, HighlightSettings } from './highlights';
import { CLUTTER_RANGE_DEFAULT, CLUTTER_RANGE_MAX, CLUTTER_RANGE_MIN } from './clutter';
import { Minimap } from './minimap';
import { DETAIL_RANGE_MAX, DETAIL_RANGE_MIN } from './objects';
import type { TintMode } from './regionOverlay';
import { isTyping } from './typing';
import { loadUiAssets } from './uiAssets';
import { FIXED_SPEED_DEFAULT, FIXED_SPEED_MAX, FIXED_SPEED_MIN, FLY_SPEED_RANGE, FLY_SPEED_STEP, Viewer, type HudInfo, type MeetingStone, type ViewSettings } from './viewer';
import type { CharacterLook } from './character';
import { CHARACTER_OUTFITS, type CharacterOutfit, type CharacterRace } from '../explorer/spawns';

import { setVolume, volumeSetting, type VolumeChannel } from './volume';
import { WorldMap } from './worldMap';
import { RETAIL } from '../edition';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');

/** Set in session storage on switching editions, so classic reached from retail stays classic. */
const SWITCHED_KEY = 'mapExplorer.switched';

// Retail is the edition to start in: classic opened with no view in the URL (the launcher opens
// it so) goes on to retail, unless it was switched to from retail (see setUpEdition). The mark is
// always taken, so it can't linger for a later start.
const switchedHere = takeSwitched();
if (!RETAIL && !location.hash && !switchedHere) location.replace(`retail/${location.search}`);

setUpEdition();

/**
 * A click on the world goes full screen; Escape (the browser's own) leaves it.
 */
function setUpFullscreen(view: HTMLElement): void {
	view.addEventListener('pointerdown', () => {
		if (document.fullscreenElement || document.pointerLockElement) return;
		document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
	});
}

/**
 * The page title, the retail-only View panel, and the Classic / Retail switch in the menu. The
 * portable launcher serves the classic build at / and the retail one at /retail/; the switch
 * shows only when the other one is there.
 */
function setUpEdition(): void {
	const link = $<HTMLAnchorElement>('edition');
	link.style.display = 'none';
	if (RETAIL) {
		document.title = 'Map Explorer (Retail)';
		// No NPCs on retail terrain (the spawns are classic ones), so nothing to switch on.
		for (const name of ['creatures', 'spiritHealers']) document.querySelector(`[data-setting="${name}"]`)?.closest('label')?.remove();
		link.textContent = 'Classic ⇄';
		link.title = 'Switch to WoW Classic';
		link.href = '/';
		if (location.pathname.startsWith('/retail/')) link.style.display = '';
	} else {
		link.textContent = 'Retail ⇄';
		link.title = 'Switch to retail (the live game)';
		link.href = '/retail/';
		// A server without it may answer with this same page (the dev server does): only show
		// the switch when it's another build, one that loads a different script.
		const own = document.querySelector('script[type="module"][src]')?.getAttribute('src');
		fetch('/retail/index.html').then((r) => (r.ok ? r.text() : '')).then((page) => {
			if (own && page.includes('<script') && !page.includes(own)) link.style.display = '';
		}, () => {});
	}
	// Switching keeps the place and view: the other build opens at this one's URL hash
	// (#continent/tileX/tileY/height/yaw/pitch), taken now rather than from the URL, which only
	// follows the camera once it has been still a while. Eastern Kingdoms (0) and Kalimdor (1)
	// are the same in both; Zandalar (2, retail only) and dungeons (d<map>, classic only) aren't
	// in the other, which then opens at its start.
	// The time of day too, when it's been moved off the local clock (Y, or the View panel):
	// handed over in this tab's session storage, which both builds share (one origin).
	// On the planet, the other opens on the planet too, at the same place (see Viewer.planetHandoff).
	link.addEventListener('click', (e) => {
		const hash = infoViewer?.viewHash() ?? location.hash;
		const shared = /^#[01]\//.test(hash);
		const planet = infoViewer?.planetHandoff() ?? null;
		e.preventDefault();
		try {
			sessionStorage.setItem(SWITCHED_KEY, '1');
			if (planet !== null) sessionStorage.setItem(SWITCH_PLANET_KEY, planet);
			else sessionStorage.removeItem(SWITCH_PLANET_KEY);
			if (infoViewer && !infoViewer.timeIsLocal) sessionStorage.setItem(SWITCH_TIME_KEY, String(infoViewer.timeMinutes));
			else sessionStorage.removeItem(SWITCH_TIME_KEY);
		} catch {
			// No session storage (private windows): the other build starts at the local time.
		}
		location.href = link.href.split('#')[0] + (planet === null && shared ? hash : '');
	});
}

const SWITCH_TIME_KEY = 'mapExplorer.switchTime';
/** The planet view handed over on switching editions (see Viewer.planetHandoff). */
const SWITCH_PLANET_KEY = 'mapExplorer.switchPlanet';

/** On arriving from the other build on the planet: the planet, at the place it was showing. */
function takeSwitchPlanet(viewer: Viewer): void {
	try {
		const planet = sessionStorage.getItem(SWITCH_PLANET_KEY);
		sessionStorage.removeItem(SWITCH_PLANET_KEY);
		if (planet !== null) viewer.showPlanetAt(planet);
	} catch {
		// No session storage: nothing was handed over.
	}
}

/** Whether this page was reached with the edition switch (and forgets it). */
function takeSwitched(): boolean {
	try {
		const switched = sessionStorage.getItem(SWITCHED_KEY) === '1';
		sessionStorage.removeItem(SWITCHED_KEY);
		return switched;
	} catch {
		return false;
	}
}

/** On arriving from the other build: the time of day it was showing (see setUpEdition). */
function takeSwitchTime(viewer: Viewer): void {
	try {
		const minutes = Number(sessionStorage.getItem(SWITCH_TIME_KEY) ?? NaN);
		sessionStorage.removeItem(SWITCH_TIME_KEY);
		if (Number.isFinite(minutes)) viewer.timeMinutes = minutes;
	} catch {
		// No session storage: nothing was handed over.
	}
}

const storage = createStorageClient((message) => showProgress(message));

/** A message under the buttons; errors also end the loading bar, so the buttons come back. */
function setStatus(text: string, isError = false): void {
	status.textContent = text;
	status.className = isError ? 'bad' : 'muted';
	if (isError) hideProgress();
}

// --- Loading bar ---

/**
 * How far along each loading step starts, as a share of the whole. Reading the folder is the
 * longest step (the browser listing every file), but it reports nothing, so the bar creeps
 * toward where it ends meanwhile.
 */
const LOADING_STEPS: [RegExp, number, string][] = [
	[/^Reading your folder/, 0.02, 'Reading your World of Warcraft folder'],
	[/^Reading \.build\.info/, 0.45, 'Finding the game version'],
	[/^Reading local indexes/, 0.5, 'Opening the game files'],
	[/^Reading encoding table/, 0.57, 'Opening the game files'],
	[/^Reading root table/, 0.64, 'Opening the game files'],
	[/^Reading Eastern Kingdoms/, 0.72, 'Loading Eastern Kingdoms'],
	[/^Reading Kalimdor/, 0.82, 'Loading Kalimdor'],
	[/^Placing/, 0.88, 'Placing dungeons and other maps'],
	[/^Reading lighting/, 0.9, 'Loading light and zones'],
	[/^Starting/, 0.97, 'Starting'],
];
/** Where the bar creeps to while the folder is read, and how long that takes (s). */
const FOLDER_CREEP = [0.42, 20] as const;

/** Shows the loading bar at a step, in place of the folder buttons. */
function showProgress(message: string): void {
	const step = LOADING_STEPS.find(([pattern]) => pattern.test(message));
	const appearing = $('loading').hidden;
	$('drop').hidden = true;
	$('loading').hidden = false;
	// A bar that was hidden has no width to animate from until it's laid out once.
	if (appearing) void $('loading-fill').offsetWidth;
	status.textContent = '';
	if (!step) return;
	const fill = $('loading-fill');
	const creep = step === LOADING_STEPS[0];
	const target = creep ? FOLDER_CREEP[0] : step[1];
	fill.style.transition = creep ? `width ${FOLDER_CREEP[1]}s cubic-bezier(0.1, 0.7, 0.3, 1)` : '';
	// Never backwards, whatever order messages arrive in.
	if (parseFloat(fill.style.width || '0') < target * 100) fill.style.width = `${target * 100}%`;
	$('loading-text').textContent = `${step[2]}…`;
}

function hideProgress(): void {
	$('loading').hidden = true;
	$('drop').hidden = false;
	$('loading-fill').style.width = '0%';
}

async function useSource(init: SourceInit): Promise<void> {
	showProgress('Reading .build.info');
	try {
		const products = (await storage.setSource(init)).filter((p) => p.product.startsWith('wow'));
		const select = $<HTMLSelectElement>('product');
		select.replaceChildren(...products.map((p) => new Option(`${p.product} ${p.version}`, p.product)));
		// Classic prefers a vanilla build (the continent file IDs are the classic ones): Classic Era
		// first, as "wow_classic" is the progression realms (Mists of Pandaria Classic and so on),
		// with Cataclysm's world. Retail takes the live game.
		const preferred = RETAIL
			? products.find((p) => p.product === 'wow')
			: products.find((p) => p.product === 'wow_classic_era')
				?? products.find((p) => p.product === 'wow_classic_beta')
				?? products.find((p) => p.product.startsWith('wow_classic'));
		if (preferred) {
			// Nothing to choose: straight in.
			select.value = preferred.product;
			await explore();
			return;
		}
		hideProgress();
		$('product-step').hidden = products.length === 0;
		setStatus(products.length ? 'No Classic version found; choose a game version and press Explore.' : 'No World of Warcraft game found in this folder.', true);
	} catch {
		setStatus(init.kind === 'http'
			? 'World of Warcraft was found but couldn\'t be read. Choose its folder instead.'
			: 'That isn\'t the World of Warcraft folder. Choose the folder that contains _classic_ or _classic_beta_ (not that folder itself).', true);
	}
}

/**
 * The portable launcher (and the dev server) look for World of Warcraft on this computer and
 * serve it under /__wow/; when they found it, there's nothing to choose. A plain web server
 * has no such path, and then the folder is chosen by hand.
 */
async function findWow(): Promise<void> {
	// From the root: the retail build is served under /retail/ next to the classic one.
	const base = new URL('/__wow/', location.href).href;
	let found = false;
	try {
		const response = await fetch(`${base}.build.info`, { method: 'HEAD' });
		// Some servers answer every path with the page itself.
		found = response.ok && !response.headers.get('Content-Type')?.includes('text/html');
	} catch {
		// Not served from here.
	}
	$('start').classList.remove('finding');
	if (found) await useSource({ kind: 'http', base });
}
void findWow();

// Dropping the folder on the page works like choosing it.
const drop = $('drop');
const start = $('start');
start.addEventListener('dragover', (e) => {
	e.preventDefault();
	drop.classList.add('dragging');
});
start.addEventListener('dragleave', (e) => {
	if (e.target === start) drop.classList.remove('dragging');
});
start.addEventListener('drop', async (e) => {
	e.preventDefault();
	drop.classList.remove('dragging');
	const entry = e.dataTransfer?.items[0]?.webkitGetAsEntry();
	if (!entry?.isDirectory) {
		setStatus('Drop the World of Warcraft folder itself, not a file.', true);
		return;
	}
	showProgress('Reading your folder');
	await useSource(await droppedFolderToSource(entry as FileSystemDirectoryEntry));
});

// After "Upload", the browser lists the whole folder before telling the page anything; show
// the bar as soon as the dialog closes (the page gets focus back), and drop it if it was cancelled.
let choosingFolder = false;
$('pick').addEventListener('click', () => {
	choosingFolder = true;
	$<HTMLInputElement>('pick-input').click();
});
window.addEventListener('focus', () => {
	if (choosingFolder) showProgress('Reading your folder');
});
$('pick-input').addEventListener('cancel', () => {
	choosingFolder = false;
	hideProgress();
});
$<HTMLInputElement>('pick-input').addEventListener('change', async (event) => {
	choosingFolder = false;
	const input = event.target as HTMLInputElement;
	const source = filesToSource(input.files ?? []);
	// Emptied once read: the browser keeps a filled file input in the page's saved state, and
	// re-sends that (every file in the install, tens of MB) after each key press, a stall each time.
	input.value = '';
	showProgress('Reading your folder');
	await useSource(source);
});

if (!hasDirectoryPicker) $('pick-direct').hidden = true;
$('pick-direct').addEventListener('click', async () => {
	try {
		const init = await pickDirectory();
		if (init) await useSource(init);
	} catch (e) {
		setStatus((e as Error).message, true);
	}
});

$('explore').addEventListener('click', () => void explore());

/** Opens the chosen game version and starts the viewer. */
async function explore(): Promise<void> {
	const button = $<HTMLButtonElement>('explore');
	button.disabled = true;
	for (const id of ['pick', 'pick-direct']) $<HTMLButtonElement>(id).disabled = true;
	try {
		await storage.open($<HTMLSelectElement>('product').value);
		const ui = loadUiAssets(storage);
		const viewer = new Viewer($('view'), storage, showHud, showInfo, $('nameplates'));
		infoViewer = viewer;
		takeSwitchTime(viewer);
		setUpFullscreen($('view'));
		// For poking at the scene from the console (and test scripts) while developing.
		if (import.meta.env.DEV) (globalThis as unknown as { mapExplorerViewer: Viewer }).mapExplorerViewer = viewer;
		viewer.onShotStatus = showShotStatus;
		await viewer.load((text) => showProgress(text));
		// Arrived from the other edition on the planet: once the world is laid out, the planet again.
		takeSwitchPlanet(viewer);
		const { minimapArrow } = await ui;
		showProgress('Starting');
		$('start').hidden = true;
		$('top-left').hidden = $('side').hidden = $('help-hint').hidden = false;
		setUpView(viewer);
		viewer.start();
		setUpMinimap(viewer, minimapArrow);
		void setUpGoTo(viewer);
		setUpHighlights(viewer);
		setUpTravel(viewer, minimapArrow);
		setUpWalking(viewer);
		setUpSound(viewer);
		setUpSavedViews(viewer);
		setUpHelp();
	} catch (e) {
		setStatus(`Could not start: ${(e as Error).message}`, true);
		button.disabled = false;
		for (const id of ['pick', 'pick-direct']) $<HTMLButtonElement>(id).disabled = false;
	}
}

// --- Remembered settings ---

function readSaved<T>(key: string): Partial<T> {
	try {
		return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
	} catch {
		// Storage blocked or unreadable: the defaults.
		return {};
	}
}

function save(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Not remembered; it still applies for this visit.
	}
}

// --- Notices: what a key just changed ---

let noticeTimer = 0;

/** A line low in the middle saying what just changed; it fades after a moment. Shown even with the interface hidden. */
function notify(text: string): void {
	const el = $('notice');
	el.textContent = text;
	el.classList.add('show');
	clearTimeout(noticeTimer);
	noticeTimer = window.setTimeout(() => el.classList.remove('show'), 1800);
}

const onOff = (on: boolean) => (on ? 'on' : 'off');

/** Minutes after midnight as HH:MM. */
function clock(minutes: number): string {
	const m = Math.floor(minutes) % 1440;
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** A speed multiplier as ×1, ×2.4, ×0.59 and so on. */
function speedLabel(scale: number): string {
	return `×${Number(scale.toPrecision(2))}`;
}

/** A fixed flying speed as 64 yd/s, 1100 yd/s and so on. */
function fixedSpeedLabel(speed: number): string {
	return `${Number(speed.toPrecision(2))} yd/s`;
}

// --- Keys belong to the world ---

// Text boxes and lists keep keys while in use; everything else hands them back once used, and
// clicking the world or pressing Esc always does.
document.addEventListener('change', (e) => {
	if (!isTyping(e) || e.target instanceof HTMLSelectElement) (e.target as HTMLElement).blur();
});
document.addEventListener('click', (e) => {
	// Space flies up; it mustn't fold a panel or press a button again.
	(e.target as Element).closest<HTMLElement>('summary, button')?.blur();
});
$('view').addEventListener('pointerdown', () => {
	(document.activeElement as HTMLElement | null)?.blur();
	closeMenu();
});
document.addEventListener('keydown', (e) => {
	if (e.code === 'Escape' && isTyping(e)) (e.target as HTMLElement).blur();
	else if (e.code === 'Escape') closeMenu();
});

/** Folds away whichever of View, Sound and Highlight is open in the top-left menu. */
function closeMenu(): void {
	for (const menu of document.querySelectorAll<HTMLDetailsElement>('#menu details[open]')) menu.open = false;
}

// --- The View panel and the HUD ---

const VIEW_KEY = 'mapExplorer.view';
type SavedView = Partial<ViewSettings> & { stats: boolean };

/** Called with each HUD update, for the parts of the page that follow the viewer. */
const hudFollowers: (() => void)[] = [];

/** The View panel: every setting the keys toggle, the time of day and the HUD's stats; remembered between visits. */
function setUpView(viewer: Viewer): void {
	const panel = $('view-panel');
	const { stats = false, ...settings } = readSaved<SavedView>(VIEW_KEY);
	// Colour grading starts on every time, whatever was left saved (it had a key once, B).
	viewer.settings = { ...settings, grading: true };
	const statsBox = $<HTMLInputElement>('stats-on');
	const controls = [...panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]')];
	const remember = () => save(VIEW_KEY, { ...viewer.settings, stats: statsBox.checked });
	const sync = () => {
		const s = viewer.settings;
		for (const c of controls) {
			const value = s[c.dataset.setting as keyof ViewSettings];
			if (c instanceof HTMLInputElement) c.checked = value as boolean;
			else c.value = String(value);
		}
	};
	const setStats = (on: boolean) => {
		statsBox.checked = on;
		$('hud-stats').hidden = !on;
	};
	setStats(stats);
	sync();
	for (const c of controls) {
		c.addEventListener('change', () => {
			viewer.settings = { [c.dataset.setting!]: c instanceof HTMLInputElement ? c.checked : c.value };
			remember();
		});
	}
	statsBox.addEventListener('change', () => {
		setStats(statsBox.checked);
		remember();
	});
	window.addEventListener('keydown', (e) => {
		if (e.code !== 'KeyK' || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
		setStats(!statsBox.checked);
		remember();
		notify(`Performance stats ${onOff(statsBox.checked)}`);
	});

	// The time of day: the slider follows the clock unless it's being dragged.
	const time = $<HTMLInputElement>('time');
	const timeOut = $('time-out');
	const now = $<HTMLButtonElement>('time-now');
	let dragging = false;
	const syncTime = () => {
		const minutes = viewer.timeMinutes;
		if (!dragging) time.value = String(Math.round(minutes / 15) * 15);
		timeOut.textContent = clock(minutes);
		timeOut.classList.toggle('shifted', !viewer.timeIsLocal);
		timeOut.title = viewer.timeIsLocal ? 'Your local time' : 'Moved from your local time';
		now.disabled = viewer.timeIsLocal;
	};
	time.addEventListener('pointerdown', () => (dragging = true));
	window.addEventListener('pointerup', () => (dragging = false));
	time.addEventListener('input', () => {
		viewer.timeMinutes = Number(time.value);
		syncTime();
	});
	now.addEventListener('click', () => {
		viewer.resetTime();
		syncTime();
	});
	syncTime();
	hudFollowers.push(syncTime);

	// The flying speed: a slider in powers of two, either side of normal with smart speed, or of
	// yd/s without it.
	const speed = $<HTMLInputElement>('fly-speed');
	const speedOut = $('fly-speed-out');
	const speedReset = $<HTMLButtonElement>('fly-speed-reset');
	speed.step = String(FLY_SPEED_STEP);
	const syncSpeed = () => {
		const s = viewer.settings;
		const value = s.smartSpeed ? s.flySpeed : s.fixedSpeed;
		const normal = s.smartSpeed ? 1 : FIXED_SPEED_DEFAULT;
		speed.min = String(s.smartSpeed ? -FLY_SPEED_RANGE : FIXED_SPEED_MIN);
		speed.max = String(s.smartSpeed ? FLY_SPEED_RANGE : FIXED_SPEED_MAX);
		speed.value = String(Math.log2(value));
		speed.title = `${s.smartSpeed ? 'Multiplies the speed, which follows your height' : 'Always this speed'} · Faster: Y · Slower: Shift+Y`;
		speedOut.textContent = s.smartSpeed ? speedLabel(value) : fixedSpeedLabel(value);
		speedOut.classList.toggle('shifted', value !== normal);
		speedReset.disabled = value === normal;
	};
	speed.addEventListener('input', () => {
		const value = 2 ** Number(speed.value);
		viewer.settings = viewer.settings.smartSpeed ? { flySpeed: value } : { fixedSpeed: value };
		syncSpeed();
		remember();
	});
	speedReset.addEventListener('click', () => {
		viewer.settings = viewer.settings.smartSpeed ? { flySpeed: 1 } : { fixedSpeed: FIXED_SPEED_DEFAULT };
		syncSpeed();
		remember();
	});
	panel.querySelector('[data-setting="smartSpeed"]')!.addEventListener('change', syncSpeed);
	syncSpeed();

	// How far the grass reaches, in yards, and how far the doodads, NPCs and objects show, as a
	// share of the usual distance for their size.
	const syncClutterRange = setUpRangeSlider(viewer, 'clutter-range', {
		min: CLUTTER_RANGE_MIN, max: CLUTTER_RANGE_MAX, step: 25, normal: CLUTTER_RANGE_DEFAULT,
		get: (s) => s.clutterRange,
		set: (value) => ({ clutterRange: value }),
		label: (value) => `${value} yd`,
	}, remember);
	const syncDetailRange = setUpRangeSlider(viewer, 'detail-range', {
		min: DETAIL_RANGE_MIN, max: DETAIL_RANGE_MAX, step: 0.25, normal: 1,
		get: (s) => s.detailRange,
		set: (value) => ({ detailRange: value }),
		label: (value) => `${Math.round(value * 100)}%`,
	}, remember);

	viewer.onChange = (change) => {
		const s = viewer.settings;
		sync();
		syncTime();
		syncSpeed();
		syncClutterRange();
		syncDetailRange();
		syncSound(viewer);
		remember();
		notify({
			torch: () => `Torch ${onOff(s.torch)}`,
			clutter: () => `Grass and flowers ${onOff(s.clutter)}`,
			clutterRange: () => `Grass and flowers out to ${s.clutterRange} yd`,
			detailRange: () => `Details out to ${Math.round(s.detailRange * 100)}% of the usual distance`,
			collision: () => (s.collision ? 'Collision on: walls and floors stop you' : 'Collision off: flying through walls'),
			side: () => `Name colours as the ${s.side === 'alliance' ? 'Alliance' : 'Horde'} sees them`,
			mapNames: () => `Dungeon and raid names ${onOff(s.mapNames)}`,
			cinematic: () => (s.cinematic ? 'Cinematic camera: turning glides after the mouse' : 'Cinematic camera off'),
			grading: () => `Colour grading ${onOff(s.grading)}`,
			shadows: () => `Shadows ${onOff(s.shadows)}`,
			fog: () => `Fog and sun shafts ${onOff(s.fog)}`,
			clearView: () => (s.clearView ? 'No fog: the view reaches every continent' : 'Fog back'),
			creatures: () => `NPCs and monsters ${onOff(s.creatures)}`,
			gameObjects: () => `Objects ${onOff(s.gameObjects)}`,
			spiritHealers: () => `Spirit healers ${onOff(s.spiritHealers)}`,
			flySpeed: () => `Flying speed ${speedLabel(s.flySpeed)}`,
			smartSpeed: () => (s.smartSpeed ? 'Smart fly speed: faster the higher you are' : `Fixed fly speed: ${fixedSpeedLabel(s.fixedSpeed)}`),
			fixedSpeed: () => `Flying speed ${fixedSpeedLabel(s.fixedSpeed)}`,
			weather: () => ({ auto: 'Weather: each zone\'s own', dry: 'Weather: no rain or snow', off: 'Weather: always clear', rain: 'Weather: rain', snow: 'Weather: snow', sandstorm: 'Weather: sandstorm' }[s.weather]),
			flight: () => (viewer.onFlight ? 'Taking flight: Esc or moving gets you off' : 'Landed'),
			voyage: () => (viewer.onTransport ? 'All aboard: Esc or moving gets you off' : 'Got off'),
			walking: () => (viewer.walking ? `Walking: ${walkKey} to fly again` : 'Flying'),
			time: () => (viewer.timeIsLocal ? `Local time, ${clock(viewer.timeMinutes)}` : `Time of day ${clock(viewer.timeMinutes)}`),
			sound: () => `Music and sound ${onOff(viewer.soundOn ?? false)}`,
		}[change]());
	};

	// Clicking the coordinates copies a link that opens this view.
	$('hud-coords').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(viewer.shareLink());
			notify('Link to this view copied');
		} catch {
			notify('Couldn’t copy: the browser didn’t allow it');
		}
	});
}

/** A slider in the View panel for one of the distances, with its value beside it and a Reset button; returns its sync. */
function setUpRangeSlider(viewer: Viewer, id: string, range: {
	min: number; max: number; step: number; normal: number;
	get: (s: ViewSettings) => number;
	set: (value: number) => Partial<ViewSettings>;
	label: (value: number) => string;
}, remember: () => void): () => void {
	const slider = $<HTMLInputElement>(id);
	const out = $(`${id}-out`);
	const reset = $<HTMLButtonElement>(`${id}-reset`);
	slider.min = String(range.min);
	slider.max = String(range.max);
	slider.step = String(range.step);
	const sync = () => {
		const value = range.get(viewer.settings);
		slider.value = String(value);
		out.textContent = range.label(value);
		out.classList.toggle('shifted', value !== range.normal);
		reset.disabled = value === range.normal;
	};
	slider.addEventListener('input', () => {
		viewer.settings = range.set(Number(slider.value));
		sync();
		remember();
	});
	reset.addEventListener('click', () => {
		viewer.settings = range.set(range.normal);
		sync();
		remember();
	});
	sync();
	return sync;
}

function fillList(id: string, rows: [string, string][]): void {
	$(id).replaceChildren(...rows.flatMap(([k, v]) => {
		const dt = document.createElement('dt');
		dt.textContent = k;
		const dd = document.createElement('dd');
		dd.textContent = v;
		return [dt, dd];
	}));
}

// --- The minimap ---

function setUpMinimap(viewer: Viewer, arrow: HTMLCanvasElement | null): void {
	const minimap = new Minimap($('minimap'), storage, () => viewer.minimapView(), (mapId, x, y) => viewer.flyOver(mapId, x, y), arrow);
	$('minimap-in').addEventListener('click', () => minimap.zoomBy(-1));
	$('minimap-out').addEventListener('click', () => minimap.zoomBy(1));
}

// --- Travel: flight paths and the world map ---

/** The Travel menu: flight paths to show and take, and the world map (Tab). */
function setUpTravel(viewer: Viewer, arrow: HTMLCanvasElement | null): void {
	const shown = $<HTMLInputElement>('flights-shown');
	const from = $<HTMLSelectElement>('flight-from');
	const to = $<HTMLSelectElement>('flight-to');
	const speed = $<HTMLSelectElement>('flight-speed');
	const go = $<HTMLButtonElement>('flight-go');
	const stop = $<HTMLButtonElement>('flight-stop');
	const transport = $<HTMLSelectElement>('transport');
	const stone = $<HTMLSelectElement>('stone');
	const saved = readSaved<{ shown?: boolean; from?: number; to?: number; speed?: string; transport?: number; stone?: number }>(TRAVEL_KEY);
	shown.checked = saved.shown ?? false;
	speed.value = saved.speed ?? '1';
	viewer.flightPathsShown = shown.checked;
	const remember = () => save(TRAVEL_KEY, { shown: shown.checked, from: Number(from.value), to: Number(to.value), speed: speed.value, transport: Number(transport.value) || saved.transport, stone: Number(stone.value) || saved.stone });

	const fill = () => {
		const keep = [Number(from.value) || saved.from, Number(to.value) || saved.to];
		const masters = viewer.flightMasters;
		for (const [select, value] of [[from, keep[0]], [to, keep[1]]] as const) {
			select.replaceChildren(...masters.map((m) => new Option(m.name, String(m.id))));
			if (masters.some((m) => m.id === value)) select.value = String(value);
		}
		go.disabled = masters.length < 2;
	};
	viewer.onFlightsChange = fill;
	fill();
	shown.addEventListener('change', () => {
		viewer.flightPathsShown = shown.checked;
		remember();
	});
	for (const s of [from, to, speed]) s.addEventListener('change', remember);
	$('flight-nearest').addEventListener('click', () => {
		const m = viewer.nearestFlightMaster();
		if (m) from.value = String(m.id);
		else notify('No flight master on this map for this side');
		remember();
	});
	go.addEventListener('click', () => {
		const problem = viewer.takeFlight(Number(from.value), Number(to.value), Number(speed.value));
		if (problem) notify(problem);
		else ($('travel') as HTMLDetailsElement).open = false;
	});
	stop.addEventListener('click', () => viewer.stopFlight());
	hudFollowers.push(() => {
		stop.disabled = !viewer.onFlight;
	});

	// Boats and zeppelins: on board where one is now, or along for the ride.
	const transportStop = $<HTMLButtonElement>('transport-stop');
	const fillTransports = () => {
		const keep = Number(transport.value) || saved.transport;
		const list = [...viewer.transportList].sort((a, b) => a.name.localeCompare(b.name));
		transport.replaceChildren(...([['ship', 'Boats'], ['zeppelin', 'Zeppelins']] as const).map(([kind, label]) => {
			const group = document.createElement('optgroup');
			group.label = label;
			group.append(...list.filter((t) => t.kind === kind).map((t) => new Option(t.name, String(t.entry))));
			return group;
		}));
		if (list.some((t) => t.entry === keep)) transport.value = String(keep);
		for (const id of ['transport-goto', 'transport-ride']) $<HTMLButtonElement>(id).disabled = !list.length;
	};
	viewer.onTransportsChange = fillTransports;
	fillTransports();
	transport.addEventListener('change', remember);
	$('transport-goto').addEventListener('click', () => {
		const problem = viewer.goToTransport(Number(transport.value));
		if (problem) notify(problem);
	});
	$('transport-ride').addEventListener('click', () => {
		const problem = viewer.rideTransport(Number(transport.value));
		if (problem) notify(problem);
		else ($('travel') as HTMLDetailsElement).open = false;
	});
	transportStop.addEventListener('click', () => viewer.stopFlight());
	hudFollowers.push(() => {
		transportStop.disabled = !viewer.onTransport;
		$('transport-status').textContent = viewer.onTransport ? '' : viewer.transportStatus(Number(transport.value));
		$('dock-status').textContent = viewer.nearestDockStatus();
	});

	// Meeting stones: summoned to one, or straight into its dungeon.
	stone.replaceChildren(...([[0, 'Eastern Kingdoms'], [1, 'Kalimdor']] as const).map(([mapId, label]) => {
		const group = document.createElement('optgroup');
		group.label = label;
		group.append(...viewer.meetingStones.filter((s) => s.map === mapId).map((s) => new Option(stoneLabel(s), String(s.guid))));
		return group;
	}));
	if (viewer.meetingStone(saved.stone ?? 0)) stone.value = String(saved.stone);
	for (const id of ['stone-goto', 'stone-enter']) $<HTMLButtonElement>(id).disabled = !viewer.meetingStones.length;
	stone.addEventListener('change', remember);
	$('stone-goto').addEventListener('click', () => void meetingStoneAction(viewer.goToMeetingStone(Number(stone.value))));
	$('stone-enter').addEventListener('click', () => void meetingStoneAction(viewer.enterDungeon(Number(stone.value))));

	const map = new WorldMap($('worldmap'), $<HTMLCanvasElement>('worldmap-canvas'), storage, () => viewer.worldMapView(), (mapId, x, y) => viewer.flyOverWow(mapId, x, y), (mapId, x, y) => viewer.areaNameAt(mapId, x, y), arrow, {
		title: $('worldmap-title'),
		up: $<HTMLButtonElement>('worldmap-up'),
		count: $('worldmap-count'),
		all: $<HTMLInputElement>('worldmap-all'),
		forget: $<HTMLButtonElement>('worldmap-forget'),
		close: $<HTMLButtonElement>('worldmap-close'),
		hover: $('worldmap-hover'),
	});
	viewer.onExplore = (areas) => map.explore(areas);
	hudFollowers.push(() => map.update());
	$('worldmap-open').addEventListener('click', () => {
		($('travel') as HTMLDetailsElement).open = false;
		map.toggle();
	});
	window.addEventListener('keydown', (e) => {
		if (e.code !== 'KeyM' || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
		e.preventDefault();
		map.toggle();
	});
}

const TRAVEL_KEY = 'mapExplorer.travel';

/** A meeting stone's dungeon and level range, as the stone's tooltip has it. */
function stoneLabel(s: MeetingStone): string {
	return `${s.dungeon} (${s.minLevel}–${s.maxLevel})`;
}

/** Runs a meeting stone's Go to or Enter, closing the menus once on the way, or saying why not. */
async function meetingStoneAction(action: Promise<string | null>): Promise<void> {
	const problem = await action;
	if (problem) notify(problem);
	else ($('travel') as HTMLDetailsElement).open = false;
}

// --- Walking ---

/** What the walking key (the one left of 1) is labelled on this keyboard. */
let walkKey = '`';

/**
 * Labels keys named by position (kbd data-key="Backquote", the KeyboardEvent code) with what they show on this keyboard
 * layout, where the browser can tell (§ on Nordic keyboards, ^ on German ones...).
 */
async function labelKeys(): Promise<void> {
	const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
	let layout: Map<string, string> | undefined;
	try {
		layout = await keyboard?.getLayoutMap();
	} catch {
		// Not allowed here (a frame, an old browser): the US labels stand.
	}
	walkKey = layout?.get('Backquote') ?? walkKey;
	for (const kbd of document.querySelectorAll<HTMLElement>('kbd[data-key]')) {
		const label = layout?.get(kbd.dataset.key!);
		if (label) kbd.textContent = label;
	}
}
void labelKeys();

const WALK_KEY = 'mapExplorer.walker';

/** The Travel menu's switch between flying and walking, and who walks: race, sex, model, outfit and look, remembered. */
function setUpWalking(viewer: Viewer): void {
	const race = $<HTMLSelectElement>('walk-race');
	const sex = $<HTMLSelectElement>('walk-sex');
	const model = $<HTMLSelectElement>('walk-model');
	const outfit = $<HTMLSelectElement>('walk-outfit');
	const lookOut = $<HTMLOutputElement>('walk-look');
	outfit.replaceChildren(
		...Object.entries(CHARACTER_OUTFITS).map(([key, o]) => new Option(o.name, key)),
		new Option('NPC looks', ''),
	);
	const saved = readSaved<CharacterLook>(WALK_KEY);
	let look: CharacterLook = { ...viewer.look, ...saved };
	let races: CharacterRace[] = [];
	/** Looks for the race, sex and model chosen. */
	const lookCount = () => {
		const r = races.find((x) => x.race === look.race);
		return r ? r.sexes[look.sex][look.hd ? 'hd' : 'sd'] : 0;
	};
	const show = () => {
		race.value = String(look.race);
		sex.value = String(look.sex);
		model.value = look.hd ? 'hd' : 'sd';
		const r = races.find((x) => x.race === look.race);
		for (const option of sex.options) option.disabled = !r || !(r.sexes[Number(option.value)].sd || r.sexes[Number(option.value)].hd);
		for (const option of model.options) option.disabled = !r || !r.sexes[look.sex][option.value as 'sd' | 'hd'];
		outfit.value = look.outfit ?? '';
		const count = lookCount();
		// Wearing an outfit, the look buttons go back to the race's NPC looks.
		lookOut.value = look.outfit ? '–' : count ? `${look.look + 1} of ${count}` : '–';
		for (const id of ['walk-look-prev', 'walk-look-next']) $<HTMLButtonElement>(id).disabled = count < 2;
	};
	/** Settles on a race, sex and model that have looks, nearest the one asked for, then dresses the character. */
	const apply = (next: Partial<CharacterLook>) => {
		look = { ...look, ...next };
		// An outfit belongs to one race (guards are human): another race takes off the outfit.
		if (look.outfit && CHARACTER_OUTFITS[look.outfit]?.race !== look.race) look.outfit = null;
		const r = races.find((x) => x.race === look.race) ?? races[0];
		if (r) {
			look.race = r.race;
			if (!r.sexes[look.sex].sd && !r.sexes[look.sex].hd) look.sex = 1 - look.sex;
			if (!r.sexes[look.sex][look.hd ? 'hd' : 'sd']) look.hd = !look.hd;
			const count = lookCount();
			look.look = count ? ((look.look % count) + count) % count : 0;
		}
		save(WALK_KEY, look);
		show();
		void viewer.setLook(look);
	};
	viewer.characterRaces().then((list) => {
		races = list;
		race.replaceChildren(...list.map((r) => new Option(r.name, String(r.race))));
		apply({});
	}, (e) => {
		console.warn('Character races unavailable:', e);
		$('walk-character').hidden = true;
	});
	race.addEventListener('change', () => apply({ race: Number(race.value), look: 0 }));
	sex.addEventListener('change', () => apply({ sex: Number(sex.value), look: 0 }));
	model.addEventListener('change', () => apply({ hd: model.value === 'hd' }));
	outfit.addEventListener('change', () => {
		const chosen = (outfit.value || null) as CharacterOutfit | null;
		apply({ outfit: chosen, race: chosen ? CHARACTER_OUTFITS[chosen].race : look.race });
	});
	$('walk-look-prev').addEventListener('click', () => apply({ look: look.outfit ? look.look : look.look - 1, outfit: null }));
	$('walk-look-next').addEventListener('click', () => apply({ look: look.outfit ? look.look : look.look + 1, outfit: null }));

	const toggle = $<HTMLButtonElement>('walk-toggle');
	viewer.onNotice = notify;
	// Walking, the mouse is hidden only to turn: no crosshair then.
	document.addEventListener('pointerlockchange', () => {
		if (viewer.walking) $('crosshair').hidden = true;
	});
	const sync = () => {
		toggle.firstChild!.textContent = viewer.walking ? 'Fly again ' : 'Walk on the ground ';
		toggle.classList.toggle('primary', !viewer.walking);
	};
	toggle.addEventListener('click', () => {
		const problem = viewer.setWalking(!viewer.walking);
		if (problem) notify(problem);
		else ($('travel') as HTMLDetailsElement).open = false;
		sync();
	});
	hudFollowers.push(sync);
	sync();
}


/** The tint's key under the Ground choice: what its colours mean. */
function showTintKey(viewer: Viewer): void {
	$('tint-key').replaceChildren(...viewer.tintKey.map(([color, label]) => {
		const span = document.createElement('span');
		span.style.setProperty('--key', color);
		span.textContent = label;
		return span;
	}));
}

// --- Going places ---

const MAP_GROUPS: [MapCategory, string][] = [
	['continent', 'Continents'],
	['dungeon', 'Dungeons'],
	['raid', 'Raids'],
	['battleground', 'Battlegrounds'],
	['other', 'Other maps'],
];
const MAP_KINDS: Record<MapCategory, string> = { continent: 'Continent', dungeon: 'Dungeon', raid: 'Raid', battleground: 'Battleground', other: 'Other map' };
/** Matches shown at most. */
const GOTO_LIMIT = 40;

interface Destination {
	name: string;
	/** What it is, or where it lies. */
	sub: string;
	/** Zones before maps before towns, among matches as good as each other. */
	order: number;
	category?: MapCategory;
	/** The name lower-cased, without accents or apostrophes, for matching. */
	key: string;
	go: () => Promise<boolean>;
}

const searchKey = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ'’]/g, '');

/** How well a name matches: the start of it, the start of a word in it, anywhere in it, or not at all (-1). */
function matchScore(key: string, query: string): number {
	if (key.startsWith(query)) return 0;
	if (key.split(/[\s-]+/).some((word) => word.startsWith(query))) return 1;
	return key.includes(query) ? 2 : -1;
}

/**
 * Go to: a search over every zone, town and landmark, and every map in the install (many have
 * no way in from the world). Empty, it lists the maps by kind, as a way in to all of them.
 */
async function setUpGoTo(viewer: Viewer): Promise<void> {
	const input = $<HTMLInputElement>('goto-query');
	const list = $('goto-results');
	const [maps, places] = await Promise.all([
		storage.listMaps().catch((e): MapListing[] => {
			console.warn('Map list unavailable:', e);
			return [];
		}),
		storage.loadPlaces().catch((e): Place[] => {
			console.warn('Zones and towns unavailable:', e);
			return [];
		}),
	]);
	const mapNames = new Map(maps.map((m) => [m.id, m.name]));
	const destination = (name: string, sub: string, order: number, go: () => Promise<boolean>, category?: MapCategory): Destination => ({ name, sub, order, category, key: searchKey(name), go });
	// Only places on maps in the install, and not a battleground's own zone (the map stands for it).
	const placesHere = places.filter((p) => mapNames.has(p.mapId) && !(p.kind === 'zone' && mapNames.get(p.mapId) === p.name));
	const destinations = [
		...placesHere.filter((p) => p.kind === 'zone').map((p) => destination(p.name, 'Zone', 0, () => viewer.goToPlace(p))),
		...maps.map((m) => destination(m.name, MAP_KINDS[m.category], 1, () => viewer.goToMap(m.id), m.category)),
		...placesHere.filter((p) => p.kind === 'place').map((p) => destination(p.name, p.zone ?? mapNames.get(p.mapId) ?? '', 2, () => viewer.goToPlace(p))),
	];

	let shown: Destination[] = [];
	let active = -1;

	const item = (d: Destination) => {
		const li = document.createElement('li');
		li.role = 'option';
		li.id = `goto-${shown.length}`;
		const name = document.createElement('span');
		name.textContent = d.name;
		const sub = document.createElement('span');
		sub.className = 'sub';
		sub.textContent = d.sub;
		li.append(name, sub);
		// Before the box loses focus, which closes the list.
		li.addEventListener('mousedown', (e) => {
			e.preventDefault();
			void pick(d);
		});
		shown.push(d);
		return li;
	};
	const note = (text: string, className: string) => {
		const li = document.createElement('li');
		li.className = className;
		li.textContent = text;
		return li;
	};
	const setActive = (index: number) => {
		active = index;
		list.querySelectorAll('[aria-selected]').forEach((li) => li.removeAttribute('aria-selected'));
		const li = index >= 0 ? $(`goto-${index}`) : null;
		li?.setAttribute('aria-selected', 'true');
		li?.scrollIntoView({ block: 'nearest' });
		if (li) input.setAttribute('aria-activedescendant', li.id);
		else input.removeAttribute('aria-activedescendant');
	};
	const render = () => {
		const query = searchKey(input.value.trim());
		shown = [];
		const rows: HTMLLIElement[] = [];
		if (!query) {
			for (const [category, label] of MAP_GROUPS) {
				const group = destinations.filter((d) => d.category === category);
				if (!group.length) continue;
				rows.push(note(label, 'group'), ...group.map(item));
			}
		} else {
			const matches = destinations
				.map((d) => ({ d, score: matchScore(d.key, query) }))
				.filter((m) => m.score >= 0)
				.sort((a, b) => a.score - b.score || a.d.order - b.d.order || a.d.name.length - b.d.name.length || a.d.name.localeCompare(b.d.name))
				.slice(0, GOTO_LIMIT);
			rows.push(...matches.map((m) => item(m.d)));
			if (!matches.length) rows.push(note('Nothing by that name', 'empty'));
		}
		list.replaceChildren(...rows);
		list.hidden = false;
		input.setAttribute('aria-expanded', 'true');
		setActive(query && shown.length ? 0 : -1);
	};
	const close = () => {
		list.hidden = true;
		input.setAttribute('aria-expanded', 'false');
		input.value = '';
		setActive(-1);
	};
	const pick = async (d: Destination) => {
		input.blur();
		if (!(await d.go())) notify(`${d.name} isn’t in this install`);
	};

	input.addEventListener('focus', render);
	input.addEventListener('input', render);
	input.addEventListener('blur', close);
	input.addEventListener('keydown', (e) => {
		if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
			e.preventDefault();
			if (shown.length) setActive((active + (e.code === 'ArrowDown' ? 1 : shown.length - 1 + (active < 0 ? 1 : 0))) % shown.length);
		} else if (e.code === 'Enter') {
			const d = shown[Math.max(active, 0)];
			if (d) void pick(d);
		}
	});
	window.addEventListener('keydown', (e) => {
		if (e.key !== '/' || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
		e.preventDefault();
		if (document.pointerLockElement) document.exitPointerLock();
		input.focus();
	});
}

// --- Highlighting things on the ground ---

const HIGHLIGHT_KEY = 'mapExplorer.highlight';

/** The highlight panel: kinds to mark and a name to find, remembered between visits. */
function setUpHighlights(viewer: Viewer): void {
	const panel = $('highlight');
	const on = $<HTMLInputElement>('highlight-on');
	const query = $<HTMLInputElement>('highlight-query');
	const walkable = $<HTMLInputElement>('highlight-walkable');
	const tint = $<HTMLSelectElement>('highlight-tint');
	const level = $<HTMLInputElement>('tint-level');
	const levelOut = $('tint-level-out');
	const rested = $<HTMLInputElement>('highlight-rested');
	const boxes = [...panel.querySelectorAll<HTMLInputElement>('#highlight-groups input')];
	const saved = readSaved<HighlightSettings>(HIGHLIGHT_KEY);
	on.checked = saved.on ?? false;
	query.value = saved.query ?? '';
	walkable.checked = saved.walkable ?? false;
	// Saved before the tints came in: the graveyards had a box of their own.
	tint.value = saved.tint ?? ((saved as { graveyards?: boolean }).graveyards ? 'graveyards' : '');
	level.value = String(saved.level ?? 20);
	rested.checked = saved.rested ?? false;
	for (const box of boxes) box.checked = saved.groups?.includes(box.value as HighlightGroup) ?? false;

	const apply = () => {
		const settings: HighlightSettings = {
			on: on.checked,
			groups: boxes.filter((b) => b.checked).map((b) => b.value as HighlightGroup),
			query: query.value,
			walkable: walkable.checked,
			tint: tint.value as TintMode | '',
			level: Number(level.value),
			rested: rested.checked,
		};
		levelOut.textContent = level.value;
		panel.dataset.tint = settings.tint;
		panel.classList.toggle('off', !settings.on);
		panel.classList.toggle('walkable', settings.walkable);
		viewer.setHighlights(settings);
		save(HIGHLIGHT_KEY, settings);
		showTintKey(viewer);
	};
	for (const box of [on, walkable, rested, tint, ...boxes]) {
		box.addEventListener('change', () => {
			// Choosing a kind turns highlighting on.
			if (box !== on && (box instanceof HTMLSelectElement ? box.value : box.checked)) on.checked = true;
			apply();
		});
	}
	query.addEventListener('input', () => {
		if (query.value.trim()) on.checked = true;
		apply();
	});
	level.addEventListener('input', apply);
	query.addEventListener('keydown', (e) => {
		if (e.code === 'Enter') query.blur();
	});
	window.addEventListener('keydown', (e) => {
		if (e.code !== 'KeyNone' || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
		on.checked = !on.checked;
		apply();
		notify(`Highlights ${onOff(on.checked)}`);
	});
	apply();
}

// --- Sound ---

/** The Sound panel's on/off box, which is greyed out until the music is read. */
function syncSound(viewer: Viewer): void {
	const box = $<HTMLInputElement>('sound-on');
	box.checked = viewer.soundOn ?? false;
	box.disabled = viewer.soundOn === null;
}

/** The Sound panel: music and sound on or off, and a slider per kind of sound, applied as they move. */
function setUpSound(viewer: Viewer): void {
	const panel = $('sound');
	for (const slider of panel.querySelectorAll<HTMLInputElement>('input[type=range]')) {
		const channel = slider.dataset.channel as VolumeChannel;
		const shown = slider.nextElementSibling as HTMLOutputElement;
		slider.value = String(Math.round(volumeSetting(channel) * 100));
		shown.value = `${slider.value}%`;
		slider.addEventListener('input', () => {
			setVolume(channel, Number(slider.value) / 100);
			shown.value = `${slider.value}%`;
		});
	}
	$('sound-on').addEventListener('change', (e) => {
		viewer.soundOn = (e.target as HTMLInputElement).checked;
	});
	// The music is read after the world opens.
	hudFollowers.push(() => syncSound(viewer));
}

// --- Help ---

const HELP_KEY = 'mapExplorer.helpSeen';

/** The list of controls: ? or F1, or the button bottom left; shown once by itself on the first visit. */
function setUpHelp(): void {
	const help = $('help');
	const show = (on: boolean) => {
		help.hidden = !on;
		if (on && document.pointerLockElement) document.exitPointerLock();
	};
	$('help-hint').addEventListener('click', () => show(Boolean(help.hidden)));
	$('help-close').addEventListener('click', () => show(false));
	help.addEventListener('click', (e) => {
		if (e.target === help) show(false);
	});
	window.addEventListener('keydown', (e) => {
		if (isTyping(e)) return;
		if (e.key === '?' || e.code === 'F1') {
			e.preventDefault();
			show(Boolean(help.hidden));
		} else if (e.code === 'Escape') {
			show(false);
		}
	});
	let seen = true;
	try {
		seen = localStorage.getItem(HELP_KEY) === '1';
		localStorage.setItem(HELP_KEY, '1');
	} catch {
		// Storage blocked: not shown by itself, as it couldn't be remembered as seen.
	}
	if (!seen) show(true);
}

// --- Hiding the interface ---

// U, or Alt+Z as in the game: everything drawn over the world goes, for a clear view or
// screenshots. The NVIDIA overlay takes Alt+Z for itself where it's installed, hence U too.
window.addEventListener('keydown', (e) => {
	const toggle = e.altKey ? e.code === 'KeyZ' : e.code === 'KeyU' && !e.ctrlKey && !e.metaKey;
	if (!toggle || $('start').hidden === false || isTyping(e)) return;
	e.preventDefault();
	const hidden = document.body.classList.toggle('ui-hidden');
	notify(hidden ? 'Interface hidden: U brings it back' : 'Interface shown');
});

// The planet view starts with the interface hidden, for a clear view of Azeroth, and the world
// with it shown; U / Alt+Z still turn it on and off in either.
let globeShown = document.documentElement.classList.contains('globe-view');
new MutationObserver(() => {
	const now = document.documentElement.classList.contains('globe-view');
	if (now === globeShown) return;
	globeShown = now;
	document.body.classList.toggle('ui-hidden', now);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

// --- Saved views (Ctrl+1-9 save, Shift+1-9 go) ---

/** Each edition its own: their lands differ. */
const SAVED_VIEWS_KEY = `mapExplorer.savedViews.${RETAIL ? 'retail' : 'classic'}`;
const SAVED_VIEW_SLOTS = 9;

/** A view saved to come back to: its name (yours), where and which way, and the time of day (null: local time). */
interface Bookmark {
	name: string;
	hash: string;
	planet: boolean;
	time: number | null;
}

/** Saved views: Ctrl+number saves this one (place, angle and time of day), Shift+number goes back; named and kept in Travel. */
function setUpSavedViews(viewer: Viewer): void {
	const stored = readSaved<(Bookmark | null)[]>(SAVED_VIEWS_KEY);
	const slots: (Bookmark | null)[] = Array.from({ length: SAVED_VIEW_SLOTS }, (_, i) => (Array.isArray(stored) ? stored[i] ?? null : null));
	const remember = () => save(SAVED_VIEWS_KEY, slots);
	const label = (i: number) => slots[i]?.name || `View ${i + 1}`;

	const list = $('saved-views');
	const names: HTMLInputElement[] = [];
	const goes: HTMLButtonElement[] = [];
	const clears: HTMLButtonElement[] = [];
	const sync = (i: number) => {
		names[i].value = slots[i]?.name ?? '';
		names[i].disabled = !slots[i];
		names[i].placeholder = slots[i] ? `View ${i + 1}` : 'Empty';
		goes[i].disabled = clears[i].disabled = !slots[i];
	};

	const store = (i: number) => {
		const view = viewer.savedView();
		if (!view) {
			notify('Can’t save this view');
			return;
		}
		slots[i] = { name: slots[i]?.name ?? '', ...view, time: viewer.timeIsLocal ? null : viewer.timeMinutes };
		remember();
		sync(i);
		notify(`Saved as ${label(i)}`);
	};
	const go = (i: number) => {
		const slot = slots[i];
		if (!slot) {
			notify(`Nothing saved in ${i + 1}: Ctrl+${i + 1} saves this view there`);
			return;
		}
		if (!viewer.goToSavedView(slot)) {
			notify(`Can’t go to ${label(i)} from here`);
			return;
		}
		if (slot.time === null) viewer.resetTime();
		else viewer.timeMinutes = slot.time;
		closeMenu();
		notify(`Going to ${label(i)}`);
	};

	for (let i = 0; i < SAVED_VIEW_SLOTS; i++) {
		const key = document.createElement('span');
		key.className = 'saved-key';
		key.textContent = String(i + 1);
		const name = document.createElement('input');
		name.type = 'text';
		name.maxLength = 40;
		name.setAttribute('aria-label', `Name of view ${i + 1}`);
		name.addEventListener('input', () => {
			if (!slots[i]) return;
			slots[i]!.name = name.value.trim();
			remember();
		});
		name.addEventListener('keydown', (e) => {
			if (e.code === 'Enter') name.blur();
		});
		const goButton = document.createElement('button');
		goButton.textContent = 'Go';
		goButton.title = `Go there (Shift+${i + 1})`;
		goButton.addEventListener('click', () => go(i));
		const saveButton = document.createElement('button');
		saveButton.textContent = 'Save';
		saveButton.title = `Save the current view here (Ctrl+${i + 1})`;
		saveButton.addEventListener('click', () => store(i));
		const clear = document.createElement('button');
		clear.textContent = '×';
		clear.title = 'Forget this view';
		clear.setAttribute('aria-label', `Forget view ${i + 1}`);
		clear.addEventListener('click', () => {
			slots[i] = null;
			remember();
			sync(i);
		});
		list.append(key, name, goButton, saveButton, clear);
		names.push(name);
		goes.push(goButton);
		clears.push(clear);
		sync(i);
	}

	window.addEventListener('keydown', (e) => {
		const digit = /^Digit([1-9])$/.exec(e.code);
		if (!digit || isTyping(e) || e.altKey || e.metaKey || $('start').hidden === false) return;
		const i = Number(digit[1]) - 1;
		if (e.ctrlKey && !e.shiftKey) store(i);
		else if (e.shiftKey && !e.ctrlKey) go(i);
		else return;
		// Not the browser's own Ctrl+number (switching tabs) in a browser window.
		e.preventDefault();
	});
}

// --- Continent maps (Shift+B, retail) ---

/**
 * Pictures of a whole continent, of your own (the game's map art, not published): put in
 * public/maps, by Map.db2 ID. Shift+B shows the one being looked at.
 */
const CONTINENT_MAPS: Record<number, string> = { 0: 'maps/east_kingdom.jpg', 1: 'maps/kalimdore.jpg' };
/** How far in the picture zooms, past fitting the screen's height. */
const CONTINENT_MAP_ZOOM = 10;

/** Shift+B: the continent's map over everything, fitted to the screen's height, zoomed with the wheel and moved by dragging. */
function setUpContinentMap(): void {
	const box = $('continent-map');
	const image = $<HTMLImageElement>('continent-map-image');
	if (!RETAIL) {
		$('continent-map-help').remove();
		return;
	}
	let scale = 1, fit = 1, x = 0, y = 0;
	const place = () => (image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`);
	const fitToScreen = () => {
		fit = Math.min(box.clientHeight / image.naturalHeight, box.clientWidth / image.naturalWidth);
		scale = fit;
		x = (box.clientWidth - image.naturalWidth * scale) / 2;
		y = (box.clientHeight - image.naturalHeight * scale) / 2;
		place();
	};
	const close = () => (box.hidden = true);
	const open = () => {
		const mapId = infoViewer?.viewedMapId ?? null;
		const file = mapId === null ? undefined : CONTINENT_MAPS[mapId];
		if (!file) {
			notify('No map of this area');
			return;
		}
		const url = new URL(file, document.baseURI).href;
		const show = () => {
			box.hidden = false;
			fitToScreen();
		};
		if (image.src === url && image.complete && image.naturalWidth) {
			show();
			return;
		}
		image.onload = show;
		image.onerror = () => notify(`Map picture missing: put ${file.slice(5)} in public/maps`);
		image.src = url;
	};

	// Keys go to the map while it's open, not to flying.
	window.addEventListener('keydown', (e) => {
		const toggle = e.code === 'KeyB' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
		if (toggle && !isTyping(e) && $('start').hidden !== false) {
			e.preventDefault();
			e.stopImmediatePropagation();
			if (box.hidden) open();
			else close();
			return;
		}
		if (box.hidden) return;
		if (e.code === 'Escape') close();
		e.stopImmediatePropagation();
	}, true);

	box.addEventListener('wheel', (e) => {
		e.preventDefault();
		const next = Math.min(fit * CONTINENT_MAP_ZOOM, Math.max(fit, scale * Math.exp(-e.deltaY * 0.0015)));
		// Zoomed round the point under the pointer.
		x = e.clientX - ((e.clientX - x) * next) / scale;
		y = e.clientY - ((e.clientY - y) * next) / scale;
		scale = next;
		place();
	}, { passive: false });

	// Dragging moves it; a click without dragging off the picture closes it.
	let drag: { x: number; y: number; moved: boolean } | null = null;
	box.addEventListener('pointerdown', (e) => {
		if (e.button !== 0) return;
		drag = { x: e.clientX, y: e.clientY, moved: false };
		box.setPointerCapture(e.pointerId);
	});
	box.addEventListener('pointermove', (e) => {
		if (!drag) return;
		const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
		if (!drag.moved && Math.hypot(dx, dy) < 4) return;
		drag.moved = true;
		box.classList.add('dragging');
		x += dx;
		y += dy;
		drag.x = e.clientX;
		drag.y = e.clientY;
		place();
	});
	box.addEventListener('pointerup', (e) => {
		const clicked = drag && !drag.moved;
		drag = null;
		box.classList.remove('dragging');
		if (clicked && e.target === box) close();
	});
	window.addEventListener('resize', () => {
		if (!box.hidden) fitToScreen();
	});
}

setUpContinentMap();

// --- Screenshots ---

let shotStatusTimer = 0;

/** Screenshot progress (P); kept on screen even with the interface hidden, but never in the picture. */
function showShotStatus(text: string | null, done = false): void {
	const el = $('shot-status');
	clearTimeout(shotStatusTimer);
	el.hidden = !text;
	el.textContent = text ?? '';
	if (done) shotStatusTimer = window.setTimeout(() => (el.hidden = true), 5000);
}

// --- Clicked creature or object ---

document.addEventListener('pointerlockchange', () => {
	$('crosshair').hidden = !document.pointerLockElement;
});
$('info-close').addEventListener('click', () => ($('info').hidden = true));
window.addEventListener('keydown', (e) => {
	if (e.code === 'Escape' && !isTyping(e)) $('info').hidden = true;
});

/** Book text uses $B for line breaks and $N for the reader's name. */
function pageText(text: string): string {
	return text.replace(/\$[Bb]/g, '\n').replace(/\$[Nn]/g, 'traveler').replace(/\$[Cc]/g, 'adventurer');
}

/** The viewer, for the actions the info panel offers (a meeting stone's Go to and Enter). */
let infoViewer: Viewer | null = null;

function showInfo(info: SpawnInfo): void {
	const isNpc = info.type === 'npc';
	$('info-kind').textContent = [isNpc ? 'NPC' : 'Object', info.kind, info.rank].filter(Boolean).join(' · ');
	$('info-name').textContent = info.name;
	$('info-sub').textContent = info.subname ? `<${info.subname}>` : '';
	const facts: [string, string][] = [];
	if (info.level) facts.push(['Level', info.level]);
	const stone = !isNpc ? infoViewer?.meetingStone(info.guid) : null;
	if (stone) facts.push(['Dungeon', stone.dungeon], ['Levels', `${stone.minLevel}–${stone.maxLevel}`]);
	facts.push([isNpc ? 'NPC ID' : 'Object ID', String(info.entry)], ['Spawn', String(info.guid)]);
	fillList('info-facts', facts);

	const actions: HTMLButtonElement[] = [];
	if (stone && infoViewer) {
		const viewer = infoViewer;
		const enter = document.createElement('button');
		enter.className = 'primary';
		enter.textContent = `Enter ${stone.dungeon.replace(/^The /, '')}`;
		enter.addEventListener('click', () => void meetingStoneAction(viewer.enterDungeon(stone.guid)));
		actions.push(enter);
	}
	$('info-actions').replaceChildren(...actions);

	const pages = $('info-pages');
	pages.replaceChildren();
	(info.pages ?? []).forEach((text, i) => {
		if (i > 0) pages.append(document.createElement('hr'));
		pages.append(pageText(text));
	});

	// Wowhead uses the same creature/object template IDs; its tooltip script decorates these links.
	const path = `${isNpc ? 'npc' : 'object'}=${info.entry}`;
	const links = [
		['Wowhead Forever', `https://www.wowhead.com/forever/${path}`],
		['Wowhead Classic', `https://www.wowhead.com/classic/${path}`],
	].map(([label, href]) => {
		const a = document.createElement('a');
		a.href = href;
		a.target = '_blank';
		a.rel = 'noopener';
		a.textContent = label;
		return a;
	});
	$('info-links').replaceChildren(...links);
	$('info').hidden = false;
	$('info').scrollTop = 0;
	(window as unknown as { $WowheadPower?: { refreshLinks?: () => void } }).$WowheadPower?.refreshLinks?.();
}

let shownZone: string | null = null;
let shownSubzone: string | null = null;

/** Fades a line of zone text in, holds it and fades it out again, from the start. */
function fadeZoneLine(el: HTMLElement): void {
	el.classList.remove('show');
	void el.offsetWidth; // restart the animation
	el.classList.add('show');
}

/**
 * Zone text as the game's ZoneText.lua shows it: a new zone shows its name with the subzone
 * under it; within a zone only the subzone line shows, and leaving a subzone for the open zone
 * shows the zone's name there.
 */
function announceZone(zone: string | null, subzone: string | null): void {
	if (!zone || (zone === shownZone && subzone === shownSubzone)) return;
	const newZone = zone !== shownZone;
	shownZone = zone;
	shownSubzone = subzone;
	$('zone-name').textContent = zone;
	if (newZone) fadeZoneLine($('zone-name'));
	const sub = subzone ?? (newZone ? '' : zone);
	$('subzone-name').textContent = sub;
	if (sub) fadeZoneLine($('subzone-name'));
}

function showHud(info: HudInfo): void {
	announceZone(info.zone, info.subzone);
	$('highlight-status').textContent = info.highlights;
	// The minimap's zone line, as GetMinimapZoneText: the subzone if there is one.
	$('minimap-zone').textContent = info.subzone ?? info.zone ?? info.location;
	$('hud-location').textContent = info.zone ? [info.zone, info.subzone].filter(Boolean).join(' · ') : info.location;
	$('hud-coords').textContent = info.zone ? `${info.location} · ${info.coordinates}` : info.coordinates;
	fillList('hud-view', [
		['Time', info.time],
		['Altitude', `${info.altitude.toFixed(0)} yd above ground`],
		['Music', info.music],
		...(info.weather ? [['Weather', info.weather] as [string, string]] : []),
		...(info.flight ? [['Flight', info.flight] as [string, string]] : []),
		...(info.voyage ? [['Aboard', info.voyage] as [string, string]] : []),
	]);
	$('flight-status').textContent = info.flight || info.voyage;
	if (!$('hud-stats').hidden) {
		fillList('hud-stats', [
			['Speed', `${info.speed.toFixed(0)} yd/s`],
			['Detail', info.near],
			['Objects', info.objects],
			['Textures', info.textures],
			['FPS', info.fps.toFixed(0)],
		]);
	}
	for (const follow of hudFollowers) follow();
}
