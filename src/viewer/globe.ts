import * as THREE from 'three';
import type { AsyncStorageApi } from '../worker/protocol';
import type { FarTile } from '../explorer/world';
import type { ContinentPlacement } from './terrain';
import { TILE_SIZE } from '../formats/adt';
import { DAY } from './lighting';
import { SWORD_OF_SARGERAS } from '../explorer/maps';
import { RETAIL } from '../edition';
import { createModelMaterial } from './modelMaterials';
import { createTexture } from './textures';

/**
 * Azeroth as a planet, seen as from space: the continents coloured as the land would look
 * (forest, grassland, desert, bare rock and snow on the peaks, from the minimap's colours and
 * the game's heights) over a deep blue sea that turns turquoise in the shallows; clouds drifting
 * east over it all and casting their shadows, the Maelstrom's storm turning in place over its
 * fiery eye; ice at the poles, a glowing atmosphere, the sun (from the time of day) and a starry
 * nebula behind. Shown instead of the flat world when the camera climbs high enough or with O;
 * drag turns it, the wheel zooms, and zooming right in or double-clicking flies back down to the
 * flat world (which keeps the game's own map look).
 *
 * The world's tile grid is wrapped round the sphere from its centre outwards (an azimuthal
 * equidistant projection): distances from the centre are kept, so the continents aren't squeezed
 * towards the poles, and the camera keeps the grid's north up wherever it looks, so the planet
 * lines up with the flat map when going down.
 */

/** How far round the globe (radians) the laid-out world reaches from its centre, north and south. */
const WORLD_REACH = THREE.MathUtils.degToRad(86);
/** How far from the world's centre (radians) the view may turn: past this the grid gets too stretched to steer by. */
const VIEW_REACH = THREE.MathUtils.degToRad(140);
/** Pixels per tile in the continents' picture (and per tile read from the game). */
const LAND_CELL = 32;
/** Pixels per tile in the land's colour (blurred from the minimap). */
const BIOME_CELL = 8;
/** Pixels per tile in the heights picture (a WDL tile's 16 cells). */
const RELIEF_CELL = 16;
const BATCH = 48;
/** Camera distance from the centre, in globe radii. */
const DIST_MIN = 1.18;
const DIST_MAX = 4.5;
const DIST_START = 2.3;
/** Zooming in past this goes back down to the world. */
const DIST_EXIT = 1.22;
/** Map.db2 ID of the Maelstrom's own zone (retail). */
const MAELSTROM_MAP = 730;
/**
 * How many times faster the clouds go while time runs on (Y; backwards with Shift+Y). Not the
 * clock's own speed-up (a whole day in seconds), at which they would only flicker round.
 */
const CLOUDS_FAST = 40;
/**
 * The Sword of Sargeras on the planet: this many times its true size with the whole planet in
 * view, so it reads as the landmark it is, shrinking to true size as the camera comes down (so
 * it matches the flat world's when going down).
 */
const SWORD_BOOST = 1.6;
/** The Maelstrom's storm: its radius (radians round the globe). */
const STORM_RADIUS = 0.15;

export interface GlobeExit {
	/** Where the view's centre falls, in the world's tile grid (as world x / TILE_SIZE, z / TILE_SIZE). */
	tileX: number;
	tileY: number;
	/** How high over the ground (yards) the globe was seen from, to come down at the same scale. */
	height: number;
}

interface Rect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export class Globe {
	active = false;
	/** Called when the globe is left by zooming in or double-clicking, with where to go down. */
	onExit: ((to: GlobeExit) => void) | null = null;

