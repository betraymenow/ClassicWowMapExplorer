import * as THREE from 'three';
import type { AsyncStorageApi } from '../worker/protocol';
import type { ContinentPlacement } from './terrain';
import { TILE_SIZE } from '../formats/adt';
import { DAY } from './lighting';

/**
 * Azeroth as a planet: the continents' own minimap images wrapped round a globe, with clouds,
 * a glowing atmosphere, stars, the sun (from the time of day) and the Maelstrom between the
 * continents. Shown instead of the flat world when the camera climbs high enough or with O;
 * drag turns it, the wheel zooms, and zooming right in or double-clicking flies back down.
 */

/** How much of the globe's width the laid-out world takes (radians). */
const WORLD_SPAN = THREE.MathUtils.degToRad(120);
/** The base picture (equirectangular, 2:1). */
const TEX_WIDTH = 4096;
const TEX_HEIGHT = TEX_WIDTH / 2;
/** Pixels per tile read from the game (drawn scaled to the globe's own size). */
const CELL = 16;
const BATCH = 48;
const SEA_DEEP = '#0b2a52';
const SEA_SHALLOW = '#1b5a8c';
/** Camera distance from the centre, in globe radii. */
const DIST_MIN = 1.18;
const DIST_MAX = 4.5;
const DIST_START = 2.6;
/** Zooming in past this goes back down to the world. */
const DIST_EXIT = 1.22;
/** Map.db2 ID of the Maelstrom's own zone (retail). */
const MAELSTROM_MAP = 730;

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
	private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
	private readonly planet = new THREE.Group();
	private readonly clouds: THREE.Mesh;
	private readonly sun = new THREE.DirectionalLight(0xffffff, 2.6);
	private readonly sunGlow: THREE.Sprite;
	private readonly maelstrom = new THREE.Group();
	private readonly surface: THREE.Mesh;
	private readonly baseCanvas = document.createElement('canvas');
	private readonly baseTexture: THREE.CanvasTexture;
	private painting: Promise<void> | null = null;
	/** The view: which point of the globe faces the camera (spherical angles), and how far off. */
	private phi = Math.PI / 2;
	private theta = Math.PI / 2;
	private dist = DIST_START;
	private targetDist = DIST_START;
	private drag: { x: number; y: number } | null = null;
	private readonly world: Rect;
	private readonly scale: number;
	private readonly center: { x: number; y: number };

	constructor(
		private readonly element: HTMLElement,
		private readonly storage: AsyncStorageApi,
		private readonly continents: ContinentPlacement[],
		private readonly tilesOf: (c: ContinentPlacement) => [number, number][],
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
		this.scale = WORLD_SPAN / Math.max(rect.maxX - rect.minX, 1);

		this.scene.background = new THREE.Color(0x02030a);
		this.scene.add(this.planet, this.sun, new THREE.AmbientLight(0x4a5a7a, 0.9));
		this.scene.add(this.sun.target);
		this.scene.add(stars());

		this.baseCanvas.width = TEX_WIDTH;
		this.baseCanvas.height = TEX_HEIGHT;
		paintSea(this.baseCanvas);
		this.baseTexture = new THREE.CanvasTexture(this.baseCanvas);
		this.baseTexture.colorSpace = THREE.SRGBColorSpace;
		this.baseTexture.anisotropy = 8;
		this.surface = new THREE.Mesh(
			new THREE.SphereGeometry(1, 128, 64),
			new THREE.MeshPhongMaterial({ map: this.baseTexture, shininess: 18, specular: new THREE.Color(0x1a2a3a) }),
		);
		this.planet.add(this.surface);

		const cloudTexture = new THREE.CanvasTexture(cloudCanvas());
		cloudTexture.colorSpace = THREE.SRGBColorSpace;
		this.clouds = new THREE.Mesh(
			new THREE.SphereGeometry(1.012, 96, 48),
			new THREE.MeshLambertMaterial({ map: cloudTexture, transparent: true, depthWrite: false }),
		);
		this.planet.add(this.clouds);
		this.planet.add(atmosphere(1.0035, THREE.FrontSide, 2.6, 0.55));
		this.scene.add(atmosphere(1.09, THREE.BackSide, 5.0, 1.0));

		this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('255,250,235'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
		this.sunGlow.scale.setScalar(1.1);
		this.scene.add(this.sunGlow);

		this.buildMaelstrom();

		element.addEventListener('pointerdown', (e) => {
			if (!this.active || e.button !== 0) return;
			this.drag = { x: e.clientX, y: e.clientY };
		});
		window.addEventListener('pointermove', (e) => {
			if (!this.active || !this.drag) return;
			// Turn less the closer the camera, so the ground under the mouse keeps up.
			const k = 0.0045 * (this.dist - 1);
			this.phi -= (e.clientX - this.drag.x) * k;
			this.theta = THREE.MathUtils.clamp(this.theta - (e.clientY - this.drag.y) * k, 0.15, Math.PI - 0.15);
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

	/** Shows the globe turned to a point of the world (tile grid), starting close and pulling back. */
	/**
	 * Shows the globe with the place the world view was centred on facing the camera, from as
	 * high as the camera was (so the two views line up), then pulling back to see the planet
	 * unless it was already that high.
	 */
	enter(tileX: number, tileY: number, height: number): void {
		const { phi, theta } = this.anglesOf(tileX, tileY);
		this.phi = phi;
		this.theta = THREE.MathUtils.clamp(theta, 0.15, Math.PI - 0.15);
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
		this.leave(this.centerTile());
	}

	/** Leaves without going anywhere (another view takes over). */
	close(): void {
		this.active = false;
		this.drag = null;
	}

	update(dt: number, timeOfDay: number): void {
		this.dist += (this.targetDist - this.dist) * Math.min(1, dt * 5);
		if (this.dist < DIST_EXIT && this.targetDist <= DIST_MIN + 1e-6) {
			this.leaveAtCenter();
			return;
		}
		// Turned so the view's point faces the camera, on the +z axis.
		this.planet.rotation.set(Math.PI / 2 - this.theta, Math.PI / 2 - this.phi, 0, 'XYZ');
		this.clouds.rotation.y += dt * 0.004;
		this.camera.position.set(0, 0, this.dist);
		this.camera.lookAt(0, 0, 0);

		// The sun over the world's centre at noon, going round with the time of day.
		const sunPhi = Math.PI / 2 + Math.PI - (timeOfDay / DAY) * Math.PI * 2;
		const local = directionOf(sunPhi, Math.PI * 0.38);
		const dir = local.applyEuler(this.planet.rotation);
		this.sun.position.copy(dir).multiplyScalar(10);
		this.sunGlow.position.copy(dir).multiplyScalar(6);
		this.sunGlow.scale.setScalar(1.6);

		const spin = performance.now() / 1000;
		this.maelstrom.children[0].rotation.z = -spin * 0.6;
		this.maelstrom.children[1].rotation.z = -spin * 1.1;
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

	/** Spherical angles (three.js SphereGeometry's) of a point of the world's tile grid. */
	private anglesOf(tileX: number, tileY: number): { phi: number; theta: number } {
		return {
			phi: Math.PI / 2 + (tileX - this.center.x) * this.scale,
			theta: Math.PI / 2 + (tileY - this.center.y) * this.scale,
		};
	}

	private tileOf(phi: number, theta: number): GlobeExit {
		let p = phi - Math.PI / 2;
		p = Math.atan2(Math.sin(p), Math.cos(p));
		return { tileX: this.center.x + p / this.scale, tileY: this.center.y + (theta - Math.PI / 2) / this.scale, height: this.heightNow() };
	}

	private centerTile(): GlobeExit {
		return this.tileOf(this.phi, this.theta);
	}

	private pick(e: MouseEvent): GlobeExit | null {
		const rect = this.element.getBoundingClientRect();
		const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
		const ray = new THREE.Raycaster();
		ray.setFromCamera(ndc, this.camera);
		const hit = ray.intersectObject(this.surface)[0];
		if (!hit) return null;
		const p = this.surface.worldToLocal(hit.point.clone()).normalize();
		return this.tileOf(Math.atan2(p.z, -p.x), Math.acos(THREE.MathUtils.clamp(p.y, -1, 1)));
	}

	/** Pixel on the base picture of a point of the world's tile grid. */
	private pixelOf(tileX: number, tileY: number): { x: number; y: number } {
		const { phi, theta } = this.anglesOf(tileX, tileY);
		return { x: (phi / (Math.PI * 2)) * TEX_WIDTH, y: (theta / Math.PI) * TEX_HEIGHT };
	}

	/** The continents' minimap images, painted onto the globe as they're read. */
	private async paintWorld(): Promise<void> {
		const ctx = this.baseCanvas.getContext('2d')!;
		const tilePx = (this.scale / (Math.PI * 2)) * TEX_WIDTH;
		const scratch = document.createElement('canvas');
		scratch.width = scratch.height = CELL;
		const sctx = scratch.getContext('2d')!;
		ctx.imageSmoothingQuality = 'high';
		for (const c of this.continents) {
			const coords = this.tilesOf(c);
			for (let i = 0; i < coords.length; i += BATCH) {
				const thumbs = await this.storage.minimapThumbnails(c.wdt, coords.slice(i, i + BATCH), CELL).catch(() => []);
				for (const { x, y, image } of thumbs) {
					if (!image) continue;
					const rgba = new Uint8ClampedArray(image.rgba);
					clearWater(rgba);
					sctx.clearRect(0, 0, CELL, CELL);
					sctx.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
					const at = this.pixelOf(x + c.offsetX, y + c.offsetY);
					// A hair over a tile, so no seams show between neighbours.
					ctx.drawImage(scratch, 0, 0, image.width, image.height, at.x - 0.25, at.y - 0.25, tilePx + 0.5, tilePx + 0.5);
				}
				this.baseTexture.needsUpdate = true;
			}
		}
	}

	/** The Maelstrom: a red-glowing whirlpool in the sea between Kalimdor and the Eastern Kingdoms. */
	private buildMaelstrom(): void {
		const ek = this.continents.find((c) => c.mapId === 0);
		const kalimdor = this.continents.find((c) => c.mapId === 1);
		if (!ek || !kalimdor) return;
		const extent = (c: ContinentPlacement) => {
			const tiles = this.tilesOf(c);
			const xs = tiles.map((t) => t[0] + c.offsetX);
			const ys = tiles.map((t) => t[1] + c.offsetY);
			return { minX: Math.min(...xs), maxX: Math.max(...xs) + 1, midY: (Math.min(...ys) + Math.max(...ys) + 1) / 2 };
		};
		// On the Maelstrom's own map where it's laid out (retail), else midway between the continents.
		const zone = this.continents.find((c) => c.mapId === MAELSTROM_MAP);
		const [west, east] = [extent(kalimdor), extent(ek)].sort((a, b) => a.minX - b.minX);
		const at = zone
			? (() => {
				const tiles = this.tilesOf(zone);
				const xs = tiles.map((t) => t[0] + zone.offsetX);
				const ys = tiles.map((t) => t[1] + zone.offsetY);
				return { x: (Math.min(...xs) + Math.max(...xs) + 1) / 2, y: (Math.min(...ys) + Math.max(...ys) + 1) / 2 };
			})()
			: { x: (west.maxX + east.minX) / 2, y: (west.midY + east.midY) / 2 };
		const { phi, theta } = this.anglesOf(at.x, at.y);
		const normal = directionOf(phi, theta);
		const size = this.scale * 3.5;
		const swirl = new THREE.Mesh(
			new THREE.CircleGeometry(size, 48),
			new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(swirlCanvas()), transparent: true, depthWrite: false, opacity: 0.85 }),
		);
		const inner = new THREE.Mesh(
			new THREE.CircleGeometry(size * 0.55, 32),
			new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(swirlCanvas()), transparent: true, depthWrite: false, opacity: 0.7 }),
		);
		const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('255,70,20'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
		core.scale.setScalar(size * 0.5);
		this.maelstrom.add(swirl, inner, core);
		// Lying on the sphere, facing out.
		this.maelstrom.position.copy(normal).multiplyScalar(1.014);
		this.maelstrom.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
		core.position.set(0, 0, 0.002);
		inner.position.set(0, 0, 0.001);
		this.planet.add(this.maelstrom);
	}
}

/**
 * The minimap images draw the sea a dark blue-green; made see-through (fading in at the shore)
 * so the planet's own sea shows instead of dark squares round the coasts.
 */
function clearWater(rgba: Uint8ClampedArray): void {
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

/** The unit vector three.js's SphereGeometry puts at these angles (theta from the north pole). */
function directionOf(phi: number, theta: number): THREE.Vector3 {
	return new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
}

function paintSea(canvas: HTMLCanvasElement): void {
	const ctx = canvas.getContext('2d')!;
	const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
	g.addColorStop(0, '#d8e6f0');
	g.addColorStop(0.06, SEA_DEEP);
	g.addColorStop(0.5, SEA_SHALLOW);
	g.addColorStop(0.94, SEA_DEEP);
	g.addColorStop(1, '#d8e6f0');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	// Some depth to the open sea.
	const noise = valueNoise(256, 128, 6, 7);
	const tile = document.createElement('canvas');
	tile.width = 256;
	tile.height = 128;
	const t = tile.getContext('2d')!;
	const img = t.createImageData(256, 128);
	for (let i = 0; i < noise.length; i++) {
		const v = noise[i];
		img.data[i * 4] = 5;
		img.data[i * 4 + 1] = 20 + v * 40;
		img.data[i * 4 + 2] = 50 + v * 70;
		img.data[i * 4 + 3] = 90;
	}
	t.putImageData(img, 0, 0);
	ctx.globalAlpha = 0.6;
	ctx.drawImage(tile, 0, 0, canvas.width, canvas.height);
	ctx.globalAlpha = 1;
}

/** White clouds, wrapping round east-west, thinner near the land so it shows through. */
function cloudCanvas(): HTMLCanvasElement {
	const w = 1024;
	const h = 512;
	const noise = valueNoise(w, h, 8, 3);
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(w, h);
	for (let i = 0; i < noise.length; i++) {
		const a = THREE.MathUtils.smoothstep(noise[i], 0.52, 0.8);
		img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
		img.data[i * 4 + 3] = a * 210;
	}
	ctx.putImageData(img, 0, 0);
	return canvas;
}

/** Spiral arms for the Maelstrom, round and see-through at the edge. */
function swirlCanvas(): HTMLCanvasElement {
	const size = 256;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	ctx.translate(size / 2, size / 2);
	// Soft cloud arms winding in.
	for (let arm = 0; arm < 4; arm++) {
		for (let s = 0.05; s <= 1; s += 0.004) {
			const r = s * size * 0.47;
			const a = arm * (Math.PI / 2) + s * Math.PI * 2.4;
			ctx.fillStyle = `rgba(230,236,245,${0.05 + 0.08 * (1 - s)})`;
			ctx.beginPath();
			ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 3 + s * 9, 0, Math.PI * 2);
			ctx.fill();
		}
	}
	// Faded out towards the edge, so it melts into the sea.
	const edge = ctx.createRadialGradient(0, 0, size * 0.1, 0, 0, size / 2);
	edge.addColorStop(0, 'rgba(0,0,0,1)');
	edge.addColorStop(1, 'rgba(0,0,0,0)');
	ctx.globalCompositeOperation = 'destination-in';
	ctx.fillStyle = edge;
	ctx.fillRect(-size / 2, -size / 2, size, size);
	// The fiery eye.
	ctx.globalCompositeOperation = 'source-over';
	const eye = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.16);
	eye.addColorStop(0, 'rgba(255,120,40,1)');
	eye.addColorStop(0.5, 'rgba(200,40,20,0.7)');
	eye.addColorStop(1, 'rgba(80,10,10,0)');
	ctx.fillStyle = eye;
	ctx.fillRect(-size / 2, -size / 2, size, size);
	return canvas;
}

