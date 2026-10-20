import type { CascStorage, FileStatus } from '../casc/storage';
import { EncryptedError } from '../casc/blte';
import { parseAdtRoot, tileHeightGrid } from '../formats/adt';
import { blpInfo, decodeBlp, type Image } from '../formats/blp';
import { downscale } from './image';
import { parseWdt, TILE_FILE_KINDS, type TileFileKind, type Wdt, type WdtTile } from '../formats/wdt';
import { RETAIL } from '../edition';

/**
 * Continents whose file IDs are known; Map.db2 will replace this list. wdl 0: none found, so the
 * distant terrain is made from the ADTs. `between`: laid out in the sea between Kalimdor and
 * the Eastern Kingdoms (the Maelstrom) rather than south of them. `underground`: under the
 * Maelstrom in the game (Deepholm); laid out far off, out of sight, and reached by going down
 * into the Maelstrom (see the viewer's checkDeepholm). `detailDistance`: yards out to which its
 * tiles load in full detail (with all their models), for a small map whose whole look is in its
 * models (the whirlpool), so it shows from afar.
 */
export const KNOWN_MAPS: { name: string; directory: string; mapId: number; wdt: number; wdl: number; between?: boolean; underground?: boolean; detailDistance?: number; hiddenTiles?: TileRect[] }[] = [
	{ name: 'Eastern Kingdoms', directory: 'Azeroth', mapId: 0, wdt: 775971, wdl: 775970 },
	{ name: 'Kalimdor', directory: 'Kalimdor', mapId: 1, wdt: 782779, wdl: 782778 },
	// Retail only; its WDL isn't right before its WDT.
	...(RETAIL ? [
		// Out in the open sea Zandalar has blocks of flat filler tiles a little above the water, with
		// a plain grey minimap: left out, so no bare grey plates stand in the sea.
		{ name: 'Zandalar', directory: 'Zandalar', mapId: 1642, wdt: 1436413, wdl: 1436416, hiddenTiles: [[58, 0, 63, 12], [57, 5, 57, 7], [16, 27, 16, 32]] as TileRect[] },
		{ name: 'The Maelstrom', directory: 'MaelstromZone', mapId: 730, wdt: 816998, wdl: 0, between: true, detailDistance: 8000 },
		{ name: 'Deepholm', directory: 'Deephome', mapId: 646, wdt: 816934, wdl: 0, underground: true },
	] : []),
];

/**
 * Retail terrain swaps shown in place of their parent map's own tiles, by the parent's WDT: the
 * game shows these to everyone now, the base map's tiles being from before the change.
 * Silithus: The Wound (Map 1817, Battle for Azeroth): the crater and its azerite, and the Sword
 * of Sargeras standing in it (a WMO, see SWORD_OF_SARGERAS).
 */
export const TERRAIN_SWAPS: Record<number, { wdt: number }[]> = RETAIL ? { 782779: [{ wdt: 1711065 }] } : {};

/**
 * The Sword of Sargeras: its WMO, and the map and tile whose objects place it (see TERRAIN_SWAPS).
 * effects: M2s placed with it: the red energy wreathing it (7FX_SargerasSword_FX, a game object
 * the map files leave out) and the smoke from the crater (7FX_SargerasSword_Smoke_FX, which the
 * map files place, but only as a nearby doodad).
 */
export const SWORD_OF_SARGERAS = { fdid: 1668175, mapId: 1, tileX: 28, tileY: 43, effects: [1782994, 1822190] };

/**
 * Deathwing perched on Stormwind's gate, as on Cataclysm's login screen (retail): that screen's
 * scene model (UI_MainMenu_Cataclysm), of which only Deathwing is drawn (batches; the scene's own
 * walls, towers, sky and fire are left out), set so his front claws grip the real gate towers' tops
 * and he looms over the gate as there. Placed with the gate's tile (mapId, tileX, tileY).
 * at: where the anchor goes: between the gate's towers, a little out from their middles, on their
 * tops (WoW world x north, y west, z up); facing: the way the gate faces (WoW orientation,
 * degrees); anchor: between his front claws, at the scene's tower tops (model units); scale: model
 * units to yards (his front claws, as seen, are about 13 units apart, the real towers 79 yards).
 */
export const DEATHWING_ON_STORMWIND = {
	fdid: 466614,
	mapId: 0,
	tileX: 30,
	tileY: 48,
	batches: [50, 51, 52, 53, 54, 55, 56],
	at: [-8922.1, 546.1, 162] as const,
	facing: 218.95,
	anchor: [2.4, -1.75, 10.3] as const,
	scale: 6,
};

/** Tiles x0..x1, y0..y1 (inclusive) of a map's grid. */
export type TileRect = [number, number, number, number];

/** Whether a map (by its WDT) leaves out this tile (see KNOWN_MAPS hiddenTiles). */
export function isHiddenTile(wdtFdid: number, x: number, y: number): boolean {
	const rects = KNOWN_MAPS.find((m) => m.wdt === wdtFdid)?.hiddenTiles;
	return !!rects?.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
}

export type FileAvailability = Record<TileFileKind, Partial<Record<FileStatus | 'none', number>>>;