	private readonly scene = new THREE.Scene();
	private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 500);
	private readonly planet = new THREE.Group();
	private readonly surface: THREE.Mesh;
	private readonly halo: THREE.Mesh;
	private readonly sunGlow: THREE.Sprite;
	/** Lights for the models standing on the planet (the surface and clouds light themselves). */
	private readonly sun = new THREE.DirectionalLight(0xfff4e6, 2.6);
	private readonly sword = new THREE.Group();
	private readonly landCanvas = document.createElement('canvas');
	private readonly landTexture: THREE.CanvasTexture;
	private readonly biomeCanvas = document.createElement('canvas');
	private readonly biomeTexture: THREE.CanvasTexture;
	private readonly coastCanvas = document.createElement('canvas');
	private readonly coastTexture: THREE.CanvasTexture;
	/** Uniforms the surface and the clouds share (in the planet's own space), set each frame. */
	private readonly shared = {
		sunObj: { value: new THREE.Vector3(0, 0, 1) },
		camObj: { value: new THREE.Vector3(0, 0, 1) },
		cloudTime: { value: 0 },
		stormAxis: { value: new THREE.Vector3(0, 0, 1) },
		stormRadius: { value: STORM_RADIUS },
	};
	private painting: Promise<void> | null = null;
	/** The clouds' own clock (seconds): real time, run faster or backwards along with the time of day. */
	private cloudClock = 0;
	/** The view: which point of the world's grid faces the camera, and how far off it is. */
	private view = { x: 0, y: 0 };
	private dist = DIST_START;
	private targetDist = DIST_START;
	private drag: { x: number; y: number } | null = null;
	private readonly world: Rect;
	/** Radians round the globe per tile. */
	private readonly scale: number;
	private readonly center: { x: number; y: number };

	constructor(
		private readonly element: HTMLElement,
		private readonly storage: AsyncStorageApi,
		private readonly continents: ContinentPlacement[],
		private readonly tilesOf: (c: ContinentPlacement) => [number, number][],
		farTilesOf: (c: ContinentPlacement) => FarTile[],
	) {
		// The laid-out world: every continent's tiles, in the shared grid.
		const rect: Rect = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
		for (const c of continents) {
			for (const [x, y] of tilesOf(c)) {
				rect.minX = Math.min(rect.minX, x + c.offsetX);
				rect.minY = Math.min(rect.minY, y + c.offsetY);
				rect.maxX = Math.max(rect.maxX, x + c.offsetX + 1);
				rect.maxY = Math.max(rect.maxY, y + c.offsetY + 1);
			}
		}
		this.world = rect;
		this.center = { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 };
		const width = rect.maxX - rect.minX;
		const height = rect.maxY - rect.minY;
		this.scale = WORLD_REACH / Math.max(width / 2, height / 2, 1);
		this.view = { ...this.center };

		// The continents' picture covers just the laid-out world; the shader puts it on the sphere.
		this.landCanvas.width = width * LAND_CELL;
		this.landCanvas.height = height * LAND_CELL;
		this.landTexture = canvasTexture(this.landCanvas, true);
		this.landTexture.anisotropy = 8;
		this.biomeCanvas.width = width * BIOME_CELL;
		this.biomeCanvas.height = height * BIOME_CELL;
		this.biomeTexture = canvasTexture(this.biomeCanvas, true);
		// How near the land the sea is (for the shallows), at a quarter of the picture's size.
		this.coastCanvas.width = Math.max(1, Math.round((width * LAND_CELL) / 4));
		this.coastCanvas.height = Math.max(1, Math.round((height * LAND_CELL) / 4));
		this.coastTexture = canvasTexture(this.coastCanvas, false);
		const relief = reliefCanvas(continents, farTilesOf, rect);

		const storm = this.maelstromTile();
		if (storm) this.shared.stormAxis.value.copy(this.dirOf(storm.x, storm.y));
		else this.shared.stormRadius.value = 0;

		this.surface = new THREE.Mesh(
			new THREE.SphereGeometry(1, 256, 128),
			surfaceMaterial({
				land: this.landTexture,
				biome: this.biomeTexture,
				coast: this.coastTexture,
				relief: canvasTexture(relief.canvas, false),
				marks: relief.marks,
				sea: canvasTexture(seaCanvas(), false, true),
				rect,
				center: this.center,
				scale: this.scale,
				shared: this.shared,
			}),
		);
		this.planet.add(this.surface);
		this.planet.add(new THREE.Mesh(new THREE.SphereGeometry(1.008, 192, 96), cloudMaterial(this.shared)));
		this.halo = atmosphereHalo();
		this.scene.add(this.planet, this.halo, nebula(), stars(), this.sun, new THREE.AmbientLight(0x6070a0, 0.35));
		this.planet.add(this.sword);
		if (RETAIL) void this.buildSword();

		this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('255,248,230', 0.16), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
		this.scene.add(this.sunGlow);

		element.addEventListener('pointerdown', (e) => {
			if (!this.active || e.button !== 0) return;
			this.drag = { x: e.clientX, y: e.clientY };
		});
		window.addEventListener('pointermove', (e) => {
			if (!this.active || !this.drag) return;
			// Turn less the closer the camera, so the ground under the mouse keeps up.
			const k = (0.0045 * (this.dist - 1)) / this.scale;
			this.moveView(this.view.x - (e.clientX - this.drag.x) * k, this.view.y - (e.clientY - this.drag.y) * k);
			this.drag = { x: e.clientX, y: e.clientY };
		});
		window.addEventListener('pointerup', () => (this.drag = null));
		element.addEventListener('wheel', (e) => {
			if (!this.active) return;
			e.preventDefault();
			this.targetDist = THREE.MathUtils.clamp(this.targetDist * (e.deltaY > 0 ? 1.15 : 1 / 1.15), DIST_MIN, DIST_MAX);
		}, { passive: false });
		element.addEventListener('dblclick', (e) => {
			if (!this.active) return;
			const hit = this.pick(e);
			if (hit) this.leave(hit);
		});
	}

	/**
	 * Shows the globe with the place the world view was centred on facing the camera, from as
	 * high as the camera was (so the two views line up), then pulling back to see the planet
	 * unless it was already that high.
	 */
	enter(tileX: number, tileY: number, height: number): void {
		this.moveView(tileX, tileY);
		this.dist = THREE.MathUtils.clamp(this.distanceFor(height), DIST_MIN, DIST_MAX);
		this.targetDist = Math.max(this.dist, DIST_START);
		this.active = true;
		this.painting ??= this.paintWorld();
	}

	/** The globe's radius in yards: a tile is TILE_SIZE yards along the ground and `scale` radians round. */
	private get radiusYards(): number {
		return TILE_SIZE / this.scale;
	}

	/** Camera distance (in radii) that shows the ground as from this height (yards). */
	private distanceFor(height: number): number {
		return 1 + Math.max(0, height) / this.radiusYards;
	}

	/** Height over the ground (yards) matching the camera's distance now. */
	private heightNow(): number {
		return (this.dist - 1) * this.radiusYards;
	}

	/** Back down to the world under the view's centre. */
	leaveAtCenter(): void {
		this.leave({ tileX: this.view.x, tileY: this.view.y, height: this.heightNow() });
	}

	/** Leaves without going anywhere (another view takes over). */
	close(): void {
		this.active = false;
		this.drag = null;
	}

	/** timeRunning: 1 or -1 while time is being run on or back (see the viewer's Y), else 0. */
	update(dt: number, timeOfDay: number, timeRunning = 0): void {
		this.dist += (this.targetDist - this.dist) * Math.min(1, dt * 5);
		if (this.dist < DIST_EXIT && this.targetDist <= DIST_MIN + 1e-6) {
			this.leaveAtCenter();
			return;
		}
		// Turned so the view's point faces the camera (on the +z axis) with the grid's north up.
		const dir = this.dirOf(this.view.x, this.view.y);
		const north = this.dirOf(this.view.x, this.view.y - 0.01).sub(this.dirOf(this.view.x, this.view.y + 0.01));
		north.addScaledVector(dir, -north.dot(dir)).normalize();
		const east = new THREE.Vector3().crossVectors(north, dir);
		this.planet.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, north, dir)).invert();
		this.camera.position.set(0, 0, this.dist);
		this.camera.lookAt(0, 0, 0);

		// The sun over the world's centre at noon, going round with the time of day, a little north.
		const sunPhi = Math.PI / 2 + Math.PI - (timeOfDay / DAY) * Math.PI * 2;
		const sunObj = directionOf(sunPhi, Math.PI * 0.4);
		const sunDir = sunObj.clone().applyQuaternion(this.planet.quaternion);
		this.shared.sunObj.value.copy(sunObj);
		this.shared.camObj.value.copy(this.camera.position).applyQuaternion(this.planet.quaternion.clone().invert());
		this.cloudClock = (this.cloudClock + dt * (timeRunning ? timeRunning * CLOUDS_FAST : 1)) % 100000;
		this.shared.cloudTime.value = this.cloudClock;
		(this.halo.material as THREE.ShaderMaterial).uniforms.sunDir.value.copy(sunDir);
		// Far off, so the planet hides it when the sun is behind; the glare peeks round the rim.
		this.sun.position.copy(sunDir);
		this.sword.scale.setScalar(1 + (SWORD_BOOST - 1) * THREE.MathUtils.smoothstep(this.dist, DIST_EXIT, DIST_START));
		this.sunGlow.position.copy(sunDir).multiplyScalar(40);
		this.sunGlow.scale.setScalar(26);
	}

	render(renderer: THREE.WebGLRenderer): void {
		const w = this.element.clientWidth || window.innerWidth;
		const h = this.element.clientHeight || window.innerHeight;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		renderer.setRenderTarget(null);
		renderer.render(this.scene, this.camera);
	}

	/** Hands the place over to onExit, which closes the globe (see close) and takes the camera there. */
	private leave(to: GlobeExit): void {
		const clamped = {
			tileX: THREE.MathUtils.clamp(to.tileX, this.world.minX, this.world.maxX),
			tileY: THREE.MathUtils.clamp(to.tileY, this.world.minY, this.world.maxY),
			height: to.height,
		};
		if (this.onExit) this.onExit(clamped);
		else this.close();
	}

	/** Points the view at a place of the grid, kept within VIEW_REACH of the world's centre. */
	private moveView(tileX: number, tileY: number): void {
		const a = (tileX - this.center.x) * this.scale;
		const b = (tileY - this.center.y) * this.scale;
		const k = Math.min(1, VIEW_REACH / Math.max(Math.hypot(a, b), 1e-9));
		this.view = { x: this.center.x + (a * k) / this.scale, y: this.center.y + (b * k) / this.scale };
	}

	/** The unit vector (in the planet's own space) of a point of the world's tile grid; the centre is +z, north +y. */
	private dirOf(tileX: number, tileY: number): THREE.Vector3 {
		const a = (tileX - this.center.x) * this.scale;
		const b = (tileY - this.center.y) * this.scale;
		const r = Math.hypot(a, b);
		if (r < 1e-9) return new THREE.Vector3(0, 0, 1);
		const k = Math.sin(r) / r;
		return new THREE.Vector3(a * k, -b * k, Math.cos(r));
	}

	/** The grid point at a unit vector of the planet's own space (dirOf's inverse). */
	private tileOfDir(p: THREE.Vector3): { x: number; y: number } {
		const r = Math.acos(THREE.MathUtils.clamp(p.z, -1, 1));
		const len = Math.hypot(p.x, p.y);
		const k = len < 1e-9 ? 0 : r / len;
		return { x: this.center.x + (p.x * k) / this.scale, y: this.center.y - (p.y * k) / this.scale };
	}

	private pick(e: MouseEvent): GlobeExit | null {
		const rect = this.element.getBoundingClientRect();
		const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
		const ray = new THREE.Raycaster();
		ray.setFromCamera(ndc, this.camera);
		const hit = ray.intersectObject(this.surface)[0];
		if (!hit) return null;
		const t = this.tileOfDir(this.surface.worldToLocal(hit.point.clone()).normalize());
		return { tileX: t.x, tileY: t.y, height: this.heightNow() };
	}

	/**
	 * The continents' minimap images, painted into the land picture as they're read (their sea
	 * made see-through), then the land's colours and the coast picture made from it.
	 */
	private async paintWorld(): Promise<void> {
		const ctx = this.landCanvas.getContext('2d')!;
		const scratch = document.createElement('canvas');
		scratch.width = scratch.height = LAND_CELL;
		const sctx = scratch.getContext('2d')!;
		// The Maelstrom zone's minimap is all dark water; the storm stands in for it.
		for (const c of this.continents.filter((c) => c.mapId !== MAELSTROM_MAP)) {
			const coords = this.tilesOf(c);
			for (let i = 0; i < coords.length; i += BATCH) {
				const thumbs = await this.storage.minimapThumbnails(c.wdt, coords.slice(i, i + BATCH), LAND_CELL).catch(() => []);
				for (const { x, y, image } of thumbs) {
					if (!image) continue;
					const rgba = new Uint8ClampedArray(image.rgba);
					seeThroughSea(rgba);
					sctx.clearRect(0, 0, LAND_CELL, LAND_CELL);
					sctx.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
					const px = (x + c.offsetX - this.world.minX) * LAND_CELL;
					const py = (y + c.offsetY - this.world.minY) * LAND_CELL;
					ctx.drawImage(scratch, 0, 0, image.width, image.height, px, py, LAND_CELL, LAND_CELL);
				}
				this.landTexture.needsUpdate = true;
			}
			this.paintBiome();
			this.paintCoast();
		}
	}

	/**
	 * The land's colour: the minimap blurred well past its roads and buildings, each colour then
	 * matched to the nearest natural ones (forest, grass, scrub, sand, red and grey rock, snow), so
	 * each region keeps its character. Painted everywhere (the sea too, from further out) so the
	 * colour holds right up to the coast; the land picture's own alpha says where the land is.
	 */
	private paintBiome(): void {
		const { width, height } = this.biomeCanvas;
		const near = blurred(this.landCanvas, width, height, 2);
		const far = blurred(this.landCanvas, width, height, 12);
		const ctx = this.biomeCanvas.getContext('2d')!;
		const img = ctx.createImageData(width, height);
		const out = img.data;
		for (let i = 0; i < out.length; i += 4) {
			const src = near[i + 3] > 60 ? near : far[i + 3] > 3 ? far : null;
			const [r, g, b] = src ? naturalColour(src[i], src[i + 1], src[i + 2]) : BIOMES[1];
			out[i] = r;
			out[i + 1] = g;
			out[i + 2] = b;
			out[i + 3] = 255;
		}
		ctx.putImageData(img, 0, 0);
		this.biomeTexture.needsUpdate = true;
	}

	/** The land picture's coverage, shrunk and blurred: near 1 at the shore, fading out to sea. */
	private paintCoast(): void {
		const ctx = this.coastCanvas.getContext('2d')!;
		const { width, height } = this.coastCanvas;
		ctx.clearRect(0, 0, width, height);
		ctx.filter = `blur(${Math.max(2, LAND_CELL / 8)}px)`;
		ctx.drawImage(this.landCanvas, 0, 0, width, height);
		ctx.filter = 'none';
		// Coverage is in alpha; spread it into the colour channels the shader reads.
		const img = ctx.getImageData(0, 0, width, height);
		const d = img.data;
		for (let i = 0; i < d.length; i += 4) {
			const v = Math.min(255, d[i + 3] * 1.6);
			d[i] = d[i + 1] = d[i + 2] = v;
			d[i + 3] = 255;
		}
		ctx.putImageData(img, 0, 0);
		this.coastTexture.needsUpdate = true;
	}

	/**
	 * The Sword of Sargeras, placed as on the flat world (the same WMO, from its tile's objects,
	 * and its red energy, the first of its effects; the smoke's particles are left to the flat
	 * world): its placement turned from continent space (x east, y up, z south, in yards) into
	 * the planet's, standing on the ground there.
	 */
	private async buildSword(): Promise<void> {
		const c = this.continents.find((c) => c.mapId === SWORD_OF_SARGERAS.mapId);
		if (!c) return;
		const placement = (await this.storage.loadTileObjects(c.wdt, SWORD_OF_SARGERAS.tileX, SWORD_OF_SARGERAS.tileY)).find((p) => p.fdid === SWORD_OF_SARGERAS.fdid);
		if (!placement) return;
		const models = await this.storage.loadModels([{ fdid: placement.fdid, kind: placement.kind }, { fdid: SWORD_OF_SARGERAS.effects[0], kind: 'm2' }]);
		const textureIds = [...new Set(models.flatMap((m) => m?.batches.flatMap((b) => [b.material.texture, b.material.texture2 ?? 0]) ?? []).filter((t) => t))];
		const textures = new Map<number, THREE.Texture>();
		for (const { fdid, texture } of await this.storage.loadTextures(textureIds, false)) if (texture) textures.set(fdid, createTexture(texture, 8, true));
		const meshes = models.flatMap((data) => {
			if (!data) return [];
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
			geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
			geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
			geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
			const batches = [...data.batches].sort((a, b) => a.order - b.order);
			const materials = batches.map((b, i) => {
				geometry.addGroup(b.start, b.count, i);
				return createModelMaterial(b.material, textures.get(b.material.texture) ?? null, false, null, b.material.texture2 ? textures.get(b.material.texture2) ?? null : null);
			});
			return [new THREE.Mesh(geometry, materials)];
		});
		if (!meshes.length) return;

		// Where it stands, on the grid, and the ground's east, up and south there.
		const local = new THREE.Matrix4().fromArray(placement.matrix);
		const origin = new THREE.Vector3().setFromMatrixPosition(local);
		const tileX = origin.x / TILE_SIZE + c.offsetX;
		const tileY = origin.z / TILE_SIZE + c.offsetY;
		const up = this.dirOf(tileX, tileY);
		const east = this.dirOf(tileX + 0.01, tileY).sub(this.dirOf(tileX - 0.01, tileY)).normalize();
		const south = this.dirOf(tileX, tileY + 0.01).sub(this.dirOf(tileX, tileY - 0.01)).normalize();
		const k = 1 / this.radiusYards;
		const toPlanet = new THREE.Matrix4()
			.makeBasis(east, up, south)
			.multiply(new THREE.Matrix4().makeScale(k, k, k))
			.multiply(new THREE.Matrix4().makeTranslation(-origin.x, 0, -origin.z))
			.multiply(local);
		for (const mesh of meshes) {
			mesh.matrixAutoUpdate = false;
			mesh.matrix.copy(toPlanet);
			this.sword.add(mesh);
		}
		this.sword.position.copy(up);
	}

	/** The Maelstrom's eye, in the world's tile grid: on its own map where it's laid out, else between the continents. */
	private maelstromTile(): { x: number; y: number } | null {
		const ek = this.continents.find((c) => c.mapId === 0);
		const kalimdor = this.continents.find((c) => c.mapId === 1);
		if (!ek || !kalimdor) return null;
		const extent = (c: ContinentPlacement) => {
			const tiles = this.tilesOf(c);
			const xs = tiles.map((t) => t[0] + c.offsetX);
			const ys = tiles.map((t) => t[1] + c.offsetY);
			return { minX: Math.min(...xs), maxX: Math.max(...xs) + 1, minY: Math.min(...ys), maxY: Math.max(...ys) + 1 };
		};
		const zone = this.continents.find((c) => c.mapId === MAELSTROM_MAP);
		if (zone) {
			const e = extent(zone);
			return { x: (e.minX + e.maxX) / 2, y: (e.minY + e.maxY) / 2 };
		}
		const [west, east] = [extent(kalimdor), extent(ek)].sort((a, b) => a.minX - b.minX);
		return { x: (west.maxX + east.minX) / 2, y: (west.minY + west.maxY + east.minY + east.maxY) / 4 };
	}
}

