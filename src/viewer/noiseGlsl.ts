/**
 * GLSL value noise in 3D, for shaders that paint without textures (the planet's clouds, Argus):
 * vnoise (0..1, smooth) and fbmN (its sum over octaves, 0..1, at most 8), on positions over a
 * sphere so there are no seams.
 */
export const NOISE_GLSL = /* glsl */ `
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
`;
