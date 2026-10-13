import * as THREE from 'three';
import type { ModelMaterial } from '../explorer/objects';
import { liquidTime } from './terrainMaterials';
import { Blend } from '../formats/m2';
import { setNoShadow } from './shadows';
import { applyTerrainShadow } from './terrainShadow';

/**
 * Colours for models whose look comes from their colour animations, which aren't read: drawn
 * white without them. The Sword of Sargeras' energy is red in the game.
 */
const MODEL_TINTS = new Map<number, number>([[1782994, 0xff2a12]]);

/** Tints a model's materials as MODEL_TINTS says (by the model's file ID); no change for others. */
export function tintModel(fdid: number, materials: THREE.Material[]): void {
	const tint = MODEL_TINTS.get(fdid);
	if (tint === undefined) return;
	for (const m of materials) if ('color' in m && m.color instanceof THREE.Color) m.color.multiply(new THREE.Color(tint));
}

/** Shared uniforms for a skinned model: its bone texture and loop. */
export interface SkinUniforms {
	uBoneTex: THREE.IUniform<THREE.Texture>;
	/** Instanced models: Stand and Walk, as first frame row, frame count, loop length (s). */
	uClips?: THREE.IUniform<THREE.Vector3[]>;
	/**
	 * A single model posed from outside (the walking character): two poses, each the two frame
	 * rows it falls between and how far between them, mixed by uPoseMix (0 all A, 1 all B).
	 */
	uPoseA?: THREE.IUniform<THREE.Vector3>;
	uPoseB?: THREE.IUniform<THREE.Vector3>;
	uPoseMix?: THREE.IUniform<number>;
}

/**
 * A material for one M2 or WMO batch, following the file's blend mode and flags. baked: the
 * geometry has a 'baked' attribute (WMO interior lighting), see applyBakedLighting. skin: the
 * model is animated on the GPU (see applyModelAnimation).
 */
export function createModelMaterial(m: ModelMaterial, texture: THREE.Texture | null, baked: boolean, skin: SkinUniforms | null = null): THREE.Material {
	// Collision-only triangles are never drawn, but still ray-cast (ray casts don't look at visible).
	if (m.collision) return new THREE.MeshBasicMaterial({ visible: false });
	const params: THREE.MeshLambertMaterialParameters = {
		map: texture,
		color: texture ? 0xffffff : 0x8a8a80,
		side: m.twoSided ? THREE.DoubleSide : THREE.FrontSide,
		fog: !m.unfogged,
		opacity: m.opacity,
		transparent: m.opacity < 1,
	};
	const material = m.unlit ? new THREE.MeshBasicMaterial(params) : new THREE.MeshLambertMaterial(params);
	if (baked && material instanceof THREE.MeshLambertMaterial) applyBakedLighting(material);
	else if (skin || m.uvScroll) applyModelAnimation(material, skin, m.uvScroll ?? null);

	switch (m.blend) {
		case Blend.Opaque:
			break;
		case Blend.AlphaKey:
			material.alphaTest = 0.5;
			break;
		case Blend.Alpha:
			material.transparent = true;
			material.depthWrite = false;
			break;
		case Blend.NoAlphaAdd:
		case Blend.Add:
		case Blend.BlendAdd:
			material.transparent = true;
			material.depthWrite = false;
			material.blending = THREE.AdditiveBlending;
			break;
		case Blend.Mod:
		case Blend.Mod2x:
			material.transparent = true;
			material.depthWrite = false;
			material.blending = THREE.CustomBlending;
			material.blendSrc = THREE.DstColorFactor;
			material.blendDst = m.blend === Blend.Mod2x ? THREE.SrcColorFactor : THREE.ZeroFactor;
			break;
	}
	if (material.transparent || m.unlit) setNoShadow(material);
	if (material instanceof THREE.MeshLambertMaterial) applyTerrainShadow(material);
	return material;
}

// Point lights (the torch) are summed first in lights_fragment_begin; snapshot them before the
// spot and directional lights are added, so interiors can keep the torch but drop the sun.
const LIGHTS_BEGIN_WITH_TORCH = THREE.ShaderChunk.lights_fragment_begin.replace(
	'#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )',
	'vec3 torchDirect = reflectedLight.directDiffuse;\n#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )',
);

/**
 * WMO interiors are lit by baked vertex colours, not the sun: per vertex, baked.a blends from
 * normal lighting (0) to baked.rgb as the ambient light plus only the torch as direct light (1).
 */