/** The unit vector three.js's SphereGeometry puts at these angles (theta from the north pole). */
function directionOf(phi: number, theta: number): THREE.Vector3 {
	return new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
}

/** A canvas as a texture: sRGB colours (else plain data), wrapping east-west round the sphere if asked. */
function canvasTexture(canvas: HTMLCanvasElement, srgb: boolean, wrap = false): THREE.CanvasTexture {
	const t = new THREE.CanvasTexture(canvas);
	if (srgb) t.colorSpace = THREE.SRGBColorSpace;
	if (wrap) t.wrapS = THREE.RepeatWrapping;
	return t;
}

/** A picture drawn shrunk to w x h and blurred, as RGBA. */
function blurred(source: HTMLCanvasElement, w: number, h: number, radius: number): Uint8ClampedArray {
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
	ctx.filter = `blur(${radius}px)`;
	ctx.drawImage(source, 0, 0, w, h);
	return ctx.getImageData(0, 0, w, h).data;
}

/** The minimap images draw the sea a dark blue-green: made see-through (fading in at the shore) so the planet's own sea shows. */
function seeThroughSea(rgba: Uint8ClampedArray): void {
	for (let i = 0; i < rgba.length; i += 4) {
		const r = rgba[i];
		const g = rgba[i + 1];
		const b = rgba[i + 2];
		const blueish = b - Math.max(r, (g * 3) / 4);
		const dark = 255 - (r + g + b) / 3;
		const water = THREE.MathUtils.smoothstep(blueish, 0, 25) * THREE.MathUtils.smoothstep(dark, 140, 190);
		rgba[i + 3] = Math.round(rgba[i + 3] * (1 - water));
	}
}