export interface MapSummary {
	wdtFdid: number;
	flags: number;
	tileCount: number;
	tiles: WdtTile[];
	/** Across all tiles: how many of each per-tile file are listed and readable locally. */
	availability: FileAvailability;
}

export interface TileFile {
	kind: TileFileKind;
	fdid: number;
	status: FileStatus | 'none';
}

export interface TileDetails {
	x: number;
	y: number;
	files: TileFile[];
	heightGrid?: { size: number; heights: Float32Array; min: number; max: number };
	areaIds: number[];
	chunkCount: number;
	holeChunks: number;
	hasWater: boolean;
	rootChunkIds: string[];
	minimap?: Image;
	mapTexture?: Image & { sourceSize: string };
	errors: string[];
	timeMs: number;
}

export class MapExplorer {
	private readonly wdts = new Map<number, Wdt>();

	constructor(readonly storage: CascStorage) {}

	async wdt(fdid: number): Promise<Wdt> {
		let wdt = this.wdts.get(fdid);
		if (!wdt) {
			wdt = parseWdt(await this.storage.readFile(fdid));
			for (let i = 0; i < wdt.tiles.length; i++) if (isHiddenTile(fdid, i % 64, Math.floor(i / 64))) wdt.tiles[i] = null;
			for (const swap of TERRAIN_SWAPS[fdid] ?? []) {
				const tiles = parseWdt(await this.storage.readFile(swap.wdt)).tiles;
				tiles.forEach((t, i) => {
					if (t) wdt!.tiles[i] = t;
				});
			}
			this.wdts.set(fdid, wdt);
		}
		return wdt;
	}

	private fileStatus(fdid: number): FileStatus | 'none' {
		return fdid === 0 ? 'none' : this.storage.status(fdid);
	}

	async loadMap(wdtFdid: number): Promise<MapSummary> {
		const wdt = await this.wdt(wdtFdid);
		const tiles = wdt.tiles.filter((t): t is WdtTile => t !== null);
		const availability = Object.fromEntries(TILE_FILE_KINDS.map((k) => [k, {}])) as FileAvailability;
		for (const tile of tiles) {
			for (const kind of TILE_FILE_KINDS) {
				const status = this.fileStatus(tile.files[kind]);
				availability[kind][status] = (availability[kind][status] ?? 0) + 1;
			}
		}
		return { wdtFdid, flags: wdt.flags, tileCount: wdt.tileCount, tiles, availability };
	}

	async loadTile(wdtFdid: number, x: number, y: number): Promise<TileDetails> {
		const start = performance.now();
		const tile = (await this.wdt(wdtFdid)).tiles[y * 64 + x];
		if (!tile) throw new Error(`Map has no tile ${x}_${y}`);

		const details: TileDetails = {
			x,
			y,
			files: TILE_FILE_KINDS.map((kind) => ({ kind, fdid: tile.files[kind], status: this.fileStatus(tile.files[kind]) })),
			areaIds: [],
			chunkCount: 0,
			holeChunks: 0,
			hasWater: false,
			rootChunkIds: [],
			errors: [],
			timeMs: 0,
		};
		const attempt = async (what: string, fdid: number, fn: (bytes: Uint8Array) => void) => {
			if (fdid === 0) return;
			try {
				fn(await this.storage.readFile(fdid));
			} catch (e) {
				details.errors.push(`${what}: ${describeError(e)}`);
			}
		};

		await Promise.all([
			attempt('Terrain', tile.files.root, (bytes) => {
				const adt = parseAdtRoot(bytes);
				details.heightGrid = tileHeightGrid(adt);
				details.areaIds = [...new Set(adt.chunks.map((c) => c.areaId))].sort((a, b) => a - b);
				details.chunkCount = adt.chunks.length;
				details.holeChunks = adt.chunks.filter((c) => c.holes.some((row) => row !== 0)).length;
				details.hasWater = adt.hasWater;
				details.rootChunkIds = adt.chunkIds;
			}),
			attempt('Minimap', tile.files.minimap, (bytes) => {
				details.minimap = decodeBlp(bytes, 256);
			}),
			attempt('Map texture', tile.files.mapTexture, (bytes) => {
				const info = blpInfo(bytes);
				details.mapTexture = { ...decodeBlp(bytes, 512), sourceSize: `${info.width}x${info.height}` };
			}),
		]);
		details.timeMs = Math.round(performance.now() - start);
		return details;
	}

	/** Small minimap thumbnails for an overview, decoded from a low mip level. */
	async minimapThumbnails(wdtFdid: number, coords: [number, number][], size: number): Promise<{ x: number; y: number; image: Image | null }[]> {
		const wdt = await this.wdt(wdtFdid);
		return Promise.all(coords.map(async ([x, y]) => {
			const fdid = wdt.tiles[y * 64 + x]?.files.minimap ?? 0;
			if (fdid === 0 || this.storage.status(fdid) !== 'ok') return { x, y, image: null };
			try {
				return { x, y, image: downscale(decodeBlp(await this.storage.readFile(fdid), size), size) };
			} catch {
				return { x, y, image: null };
			}
		}));
	}
}

export function describeError(e: unknown): string {
	if (e instanceof EncryptedError) return `encrypted (key ${e.keyName})`;
	return e instanceof Error ? e.message : String(e);
}