function applyBakedLighting(material: THREE.MeshLambertMaterial): void {
	material.onBeforeCompile = (shader) => {
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nattribute vec4 baked;\nvarying vec4 vBaked;')
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBaked = baked;');
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', '#include <common>\nvarying vec4 vBaked;')
			.replace('#include <lights_fragment_begin>', LIGHTS_BEGIN_WITH_TORCH)
			.replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
				reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse, torchDirect, vBaked.a);
				reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, diffuseColor.rgb * vBaked.rgb, vBaked.a);`);
	};
	material.customProgramCacheKey = () => 'wmo-baked';
}

const SKIN_VERTEX_PARS = /* glsl */ `
uniform float uTime;
#ifdef M2_SKINNED
	attribute vec4 boneIndex;
	attribute vec4 boneWeight;
	uniform sampler2D uBoneTex;
	#ifdef M2_POSED
		uniform vec3 uPoseA;
		uniform vec3 uPoseB;
		uniform float uPoseMix;
	#else
		attribute float instancePhase;
		/** 0 standing, 1 walking. */
		attribute float instanceAnim;
		uniform vec3 uClips[2];
	#endif
	mat4 animSkin;
	// Row-major 3x4 bone matrix: three texels per bone, one row of texels per frame.
	mat4 boneFrame(int bone, int frame) {
		vec4 r0 = texelFetch(uBoneTex, ivec2(bone * 3, frame), 0);
		vec4 r1 = texelFetch(uBoneTex, ivec2(bone * 3 + 1, frame), 0);
		vec4 r2 = texelFetch(uBoneTex, ivec2(bone * 3 + 2, frame), 0);
		return mat4(vec4(r0.x, r1.x, r2.x, 0.0), vec4(r0.y, r1.y, r2.y, 0.0), vec4(r0.z, r1.z, r2.z, 0.0), vec4(r0.w, r1.w, r2.w, 1.0));
	}
	// GLSL's mix has no matrix form.
	mat4 mixBones(mat4 a, mat4 b, float t) {
		return a * (1.0 - t) + b * t;
	}
#endif
#ifdef M2_UV_SCROLL
	uniform vec2 uUvScroll;
#endif
`;

// Blends the bones for this vertex at this instance's point in the loop. Runs first thing in main():
// three's skin chunks sit inside #ifs in some materials (MeshBasic), so they can't host it.
const SKIN_BASE = /* glsl */ `
#if defined( M2_SKINNED ) && defined( M2_POSED )
	animSkin = mat4(0.0);
	float weightSum = 0.0;
	for (int k = 0; k < 4; k++) {
		float w = boneWeight[k];
		if (w <= 0.0) continue;
		int bone = int(boneIndex[k]);
		mat4 pose = mixBones(boneFrame(bone, int(uPoseA.x)), boneFrame(bone, int(uPoseA.y)), uPoseA.z);
		if (uPoseMix > 0.0) pose = mixBones(pose, mixBones(boneFrame(bone, int(uPoseB.x)), boneFrame(bone, int(uPoseB.y)), uPoseB.z), uPoseMix);
		animSkin += w * pose;
		weightSum += w;
	}
	animSkin = weightSum > 0.001 ? animSkin * (1.0 / weightSum) : mat4(1.0);
#elif defined( M2_SKINNED )
	vec3 clip = instanceAnim > 0.5 ? uClips[1] : uClips[0];
	float animFrame = fract((uTime + instancePhase) / clip.z) * clip.y;
	int frameIndex = int(floor(animFrame));
	int frame0 = int(clip.x) + frameIndex;
	int frame1 = int(clip.x) + (frameIndex + 1 >= int(clip.y) ? 0 : frameIndex + 1);
	float frameMix = animFrame - floor(animFrame);
	animSkin = mat4(0.0);
	float weightSum = 0.0;
	for (int k = 0; k < 4; k++) {
		float w = boneWeight[k];
		if (w <= 0.0) continue;
		int bone = int(boneIndex[k]);
		animSkin += w * ((1.0 - frameMix) * boneFrame(bone, frame0) + frameMix * boneFrame(bone, frame1));
		weightSum += w;
	}
	animSkin = weightSum > 0.001 ? animSkin * (1.0 / weightSum) : mat4(1.0);
#endif
`;

/** What the sun's shadow pass draws a GPU-skinned model with, so its shadow moves with it. */
export function createSkinnedDepthMaterial(skin: SkinUniforms): THREE.MeshDepthMaterial {
	const material = new THREE.MeshDepthMaterial();
	applyModelAnimation(material, skin, null);
	return material;
}

/**
 * Animates an M2 batch on the GPU: bone skinning from the model's sampled Stand loop (each
 * instance offset by its own phase so copies don't move in step), and steady texture scrolling.
 */
function applyModelAnimation(material: THREE.MeshLambertMaterial | THREE.MeshBasicMaterial | THREE.MeshDepthMaterial, skin: SkinUniforms | null, uvScroll: [number, number] | null): void {
	const posed = !!skin?.uPoseA;
	material.defines = { ...(material.defines ?? {}), ...(skin ? { M2_SKINNED: '' } : {}), ...(posed ? { M2_POSED: '' } : {}), ...(uvScroll ? { M2_UV_SCROLL: '' } : {}) };
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, { uTime: liquidTime, uUvScroll: { value: new THREE.Vector2(...(uvScroll ?? [0, 0])) } }, skin ?? {});
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', `#include <common>\n${SKIN_VERTEX_PARS}`)
			.replace('void main() {', `void main() {\n${SKIN_BASE}`)
			.replace('#include <skinnormal_vertex>', '#ifdef M2_SKINNED\n\tobjectNormal = mat3(animSkin) * objectNormal;\n#endif')
			.replace('#include <skinning_vertex>', '#ifdef M2_SKINNED\n\ttransformed = (animSkin * vec4(transformed, 1.0)).xyz;\n#endif')
			.replace('#include <uv_vertex>', '#include <uv_vertex>\n#if defined( M2_UV_SCROLL ) && defined( USE_MAP )\n\tvMapUv += uUvScroll * uTime;\n#endif');
	};
	material.customProgramCacheKey = () => `m2-anim-${material.type}-${skin ? 1 : 0}-${posed ? 1 : 0}-${uvScroll ? 1 : 0}`;

}