/** Natural ground colours (sRGB), as seen from space. */
const BIOMES: [number, number, number][] = [
	[34, 54, 26], // forest
	[74, 94, 42], // grassland
	[122, 112, 68], // dry scrub
	[196, 170, 120], // desert sand
	[138, 84, 54], // red rock
	[102, 96, 88], // grey rock
	[58, 46, 38], // ash and scorched ground
	[48, 58, 38], // swamp and dark woods
	[226, 230, 236], // snow
];

/** A minimap colour as a blend of the natural colours nearest it. */
function naturalColour(r: number, g: number, b: number): [number, number, number] {
	let wr = 0;
	let wg = 0;
	let wb = 0;
	let total = 0;
	for (const [br, bg, bb] of BIOMES) {
		const d2 = (r - br) ** 2 + (g - bg) ** 2 + (b - bb) ** 2;
		const w = Math.exp(-d2 / (2 * 38 * 38));
		wr += br * w;
		wg += bg * w;
		wb += bb * w;
		total += w;
	}
	if (total < 1e-6) return BIOMES[1];
	return [wr / total, wg / total, wb / total];
}

/**
 * Heights from the continents' low-detail terrain: land only, 0 at the sea, brighter for higher.
 * With the heights (in the same units) above which the land turns rocky: the highest fifth of
 * it (and the highest few percent), so it suits however high the world's mountains are.
 */