function glowTexture(rgb: string): THREE.CanvasTexture {
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
	g.addColorStop(0, `rgba(${rgb},1)`);
	g.addColorStop(0.2, `rgba(${rgb},0.6)`);
	g.addColorStop(1, `rgba(${rgb},0)`);
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);
	const t = new THREE.CanvasTexture(canvas);
	t.colorSpace = THREE.SRGBColorSpace;
	return t;
}

/** A blue glow strongest at the planet's edge: inside (front faces) and the halo outside (back faces). */
function atmosphere(radius: number, side: THREE.Side, power: number, strength: number): THREE.Mesh {
	const material = new THREE.ShaderMaterial({
		uniforms: { power: { value: power }, strength: { value: strength } },
		vertexShader: /* glsl */ `
			varying vec3 vNormal;
			varying vec3 vView;
			void main() {
				vec4 p = modelViewMatrix * vec4(position, 1.0);
				vNormal = normalize(normalMatrix * normal);
				vView = normalize(-p.xyz);
				gl_Position = projectionMatrix * p;
			}
		`,
		fragmentShader: /* glsl */ `
			uniform float power;
			uniform float strength;
			varying vec3 vNormal;
			varying vec3 vView;
			void main() {
				float rim = 1.0 - abs(dot(vNormal, vView));
				float a = pow(rim, power) * strength;
				gl_FragColor = vec4(vec3(0.35, 0.65, 1.0) * a, a);
			}
		`,
		side,
		transparent: true,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
	});
	return new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 48), material);
}

