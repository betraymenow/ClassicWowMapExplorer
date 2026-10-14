import * as THREE from 'three';
import { NOISE_GLSL } from './noiseGlsl';

/**
 * Argus, the Legion's world, as it hung over Azeroth (Legion 7.3; retail only): a sphere of
 * purple-grey rock split by glowing fel cracks, a molten wound on one side, wreathed in green and
 * teal fel flame, with shattered debris drifting off by the wound. Painted in shaders (no game
 * model shows it in Azeroth's skies), and used twice: in the world's sky (see placeInSky) and out
 * in space in the planet view.
 *
 * In the sky it's drawn just after the sky dome and before everything else, writing no depth: the
 * land and buildings always cover it, and the post-process fog takes it for sky.
 */

/** Where it hangs in the world's sky: east-south-east, about a third of the way up (x east, y up, z south). */
export const ARGUS_SKY_DIRECTION = new THREE.Vector3(0.62, 0.55, 0.56).normalize();
/** How wide it looks in the sky (radians across). */
export const ARGUS_SKY_SIZE = THREE.MathUtils.degToRad(20);
/** How far off it's drawn in the sky (yards): inside the camera's reach; with no depth written, any distance works. */
const SKY_DISTANCE = 8000;
/** Its wound faces this way in its own space (towards the lower left, as seen from Azeroth). */
const WOUND = new THREE.Vector3(-0.45, -0.35, 0.82).normalize();
const DEBRIS = 46;

export class Argus {
	readonly group = new THREE.Group();
	private readonly body: THREE.Mesh;
	private readonly corona: THREE.Mesh;
	private readonly uniforms = {
		uTime: { value: 0 },
		uSunDir: { value: new THREE.Vector3(0, 1, 0) },
	};

	/** sky: drawn in the world's sky (see the class notes); otherwise an ordinary object in space. */
	constructor(sky: boolean) {
		const order = (o: THREE.Object3D, n: number, m: THREE.Material) => {
			if (sky) {
				o.renderOrder = n;
				m.depthWrite = false;
				m.depthTest = false;
			}
			o.frustumCulled = !sky;
		};

		this.body = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), bodyMaterial(this.uniforms));
		order(this.body, -998, this.body.material as THREE.Material);

		// The flames round its edge: a disc always facing the camera (see update), larger than the planet.
		this.corona = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), coronaMaterial(this.uniforms));
		order(this.corona, -999, this.corona.material as THREE.Material);
		// In space, after the background (the nebula would paint over it, as it writes no depth).
		if (!sky) (this.corona.material as THREE.Material).transparent = true;

		// Shards drifting off from the wound, on the side towards Azeroth so they're in front of it.
		const debrisMaterial = new THREE.MeshLambertMaterial({ color: 0x2c3530, emissive: 0x0c2a10 });
		const debris = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), debrisMaterial, DEBRIS);
		order(debris, -997, debrisMaterial);
		const across = new THREE.Vector3().crossVectors(WOUND, new THREE.Vector3(0, 1, 0)).normalize();
		const along = new THREE.Vector3().crossVectors(across, WOUND).normalize();
		const m = new THREE.Matrix4();
		const q = new THREE.Quaternion();
		let seed = 7;
		const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		for (let i = 0; i < DEBRIS; i++) {
			const out = 1.02 + rnd() ** 1.5 * 0.55;
			const at = WOUND.clone().multiplyScalar(out)
				.addScaledVector(across, (rnd() - 0.5) * 0.9)
				.addScaledVector(along, (rnd() - 0.7) * 0.7);
			const size = 0.012 + rnd() ** 2 * 0.07;
			q.setFromEuler(new THREE.Euler(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3));
			m.compose(at, q, new THREE.Vector3(size * (0.6 + rnd()), size * (0.3 + rnd() * 0.5), size * (0.8 + rnd())));
			debris.setMatrixAt(i, m);
		}
		this.group.add(this.corona, this.body, debris);
		this.group.visible = true;
	}

	/** Each frame: the time (s) for its fel glow and turning, the sun's direction (world), and the camera (for the flames). */
	update(time: number, sunDir: THREE.Vector3, camera: THREE.Camera): void {
		this.uniforms.uTime.value = time;
		this.uniforms.uSunDir.value.copy(sunDir);
		// The flames' disc faces the camera, whatever the group is turned to.
		this.group.updateWorldMatrix(true, false);
		const parent = new THREE.Quaternion();
		this.group.getWorldQuaternion(parent);
		this.corona.quaternion.copy(parent.invert().multiply(camera.quaternion));
	}

	/** Hangs it in the world's sky as seen from the camera at `from` (see ARGUS_SKY_DIRECTION), its wound towards it. */
	placeInSky(from: THREE.Vector3): void {
		this.group.position.copy(from).addScaledVector(ARGUS_SKY_DIRECTION, SKY_DISTANCE);
		this.group.scale.setScalar(SKY_DISTANCE * Math.tan(ARGUS_SKY_SIZE / 2));
		this.group.lookAt(from);
	}
}

function bodyMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		uniforms,
		vertexShader: /* glsl */ `
			varying vec3 vObj;
			varying vec3 vNormalW;
			varying vec3 vViewW;
			void main() {
				vObj = position;
				vec4 w = modelMatrix * vec4(position, 1.0);
				vNormalW = normalize(mat3(modelMatrix) * normal);
				vViewW = cameraPosition - w.xyz;
				gl_Position = projectionMatrix * viewMatrix * w;
			}
		`,
		fragmentShader: /* glsl */ `
			uniform float uTime;
			uniform vec3 uSunDir;
			varying vec3 vObj;
			varying vec3 vNormalW;
			varying vec3 vViewW;
			${NOISE_GLSL}
			void main() {
				vec3 p = normalize(vObj);
				// Purple-grey rock, mottled, with darker basins.
				float n = fbmN(p * 3.0, 5);
				float basins = fbmN(p * 9.0 + 3.1, 4);
				vec3 rock = mix(vec3(0.03, 0.025, 0.06), vec3(0.12, 0.10, 0.17), n);
				rock = mix(rock, vec3(0.015, 0.012, 0.03), smoothstep(0.55, 0.75, basins) * 0.7);

				// Fel cracks: the ridges of a noise, strongest where the fel has taken hold.
				float ridge = 1.0 - abs(fbmN(p * 5.0 + 7.0, 4) * 2.0 - 1.0);
				float cracks = smoothstep(0.935, 0.985, ridge);
				float fel = smoothstep(0.42, 0.62, fbmN(p * 1.6 + 11.0, 3));
				float pulse = 0.8 + 0.2 * sin(uTime * 1.3 + n * 12.0);
				vec3 felColor = mix(vec3(0.25, 1.0, 0.1), vec3(0.95, 1.0, 0.15), smoothstep(0.4, 0.7, fbmN(p * 7.0, 2)));
				vec3 glow = felColor * cracks * (0.08 + 1.4 * fel) * pulse;
				// Specks and pools of fel, thickest where the fel has taken hold.
				float pools = smoothstep(0.7, 0.8, fbmN(p * 14.0 + 5.0, 2));
				glow += vec3(0.35, 1.0, 0.12) * pools * (0.15 + fel) * 0.9;

				// The molten wound, burning orange and yellow.
				vec3 wound = normalize(vec3(-0.45, -0.35, 0.82));
				float w = smoothstep(0.86, 0.97, dot(p, wound) + (fbmN(p * 4.0 + 2.0, 3) - 0.5) * 0.3);
				// Swirling, with darker streaks of rock through it.
				float swirl = fbmN(p * 6.0 + vec3(0.0, 0.0, uTime * 0.04), 4);
				vec3 molten = mix(vec3(0.8, 0.18, 0.01), vec3(1.0, 0.62, 0.08), smoothstep(0.35, 0.75, swirl));
				glow += molten * w * (0.45 + 0.75 * smoothstep(0.3, 0.6, swirl));
				rock *= 1.0 - w * 0.7;

				// Lit by the sun, never quite dark (the fel lights it from within).
				vec3 nW = normalize(vNormalW);
				float lit = max(dot(nW, uSunDir), 0.0);
				vec3 col = rock * (0.35 + 1.2 * lit) + glow;
				// Green and teal fel light round its edge.
				float rim = pow(1.0 - max(dot(nW, normalize(vViewW)), 0.0), 4.0);
				col += mix(vec3(0.25, 1.0, 0.3), vec3(0.15, 0.75, 0.85), smoothstep(-0.4, 0.4, dot(p, vec3(0.6, -0.5, 0.6)))) * rim * 0.7;
				gl_FragColor = vec4(col, 1.0);
				#include <colorspace_fragment>
			}
		`,
	});
}

/** The fel flames round its edge, on a disc facing the camera (radius 1 = the planet's edge). */
function coronaMaterial(uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		uniforms,
		vertexShader: /* glsl */ `
			varying vec2 vXy;
			void main() {
				vXy = position.xy;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform float uTime;
			varying vec2 vXy;
			${NOISE_GLSL}
			void main() {
				float r = length(vXy);
				if (r < 0.96 || r > 1.7) discard;
				float a = atan(vXy.y, vXy.x);
				// Flames licking outwards, rising and changing as they go.
				float flames = fbmN(vec3(cos(a) * 3.0, sin(a) * 3.0, r * 3.5 - uTime * 0.3), 4);
				float wisps = fbmN(vec3(cos(a) * 9.0, sin(a) * 9.0, r * 6.0 - uTime * 0.5), 3);
				// Longest over the top and right, as in the game.
				float side = 0.55 + 0.6 * smoothstep(-0.5, 0.9, sin(a - 0.3));
				float reach = 1.0 - smoothstep(1.0, 1.0 + 0.9 * flames * side, r);
				float glow = exp(-(r - 1.0) * 7.0) * 0.8;
				float alpha = clamp(reach * smoothstep(0.3, 0.65, flames) * (0.5 + wisps) + glow, 0.0, 1.0);
				// Greener over the top, teal down the right, as in the game.
				vec3 color = mix(vec3(0.35, 1.0, 0.2), vec3(0.15, 0.8, 0.9), smoothstep(-0.6, 0.6, sin(a - 0.6)));
				gl_FragColor = vec4(color * alpha, alpha);
				#include <colorspace_fragment>
			}
		`,
		blending: THREE.AdditiveBlending,
		depthWrite: false,
		side: THREE.DoubleSide,
	});
}