function reliefCanvas(continents: ContinentPlacement[], farTilesOf: (c: ContinentPlacement) => FarTile[], rect: Rect): { canvas: HTMLCanvasElement; marks: THREE.Vector2 } {
	const canvas = document.createElement('canvas');
	canvas.width = (rect.maxX - rect.minX) * RELIEF_CELL;
	canvas.height = (rect.maxY - rect.minY) * RELIEF_CELL;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(canvas.width, canvas.height);
	const n = RELIEF_CELL;
	const samples: number[] = [];
	for (const c of continents) {
		for (const t of farTilesOf(c)) {
			if (!t.hasAdt || c.mapId === MAELSTROM_MAP) continue;
			const ox = (t.x + c.offsetX - rect.minX) * n;
			const oy = (t.y + c.offsetY - rect.minY) * n;
			for (let r = 0; r < n; r++) {
				for (let col = 0; col < n; col++) {
					const h = THREE.MathUtils.clamp(t.heights[r * (n + 1) + col] / 2000, 0, 1);
					const k = ((oy + r) * canvas.width + ox + col) * 4;
					img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.round(h * 255);
					img.data[k + 3] = 255;
					if (h > 0.005 && (r + col) % 3 === 0) samples.push(h);
				}
			}
		}
	}
	ctx.putImageData(img, 0, 0);
	samples.sort((a, b) => a - b);
	const at = (q: number) => samples[Math.floor((samples.length - 1) * q)] ?? 1;
	return { canvas, marks: new THREE.Vector2(at(0.8), Math.max(at(0.97), at(0.8) + 0.03)) };
}

