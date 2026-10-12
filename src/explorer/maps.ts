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
export const KNOWN_MAPS: { name: string; directory: string; mapId: number; wdt: number; wdl: number; between?: boolean; underground?: boolean; detailDistance?: number }[] = [
	{ name: 'Eastern Kingdoms', directory: 'Azeroth', mapId: 0, wdt: 775971, wdl: 775970 },
	{ name: 'Kalimdor', directory: 'Kalimdor', mapId: 1, wdt: 782779, wdl: 782778 },
	// Retail only; its WDL isn't right before its WDT.
	...(RETAIL ? [
		{ name: 'Zandalar', directory: 'Zandalar', mapId: 1642, wdt: 1436413, wdl: 1436416 },
		{ name: 'The Maelstrom', directory: 'MaelstromZone', mapId: 730, wdt: 816998, wdl: 0, between: true, detailDistance: 8000 },
		{ name: 'Deepholm', directory: 'Deephome', mapId: 646, wdt: 816934, wdl: 0, underground: true },
	] : []),
];

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