function stars(): THREE.Points {
	const count = 2500;
	const positions = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 40);
		positions.set([v.x, v.y, v.z], i * 3);
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 1.4, sizeAttenuation: false }));
}

/**
 * Fractal value noise in 0..1, wrapping east-west: `octaves` layers from `cells` cells across.
 */
function valueNoise(w: number, h: number, octaves: number, cells: number): Float32Array {
	const out = new Float32Array(w * h);
	let amp = 1;
	let total = 0;
	let rnd = 12345;
	const random = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	for (let o = 0; o < octaves; o++) {
		const cx = cells << o;
		const cy = Math.max(1, Math.round((cells << o) / 2));
		const grid = new Float32Array((cx + 1) * (cy + 1));
		for (let i = 0; i < grid.length; i++) grid[i] = random();
		for (let y = 0; y <= cy; y++) grid[y * (cx + 1) + cx] = grid[y * (cx + 1)];
		for (let y = 0; y < h; y++) {
			const gy = (y / h) * cy;
			const y0 = Math.floor(gy);
			const fy = THREE.MathUtils.smoothstep(gy - y0, 0, 1);
			for (let x = 0; x < w; x++) {
				const gx = (x / w) * cx;
				const x0 = Math.floor(gx);
				const fx = THREE.MathUtils.smoothstep(gx - x0, 0, 1);
				const a = grid[y0 * (cx + 1) + x0];
				const b = grid[y0 * (cx + 1) + x0 + 1];
				const c = grid[Math.min(y0 + 1, cy) * (cx + 1) + x0];
				const d = grid[Math.min(y0 + 1, cy) * (cx + 1) + x0 + 1];
				out[y * w + x] += amp * (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy);
			}
		}
		total += amp;
		amp *= 0.5;
	}
	for (let i = 0; i < out.length; i++) out[i] /= total;
	return out;
}