/** Slow swells of deeper and lighter blue for the open sea, wrapping east-west. */
function seaCanvas(): HTMLCanvasElement {
	const w = 512;
	const h = 256;
	const noise = fbm(w, h, 5, 4, 7);
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(w, h);
	for (let i = 0; i < noise.length; i++) {
		img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = noise[i] * 255;
		img.data[i * 4 + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
	return canvas;
}

function glowTexture(rgb: string, core: number): THREE.CanvasTexture {
	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	g.addColorStop(0, `rgba(${rgb},1)`);
	g.addColorStop(core, `rgba(${rgb},0.55)`);
	g.addColorStop(0.45, `rgba(${rgb},0.12)`);
	g.addColorStop(1, `rgba(${rgb},0)`);
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);
	return canvasTexture(canvas, true);
}

type Shared = Record<string, THREE.IUniform>;

/**
 * The clouds, made on the GPU from 3D noise over the sphere (so no seams and sharp however close):
 * ordinary clouds, streaked east-west and drifting east as they slowly change shape, and the
 * Maelstrom's storm fixed in place, its arms winding into a clear eye and turning slowly.
 * Shared by the clouds and the surface (for their shadows).
 */
const CLOUDS_GLSL = /* glsl */ `
	uniform float cloudTime;
	uniform vec3 stormAxis;
	uniform float stormRadius;
	float hash3(vec3 p) {
		p = fract(p * 0.3183099 + 0.1);
		p *= 17.0;
		return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
	}
	float vnoise(vec3 x) {
		vec3 i = floor(x);
		vec3 f = fract(x);
		f = f * f * (3.0 - 2.0 * f);
		return mix(
			mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
			mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
			f.z);
	}
	const mat3 OCTAVE = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
	float fbmN(vec3 p, int octaves) {
		float sum = 0.0;
		float amp = 0.5;
		float total = 0.0;
		for (int i = 0; i < 8; i++) {
			if (i >= octaves) break;
			sum += amp * vnoise(p);
			total += amp;
			p = OCTAVE * p * 2.03;
			amp *= 0.5;
		}
		return sum / total;
	}
	float plainClouds(vec3 p, int octaves) {
		// Drifting east round the poles' axis, and slowly changing shape.
		float turn = cloudTime * 0.004;
		float c = cos(turn);
		float s = sin(turn);
		vec3 q = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
		vec3 st = q * vec3(5.0, 8.0, 5.0);
		float evolve = cloudTime * 0.002;
		int wo = min(octaves, 2);
		vec3 warp = vec3(
			fbmN(st * 0.45 + vec3(3.1, 7.7, evolve), wo),
			fbmN(st * 0.45 + vec3(9.4, 1.3, -evolve), wo),
			fbmN(st * 0.45 + vec3(5.2, 4.6, evolve), wo));
		float n = fbmN(st + (warp - 0.5) * 1.8 + vec3(0.0, 0.0, evolve), octaves);
		// Cloudier in the storm belts, clearer over the subtropics.
		float belt = 1.0 + 0.05 * cos(abs(q.y) * 9.42);
		// Thin and see-through at the edges, thick in the middle.
		n *= belt;
		return smoothstep(0.575, 0.615, n) * 0.5 + smoothstep(0.605, 0.69, n) * 0.5;
	}
	float stormClouds(vec3 p, float rr) {
		vec3 u = normalize(cross(vec3(0.0, 1.0, 0.0), stormAxis));
		vec3 v = cross(stormAxis, u);
		float a = atan(dot(p, v), dot(p, u)) - cloudTime * 0.035;
		vec2 around = vec2(cos(a), sin(a)) * rr;
		float n = fbmN(vec3(around * 5.0, cloudTime * 0.01), 4);
		float arm = 0.5 + 0.5 * cos(3.0 * (a + 2.4 * log(rr + 0.03)) + (n - 0.5) * 5.0);
		float wall = exp(-pow((rr - 0.17) / 0.07, 2.0)) * 0.35;
		float body = 1.0 - smoothstep(0.75, 1.05, rr);
		float eye = smoothstep(0.05, 0.14, rr);
		float d = arm * 0.55 + n * 0.75 - 0.1 + wall;
		return (smoothstep(0.45, 0.55, d) * 0.5 + smoothstep(0.52, 0.72, d) * 0.5) * body * eye;
	}
	float cloudDensity(vec3 p, int octaves) {
		float plain = plainClouds(p, octaves);
		if (stormRadius <= 0.0) return plain;
		float rr = acos(clamp(dot(p, stormAxis), -1.0, 1.0)) / stormRadius;
		if (rr > 1.6) return plain;
		// The storm draws the clouds round it in: the drifting ones thin out towards it.
		float own = 1.0 - smoothstep(0.9, 1.6, rr);
		return mix(plain, max(stormClouds(p, rr), plain * 0.35 * smoothstep(0.6, 1.0, rr)), own);
	}
`;

/**
 * The planet's surface: the land in natural colours where the world is (rock and snow up the
 * mountains, shaded from the heights, with the minimap's own light and dark for texture),
 * otherwise sea (deep blue swells, turquoise in the shallows, ice towards the poles); lit by the
 * sun with a soft dusk at the edge of night, the clouds' shadows, the sea's glint, the
 * Maelstrom's red glow through its eye and the air's blue at the rim. Worked out in the planet's
 * own space; the world grid is unwrapped from the sphere as the Globe's dirOf does it.
 */
function surfaceMaterial(o: {
	land: THREE.Texture;
	biome: THREE.Texture;
	coast: THREE.Texture;
	relief: THREE.Texture;
	marks: THREE.Vector2;
	sea: THREE.Texture;
	rect: Rect;
	center: { x: number; y: number };
	scale: number;
	shared: Shared;
}): THREE.ShaderMaterial {
	const size = new THREE.Vector2(o.rect.maxX - o.rect.minX, o.rect.maxY - o.rect.minY);
	return new THREE.ShaderMaterial({
		uniforms: {
			...o.shared,
			landMap: { value: o.land },
			biomeMap: { value: o.biome },
			coastMap: { value: o.coast },
			reliefMap: { value: o.relief },
			seaMap: { value: o.sea },
			heightMarks: { value: o.marks },
			rectMin: { value: new THREE.Vector2(o.rect.minX, o.rect.minY) },
			rectSize: { value: size },
			center: { value: new THREE.Vector2(o.center.x, o.center.y) },
			scale: { value: o.scale },
			reliefTexel: { value: new THREE.Vector2(1 / (size.x * RELIEF_CELL), 1 / (size.y * RELIEF_CELL)) },
		},
		vertexShader: /* glsl */ `
			varying vec3 vObj;
			void main() {
				vObj = position;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform sampler2D landMap;
			uniform sampler2D biomeMap;
			uniform sampler2D coastMap;
			uniform sampler2D reliefMap;
			uniform sampler2D seaMap;
			uniform vec2 heightMarks;
			uniform vec2 rectMin;
			uniform vec2 rectSize;
			uniform vec2 center;
			uniform float scale;
			uniform vec2 reliefTexel;
			uniform vec3 sunObj;
			uniform vec3 camObj;
			varying vec3 vObj;
			const float PI = 3.14159265;
			${CLOUDS_GLSL}
			vec2 tileOf(vec3 p) {
				float r = acos(clamp(p.z, -1.0, 1.0));
				float l = length(p.xy);
				vec2 ab = l < 1e-6 ? vec2(0.0) : vec2(p.x, -p.y) * (r / l);
				return center + ab / scale;
			}
			vec3 dirOf(vec2 tile) {
				vec2 ab = (tile - center) * scale;
				float r = length(ab);
				if (r < 1e-6) return vec3(0.0, 0.0, 1.0);
				float k = sin(r) / r;
				return vec3(ab.x * k, -ab.y * k, cos(r));
			}
			float relief(vec2 uv) { return texture2D(reliefMap, vec2(uv.x, 1.0 - uv.y)).r; }
			float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
			void main() {
				vec3 p = normalize(vObj);
				vec2 tile = tileOf(p);
				vec2 uv = (tile - rectMin) / rectSize;
				float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
				vec2 tuv = vec2(uv.x, 1.0 - uv.y);
				vec4 mm = texture2D(landMap, tuv) * inside;
				// (Faint leftovers of the minimaps' sea don't count as land.)
				float landA = smoothstep(0.35, 0.75, mm.a);
				float coast = texture2D(coastMap, tuv).r * inside;

				// The sea: deep blue with slow swells, turquoise over the shallows.
				float swell = texture2D(seaMap, vec2(atan(p.z, -p.x) / (2.0 * PI) + 0.5, acos(clamp(p.y, -1.0, 1.0)) / PI)).r;
				vec3 sea = mix(vec3(0.001, 0.005, 0.025), vec3(0.002, 0.014, 0.06), swell);
				sea = mix(sea, vec3(0.006, 0.075, 0.12), smoothstep(0.1, 0.8, coast) * 0.85);
				// Ice towards the poles, ragged at its edge (over the sea).
				float ice = smoothstep(0.972, 0.982, abs(p.y) + (fbmN(p * 14.0, 3) - 0.5) * 0.05);
				sea = mix(sea, vec3(0.82, 0.86, 0.92), ice);

				// The land: its natural colour, with the minimap's light and dark for texture.
				vec3 ground = texture2D(biomeMap, tuv).rgb;
				vec4 soft = texture2D(landMap, tuv, 4.0);
				float softLum = lum(soft.rgb) / max(soft.a, 0.05);
				ground *= pow(clamp(lum(mm.rgb) / max(mm.a, 0.05) / max(softLum, 0.01), 0.45, 1.8), 0.55);
				ground *= 0.86 + 0.28 * fbmN(p * 320.0, 2);
				float h = relief(uv);
				float hx = relief(uv + vec2(reliefTexel.x, 0.0)) - relief(uv - vec2(reliefTexel.x, 0.0));
				float hy = relief(uv + vec2(0.0, reliefTexel.y)) - relief(uv - vec2(0.0, reliefTexel.y));
				float slope = length(vec2(hx, hy));
				// High ground and steep slopes: the trees broken by patches of bare rock. (Snow comes
				// only from the minimap's own colours, where the land really is snowy.)
				float patches = smoothstep(0.42, 0.6, fbmN(p * 220.0, 2));
				float rock = (smoothstep(heightMarks.x * 0.85, heightMarks.x * 1.25, h) * 0.55 + smoothstep(0.015, 0.05, slope) * 0.4) * (0.35 + 0.65 * patches);
				ground = mix(ground, vec3(0.15, 0.135, 0.115), clamp(rock, 0.0, 0.7));
				vec3 albedo = mix(sea, ground, landA);

				// Mountains: the heights' slope tips the normal, on land only.
				vec3 east = normalize(dirOf(tile + vec2(0.05, 0.0)) - dirOf(tile - vec2(0.05, 0.0)));
				vec3 south = normalize(dirOf(tile + vec2(0.0, 0.05)) - dirOf(tile - vec2(0.0, 0.05)));
				vec3 shaded = normalize(p - (east * hx + south * hy) * 14.0 * landA);

				vec3 v = normalize(camObj - p);
				float ndl = dot(shaded, sunObj);
				float geo = dot(p, sunObj);
				float day = smoothstep(-0.18, 0.28, geo);
				vec3 sunColor = mix(vec3(1.0, 0.55, 0.3), vec3(1.0, 0.97, 0.92), smoothstep(0.0, 0.35, geo));
				// The clouds' shadows, a little off towards the sun.
				float shadow = cloudDensity(normalize(p + sunObj * 0.012), 2);
				vec3 col = albedo * (vec3(0.012, 0.018, 0.04) + sunColor * max(ndl, 0.0) * 1.35 * day * (1.0 - 0.3 * shadow));
				// The sun's glint on open water.
				vec3 hv = normalize(sunObj + v);
				float glint = pow(max(dot(p, hv), 0.0), 300.0) * (0.5 + swell) * (1.0 - landA) * (1.0 - ice) * day;
				col += vec3(0.85, 0.85, 0.8) * glint * 0.2;
				// The Maelstrom's fiery eye, seen through the clear middle of its storm.
				if (stormRadius > 0.0) {
					float e = acos(clamp(dot(p, stormAxis), -1.0, 1.0)) / stormRadius;
					col += vec3(1.0, 0.22, 0.04) * (exp(-pow(e / 0.07, 2.0)) * 0.9 + exp(-pow(e / 0.2, 2.0)) * 0.12);
				}
				// The air seen edge-on: blue towards the rim on the day side.
				float rim = pow(1.0 - max(dot(p, v), 0.0), 3.0);
				col += vec3(0.18, 0.45, 1.0) * rim * 0.6 * smoothstep(-0.25, 0.5, geo);
				gl_FragColor = vec4(col, 1.0);
				#include <colorspace_fragment>
			}
		`,
	});
}

/** The clouds' layer: lit by the sun (warm at dusk, dark at night), thicker clouds brighter. */
function cloudMaterial(shared: Shared): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		uniforms: { ...shared },
		vertexShader: /* glsl */ `
			varying vec3 vObj;
			void main() {
				vObj = position;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform vec3 sunObj;
			varying vec3 vObj;
			${CLOUDS_GLSL}
			void main() {
				vec3 p = normalize(vObj);
				float density = cloudDensity(p, 5);
				if (density < 0.003) discard;
				float geo = dot(p, sunObj);
				float day = smoothstep(-0.15, 0.3, geo);
				vec3 sunColor = mix(vec3(1.0, 0.55, 0.3), vec3(1.0), smoothstep(0.0, 0.35, geo));
				vec3 col = vec3(0.012, 0.015, 0.03) + sunColor * day * (0.5 + 0.5 * density) * 0.95;
				gl_FragColor = vec4(col, density * 0.72);
				#include <colorspace_fragment>
			}
		`,
		transparent: true,
		depthWrite: false,
	});
}

