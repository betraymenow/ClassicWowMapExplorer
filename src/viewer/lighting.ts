import * as THREE from 'three';
import { LIGHT_COLORS, type LightColor, type LightingData, type LightKey, type LightZone } from '../explorer/lighting';

export const DAY = 2880; // half-minutes

/** How much of the direct light's hue is replaced by the sun's (0 = the game's colour as is). */
const DIRECT_NATURAL = 0.75;

export interface LightState {
	colors: Record<LightColor, THREE.Color>;
	fogEnd: number;
	fogScaler: number;
	/** How much of each colour grading table to use (file ID -> weight, summing to 1; 0 = none). */
	grading: Map<number, number>;
	/** Height fog thickness, 1 normal. */
	fogDensity: number;
}

interface Sampled {
	colors: THREE.Color[];
	fogEnd: number;
	fogScaler: number;
	grading: Map<number, number>;
	fogDensity: number;
}

/** Adds weight of a grading table to a blend. */
function addGrading(into: Map<number, number>, id: number, weight: number): void {
	if (weight > 0) into.set(id, (into.get(id) ?? 0) + weight);
}

const toColor = (hex: number) => new THREE.Color().setHex(hex); // sRGB hex -> linear working space

/** Interpolates between the keyframes around time t on the 24-hour cycle. */
function around<T extends { time: number }>(keys: T[], t: number): [T, T, number] {
	let i = keys.length - 1;
	for (let k = 0; k < keys.length; k++) if (keys[k].time <= t) i = k;
	const a = keys[i];
	const b = keys[(i + 1) % keys.length];
	const span = (b.time - a.time + DAY) % DAY || DAY;
	return [a, b, ((t - a.time + DAY) % DAY) / span];
}

/**
 * Samples the game's light zones (Light/LightData) at a position and time: the continent's
 * global light, with nearby zones blended in by distance, like the client does.
 */
export class Lighting {
	private readonly cache = new Map<number, { t: number; value: Sampled }>();

	constructor(private readonly data: LightingData) {}

	private sampleParams(params: number, t: number): Sampled | null {
		const cached = this.cache.get(params);
		if (cached && cached.t === t) return cached.value;
		const keys = this.data.keys[params];
		if (!keys?.length) return null;
		const [a, b, f] = around(keys, t);
		const colors = LIGHT_COLORS.map((_, i) => toColor(a.colors[i]).lerp(toColor(b.colors[i]), f));
		// Fog is only set on some keyframes; interpolate between those.
		const fogKeys = keys.filter((k) => k.fogEnd > 0);
		let fogEnd = 0;
		let fogScaler = a.fogScaler + (b.fogScaler - a.fogScaler) * f;
		if (fogKeys.length) {
			const [fa, fb, ff] = around<LightKey>(fogKeys, t);
			fogEnd = fa.fogEnd + (fb.fogEnd - fa.fogEnd) * ff;
		}
		const grading = new Map<number, number>();
		addGrading(grading, a.grading, 1 - f);
		addGrading(grading, b.grading, f);
		const fogDensity = a.fogDensity + (b.fogDensity - a.fogDensity) * f;
		const value = { colors, fogEnd, fogScaler, grading, fogDensity };
		this.cache.set(params, { t, value });
		return value;
	}

	/** wowX/wowY are world coordinates (x north, y west); t is half-minutes since midnight. */
	sample(mapId: number, wowX: number, wowY: number, t: number): LightState | null {
		let global: LightZone | null = null;
		const local: { zone: LightZone; weight: number }[] = [];
		for (const zone of this.data.zones) {
			if (zone.mapId !== mapId) continue;
			if (zone.outer === 0) {
				global ??= zone;
				continue;
			}
			const d = Math.hypot(wowX - zone.x, wowY - zone.y);
			if (d >= zone.outer) continue;
			const weight = d <= zone.inner ? 1 : 1 - (d - zone.inner) / (zone.outer - zone.inner);
			local.push({ zone, weight });
		}

		const parts: { value: Sampled; weight: number }[] = [];
		let total = 0;
		for (const { zone, weight } of local) {
			const value = this.sampleParams(zone.params, t);
			if (value) {
				parts.push({ value, weight });
				total += weight;
			}
		}
		if (total > 1) for (const p of parts) p.weight /= total;
		const globalValue = global ? this.sampleParams(global.params, t) : null;
		if (globalValue && total < 1) parts.push({ value: globalValue, weight: 1 - total });
		if (!parts.length) return null;

		const sum = parts.reduce((s, p) => s + p.weight, 0);
		const colors = {} as Record<LightColor, THREE.Color>;
		LIGHT_COLORS.forEach((name, i) => {
			const c = new THREE.Color(0, 0, 0);
			for (const p of parts) c.add(p.value.colors[i].clone().multiplyScalar(p.weight / sum));
			colors[name] = c;
		});
		// The game's direct light is strongly orange in places (Elwynn's noon is #ff8800), which tints
		// the whole ground here. Keep its brightness but take most of its hue from the sun's colour.
		const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
		const sunLum = lum(colors.sun);
		if (sunLum > 0) colors.direct.lerp(colors.sun.clone().multiplyScalar(lum(colors.direct) / sunLum), DIRECT_NATURAL);
		let fogEnd = 0;
		let fogWeight = 0;
		let fogScaler = 0;
		let fogDensity = 0;
		const grading = new Map<number, number>();
		for (const p of parts) {
			fogDensity += (p.value.fogDensity * p.weight) / sum;
			for (const [id, w] of p.value.grading) addGrading(grading, id, (w * p.weight) / sum);
			fogScaler += (p.value.fogScaler * p.weight) / sum;
			if (p.value.fogEnd > 0) {
				fogEnd += p.value.fogEnd * p.weight;
				fogWeight += p.weight;
			}
		}
		return { colors, fogEnd: fogWeight ? fogEnd / fogWeight : 0, fogScaler, grading, fogDensity };
	}
}

