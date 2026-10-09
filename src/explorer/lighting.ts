import type { CascStorage } from '../casc/storage';
import { DB2_FILES, loadTable } from './clientDb';

/** Order of the colours in a LightKey (LightData fields 3-15). */
export const LIGHT_COLORS = [
	'direct', 'ambient', 'skyTop', 'skyMiddle', 'skyBand1', 'skyBand2', 'skySmog', 'skyFog',
	'sun', 'cloudSun', 'cloudEmissive', 'cloudLayer1', 'cloudLayer2',
	// Water, looking into it: what the view fades to near and far, in the sea and in rivers and lakes.
	'oceanClose', 'oceanFar', 'riverClose', 'riverFar',
] as const;
export type LightColor = (typeof LIGHT_COLORS)[number];

export interface LightKey {
	/** Half-minutes since midnight, 0-2879. */
	time: number;
	/** 0xRRGGBB, in LIGHT_COLORS order. */
	colors: number[];
	/** Yards; 0 = not set in this keyframe. */
	fogEnd: number;
	fogScaler: number;
	/** Colour grading lookup table (a 1024x32 BLP, 32 slices of 32x32), 0 for none. */
	grading: number;
	/**
	 * How thick the height fog is, 1 normal. A guess: one of Forever's unnamed LightData fields
	 * (1.60.1 field 51), which is highest in Duskwood (3) and Ashenvale (2) and lowest in Dun Morogh (0.4).
	 */
	fogDensity: number;
}

/** A Light.db2 zone: global when outer is 0, otherwise a sphere in world coordinates. */
export interface LightZone {
	mapId: number;
	x: number;
	y: number;
	z: number;
	inner: number;
	outer: number;
	/** LightParams ID for clear weather (the first of the zone's parameter sets). */
	params: number;
}

export interface LightingData {
	zones: LightZone[];
	/** Keyframes per LightParams ID, sorted by time. */
	keys: Record<number, LightKey[]>;
}

export interface AreaInfo {
	id: number;
	name: string;
	parent: number;
}

const f32 = new DataView(new ArrayBuffer(4));
const asFloat = (raw: number) => {
	f32.setUint32(0, raw);
	return f32.getFloat32(0);
};

/** Light zones and their day-cycle keyframes for the given maps (Map.db2 IDs). */
export async function loadLighting(storage: CascStorage, mapIds: number[]): Promise<LightingData> {
	const [lights, data] = await Promise.all([loadTable(storage, DB2_FILES.Light), loadTable(storage, DB2_FILES.LightData)]);
	const zones: LightZone[] = [];
	for (const id of lights.ids()) {
		const mapId = lights.getInt(id, 3)!;
		if (!mapIds.includes(mapId)) continue;
		const params = lights.getInt(id, 4, 0)!;
		if (!params) continue;
		zones.push({
			mapId,
			x: lights.getFloat(id, 0, 0)!,
			y: lights.getFloat(id, 0, 1)!,
			z: lights.getFloat(id, 0, 2)!,
			inner: lights.getFloat(id, 1)!,
			outer: lights.getFloat(id, 2)!,
			params,
		});
	}

	const wanted = new Set(zones.map((z) => z.params));
	const keys: Record<number, LightKey[]> = {};
	// Forever's LightData has one more leading field than Classic Era's (46 fields) and retail's (47).
	const o = data.fieldCount >= 50 ? 0 : -1;
	for (const id of data.ids()) {
		const param = data.getInt(id, 1 + o)!;
		if (!wanted.has(param)) continue;
		(keys[param] ??= []).push({
			// The high 16 bits hold something else; the time is the low half.
			time: data.getInt(id, 2 + o)! & 0xffff,
			colors: LIGHT_COLORS.map((_, i) => data.getInt(id, 3 + o + i)!),
			fogEnd: asFloat(data.getInt(id, 21 + o)!),
			fogScaler: asFloat(data.getInt(id, 22 + o)!),
			grading: data.getInt(id, 32 + o) ?? 0,
			fogDensity: data.fieldCount > 51 ? asFloat(data.getInt(id, 51) ?? 0) || 1 : 1,
		});
	}
	for (const list of Object.values(keys)) list.sort((a, b) => a.time - b.time);
	return { zones, keys };
}

/** Area names and parents (AreaTable.db2), for zone and subzone display. */
export async function loadAreas(storage: CascStorage): Promise<AreaInfo[]> {
	const table = await loadTable(storage, DB2_FILES.AreaTable);
	return table.ids().map((id) => ({ id, name: table.getString(id, 1) ?? '', parent: table.getInt(id, 3) ?? 0 }));
}