/** The glow of the air round the planet: brightest towards the sun, fading off into space. */
function atmosphereHalo(): THREE.Mesh {
	const material = new THREE.ShaderMaterial({
		uniforms: { sunDir: { value: new THREE.Vector3(0, 0, 1) } },
		vertexShader: /* glsl */ `
			varying vec3 vNormal;
			varying vec3 vWorld;
			void main() {
				vec4 w = modelMatrix * vec4(position, 1.0);
				vNormal = normalize(mat3(modelMatrix) * normal);
				vWorld = w.xyz;
				gl_Position = projectionMatrix * viewMatrix * w;
			}
		`,
		fragmentShader: /* glsl */ `
			uniform vec3 sunDir;
			varying vec3 vNormal;
			varying vec3 vWorld;
			void main() {
				// Only round the planet, never over it: the surface has its own rim of air.
				vec3 ray = normalize(vWorld - cameraPosition);
				float along = -dot(cameraPosition, ray);
				float miss = length(cameraPosition + ray * along);
				if (miss < 1.0) discard;
				// Thickest where the line of sight just grazes the ground, thinning out into space.
				float glow = pow(1.0 - smoothstep(1.0, 1.1, miss), 2.5);
				float lit = 0.25 + 0.75 * smoothstep(-0.4, 0.6, dot(vNormal, sunDir));
				float a = glow * lit * 0.85;
				gl_FragColor = vec4(vec3(0.3, 0.62, 1.0) * a, a);
				#include <colorspace_fragment>
			}
		`,
		side: THREE.BackSide,
		transparent: true,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
	});
	return new THREE.Mesh(new THREE.SphereGeometry(1.1, 128, 64), material);
}