/** Direction to the sun for a time of day: rises in the east at 6:00, highest at noon. */
export function sunDirection(t: number, out = new THREE.Vector3()): THREE.Vector3 {
	const angle = (t / DAY - 0.25) * Math.PI * 2;
	return out.set(Math.cos(angle), Math.sin(angle), 0.45).normalize();
}

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
	vDir = normalize(position);
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// The client's sky is a gradient through six colours from the horizon up.
const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uMiddle;
uniform vec3 uBand1;
uniform vec3 uBand2;
uniform vec3 uSmog;
uniform vec3 uFog;
uniform vec3 uSun;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
	vec3 d = normalize(vDir);
	float h = d.y;
	vec3 c = uFog;
	c = mix(c, uSmog, smoothstep(0.0, 0.05, h));
	c = mix(c, uBand2, smoothstep(0.05, 0.12, h));
	c = mix(c, uBand1, smoothstep(0.12, 0.25, h));
	c = mix(c, uMiddle, smoothstep(0.25, 0.5, h));
	c = mix(c, uTop, smoothstep(0.5, 1.0, h));
	float s = max(dot(d, normalize(uSunDir)), 0.0);
	c += uSun * (pow(s, 2000.0) * 4.0 + pow(s, 12.0) * 0.18) * step(-0.05, uSunDir.y);
	gl_FragColor = vec4(c, 1.0);
	#include <colorspace_fragment>
}
`;

/** Sky dome that follows the camera and is drawn behind everything. */
export class Sky {
	readonly mesh: THREE.Mesh;
	private readonly uniforms = {
		uTop: { value: new THREE.Color() },
		uMiddle: { value: new THREE.Color() },
		uBand1: { value: new THREE.Color() },
		uBand2: { value: new THREE.Color() },
		uSmog: { value: new THREE.Color() },
		uFog: { value: new THREE.Color() },
		uSun: { value: new THREE.Color() },
		uSunDir: { value: new THREE.Vector3(0, 1, 0) },
	};

	constructor() {
		const material = new THREE.ShaderMaterial({
			uniforms: this.uniforms,
			vertexShader: SKY_VERTEX,
			fragmentShader: SKY_FRAGMENT,
			side: THREE.BackSide,
			depthTest: false,
			depthWrite: false,
		});
		this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), material);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = -1000;
	}

	update(state: LightState, sunDir: THREE.Vector3, camera: THREE.Vector3): void {
		const u = this.uniforms;
		const c = state.colors;
		u.uTop.value.copy(c.skyTop);
		u.uMiddle.value.copy(c.skyMiddle);
		u.uBand1.value.copy(c.skyBand1);
		u.uBand2.value.copy(c.skyBand2);
		u.uSmog.value.copy(c.skySmog);
		u.uFog.value.copy(c.skyFog);
		u.uSun.value.copy(c.sun);
		u.uSunDir.value.copy(sunDir);
		this.mesh.position.copy(camera);
	}

	/** Brightens every band of the sky (for a place whose own light is too dark). Call after update. */
	brighten(k: number): void {
		const u = this.uniforms;
		for (const c of [u.uTop, u.uMiddle, u.uBand1, u.uBand2, u.uSmog, u.uFog]) c.value.multiplyScalar(k);
	}

	/** Clouds the sky over (weather): every band pulled towards one colour, the sun hidden as much. Call after update. */
	overcast(color: THREE.Color, amount: number): void {
		const u = this.uniforms;
		for (const c of [u.uTop, u.uMiddle, u.uBand1, u.uBand2, u.uSmog, u.uFog]) c.value.lerp(color, amount);
		u.uSun.value.multiplyScalar(1 - amount);
	}
}