/** Space behind: a faint purple and blue nebula with a little green, as in the game's skies. */
function nebula(): THREE.Mesh {
	const w = 1024;
	const h = 512;
	const a = fbm(w, h, 6, 3, 31);
	const b = fbm(w, h, 5, 4, 43);
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(w, h);
	for (let i = 0; i < a.length; i++) {
		const cloud = THREE.MathUtils.smoothstep(a[i], 0.45, 0.85);
		const hue = b[i];
		img.data[i * 4] = 6 + cloud * (60 * hue + 20);
		img.data[i * 4 + 1] = 6 + cloud * (35 * (1 - hue) + 10);
		img.data[i * 4 + 2] = 14 + cloud * (90 * (1 - hue * 0.4));
		img.data[i * 4 + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
	return new THREE.Mesh(
		new THREE.SphereGeometry(300, 64, 32),
		new THREE.MeshBasicMaterial({ map: canvasTexture(canvas, true, true), side: THREE.BackSide, depthWrite: false }),
	);
}

function stars(): THREE.Points {
	const count = 4000;
	const positions = new Float32Array(count * 3);
	const colors = new Float32Array(count * 3);
	const tint = new THREE.Color();
	for (let i = 0; i < count; i++) {
		const v = new THREE.Vector3().randomDirection().multiplyScalar(200);
		positions.set([v.x, v.y, v.z], i * 3);
		tint.setHSL(0.55 + Math.random() * 0.2, 0.4, 0.6 + Math.random() * 0.4);
		colors.set([tint.r, tint.g, tint.b], i * 3);
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
	return new THREE.Points(geometry, new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
}

/** Value noise on a grid that wraps both ways, for pictures that wrap round the sphere. */
class PeriodicNoise {
	private readonly grids: Float32Array[] = [];
	private readonly sizes: number[] = [];

	constructor(cells: number, seed: number) {
		let rnd = seed * 9301 + 49297;
		const random = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
		for (let o = 0; o < 8; o++) {
			const n = cells << o;
			const grid = new Float32Array(n * n);
			for (let i = 0; i < grid.length; i++) grid[i] = random();
			this.grids.push(grid);
			this.sizes.push(n);
		}
	}

	/** u, v in 0..1 (wrapping); 0..1 out. */
	fbm(u: number, v: number, octaves: number): number {
		let sum = 0;
		let amp = 1;
		let total = 0;
		for (let o = 0; o < octaves; o++) {
			const n = this.sizes[o];
			const g = this.grids[o];
			const x = (((u % 1) + 1) % 1) * n;
			const y = (((v % 1) + 1) % 1) * n;
			const x0 = Math.floor(x);
			const y0 = Math.floor(y);
			const fx = x - x0;
			const fy = y - y0;
			const sx = fx * fx * (3 - 2 * fx);
			const sy = fy * fy * (3 - 2 * fy);
			const x1 = (x0 + 1) % n;
			const y1 = (y0 + 1) % n;
			const a = g[y0 * n + x0];
			const b = g[y0 * n + x1];
			const c = g[y1 * n + x0];
			const d = g[y1 * n + x1];
			sum += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
			total += amp;
			amp *= 0.5;
		}
		return sum / total;
	}
}

/** A w x h picture of wrapping fractal noise (0..1). */
function fbm(w: number, h: number, octaves: number, cells: number, seed: number): Float32Array {
	const noise = new PeriodicNoise(cells, seed);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = noise.fbm(x / w, y / h, octaves);
	return out;
}
