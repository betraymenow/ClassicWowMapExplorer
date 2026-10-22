import { compose, fromQuaternion, multiply, scaling, translation, type Mat4 } from '../explorer/mat4';

const BONE_SIZE = 88;
const SEQUENCE_SIZE = 64;
/** AnimationData IDs. */
const ANIM_STAND = 0;
const ANIM_WALK = 4;

/** AnimationData IDs the walking character plays (see viewer/character.ts). */
export const ANIM = {
	Stand: 0,
	Walk: 4,
	Run: 5,
	ShuffleLeft: 11,
	ShuffleRight: 12,
	Walkbackwards: 13,
	JumpStart: 37,
	Jump: 38,
	JumpEnd: 39,
	Fall: 40,
	SwimIdle: 41,
	Swim: 42,
	SwimLeft: 43,
	SwimRight: 44,
	SwimBackwards: 45,
	/**
	 * Swimming upward: unnamed in AnimationData, but it falls back to Swim and holds the body
	 * tilted up (about 65 degrees, against Swim's 30). Race models have no swimming-down one.
	 */
	SwimUp: 524,
} as const;
/** Sequence flags: its keys are in this file (not a separate .anim), and it stands for another (aliasNext). */
const SEQUENCE_EMBEDDED = 0x20;
const SEQUENCE_ALIAS = 0x40;

/** M2CompQuat: int16 components mapped to [-1, 1]. */
const compQuat = (v: number) => (v < 0 ? v + 32768 : v - 32767) / 32767;

/** One of a model's sequences (Stand, Walk): where its bone tracks are, and how long it loops. */
interface StandSequence {
	view: DataView;
	md20: number;
	seq: number;
	duration: number;
	boneCount: number;
	boneOffset: number;
	/** Durations (ms) of the model's global sequences, for tracks that loop on their own. */
	globalLoops: number[];
	/** Ground speed the sequence was made for (yd/s; 0 for those that don't move). */
	speed: number;
}

function findStand(bytes: Uint8Array, md20: number, animation = ANIM_STAND): StandSequence | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => view.getUint32(md20 + o, true);
	const boneCount = u32(0x2c);
	if (!boneCount) return null;
	const seqCount = u32(0x1c);
	const seqOffset = u32(0x20);
	for (let i = 0; i < seqCount; i++) {
		const o = md20 + seqOffset + i * SEQUENCE_SIZE;
		// Flag 0x20: the sequence's keys are in this file rather than a separate .anim.
		if (view.getUint16(o, true) !== animation || view.getUint16(o + 2, true) !== 0) continue;
		// An alias plays another sequence of the model; follow it to one with keys of its own.
		let seq = i;
		for (let hops = 0; hops < 8 && view.getUint32(md20 + seqOffset + seq * SEQUENCE_SIZE + 12, true) & SEQUENCE_ALIAS; hops++) {
			const next = view.getUint16(md20 + seqOffset + seq * SEQUENCE_SIZE + 60, true);
			if (next >= seqCount) break;
			seq = next;
		}
		const s = md20 + seqOffset + seq * SEQUENCE_SIZE;
		if (!(view.getUint32(s + 12, true) & SEQUENCE_EMBEDDED)) continue;
		const loops = Array.from({ length: u32(0x14) }, (_, k) => view.getUint32(md20 + u32(0x18) + k * 4, true));
		return { view, md20, seq, duration: view.getUint32(s + 4, true), boneCount, boneOffset: u32(0x30), globalLoops: loops, speed: view.getFloat32(s + 8, true) };
	}
	return null;
}

/**
 * A track's value at time t (ms) in the Stand sequence (or its own global sequence), linearly
 * interpolated between keys. read(offset) decodes one value; lerp mixes two.
 */
function sampleTrack<T>(s: StandSequence, track: number, t: number, size: number, read: (o: number) => T, lerp: (a: T, b: T, f: number) => T): T | null {
	const { view, md20 } = s;
	const globalSeq = view.getInt16(track + 2, true);
	const index = globalSeq >= 0 ? 0 : s.seq;
	const times = view.getUint32(track + 4, true);
	const values = view.getUint32(track + 12, true);
	if (index >= values || index >= times) return null;
	const timeArr = md20 + view.getUint32(track + 8, true) + index * 8;
	const valueArr = md20 + view.getUint32(track + 16, true) + index * 8;
	const count = Math.min(view.getUint32(timeArr, true), view.getUint32(valueArr, true));
	if (!count) return null;
	const timeAt = (k: number) => view.getUint32(md20 + view.getUint32(timeArr + 4, true) + k * 4, true);
	const valueAt = (k: number) => read(md20 + view.getUint32(valueArr + 4, true) + k * size);
	if (count === 1) return valueAt(0);
	if (globalSeq >= 0) {
		const loop = s.globalLoops[globalSeq] || timeAt(count - 1) || 1;
		t %= loop;
	}
	if (t <= timeAt(0)) return valueAt(0);
	for (let k = 0; k < count - 1; k++) {
		const t0 = timeAt(k);
		const t1 = timeAt(k + 1);
		if (t < t1) return lerp(valueAt(k), valueAt(k + 1), t1 > t0 ? (t - t0) / (t1 - t0) : 0);
	}
	return valueAt(count - 1);
}

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
const lerp3 = (a: Vec3, b: Vec3, f: number): Vec3 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
/** Normalised lerp, taking the short way round. */
const nlerp = (a: Quat, b: Quat, f: number): Quat => {
	const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
	const q = a.map((v, i) => v + (b[i] * sign - v) * f) as Quat;
	const len = Math.hypot(...q) || 1;
	return q.map((v) => v / len) as Quat;
};

/** Bone matrices (bind space -> posed model space) at time t (ms) of the Stand sequence. */
function poseAt(s: StandSequence, t: number): Mat4[] {
	const { view } = s;
	const f = (at: number) => view.getFloat32(at, true);
	const readVec = (o: number): Vec3 => [f(o), f(o + 4), f(o + 8)];
	const readQuat = (o: number): Quat => [0, 2, 4, 6].map((k) => compQuat(view.getInt16(o + k, true))) as Quat;

	const local: Mat4[] = [];
	const parents: number[] = [];
	for (let b = 0; b < s.boneCount; b++) {
		const o = s.md20 + s.boneOffset + b * BONE_SIZE;
		parents.push(view.getInt16(o + 8, true));
		const pivot = readVec(o + 76);
		const tr = sampleTrack(s, o + 16, t, 12, readVec, lerp3);
		const rot = sampleTrack(s, o + 36, t, 8, readQuat, nlerp);
		const sc = sampleTrack(s, o + 56, t, 12, readVec, lerp3);
		const parts: Mat4[] = [translation(...pivot)];
		if (tr) parts.push(translation(...tr));
		if (rot) {
			const len = Math.hypot(...rot) || 1;
			parts.push(fromQuaternion(rot[0] / len, rot[1] / len, rot[2] / len, rot[3] / len));
		}
		if (sc) {
			const m = scaling(1);
			m[0] = sc[0]; m[5] = sc[1]; m[10] = sc[2];
			parts.push(m);
		}
		parts.push(translation(-pivot[0], -pivot[1], -pivot[2]));
		local.push(compose(...parts));
	}

	const global: (Mat4 | null)[] = new Array(s.boneCount).fill(null);
	const resolve = (b: number, depth = 0): Mat4 => {
		const cached = global[b];
		if (cached) return cached;
		const p = parents[b];
		const m = p >= 0 && p < s.boneCount && p !== b && depth < 256 ? multiply(resolve(p, depth + 1), local[b]) : local[b];
		global[b] = m;
		return m;
	};
	return local.map((_, b) => resolve(b));
}

/**
 * Bone matrices for the first frame of the model's Stand animation, so models can be drawn
 * standing instead of in their bind pose. Returns null if the model has no embedded Stand.
 */
export function standPose(bytes: Uint8Array, md20: number): Mat4[] | null {
	const s = findStand(bytes, md20);
	return s ? poseAt(s, 0) : null;
}

/** Bone matrices sampled over the Stand loop (duration in seconds), or null without a Stand. */
export function standPoses(bytes: Uint8Array, md20: number): { duration: number; poses: Mat4[][] } | null {
	const s = findStand(bytes, md20);
	if (!s || s.duration < 50) return null;
	const frames = Math.max(2, Math.min(MAX_FRAMES, Math.round((s.duration / 1000) * SAMPLES_PER_SECOND)));
	return { duration: s.duration / 1000, poses: Array.from({ length: frames }, (_, f) => poseAt(s, (f / frames) * s.duration)) };
}

/** A loop within the sampled frames: its first frame row, frame count and length in seconds. */
export interface AnimationClip {
	row: number;
	frames: number;
	duration: number;
	/** For a list of sequences (sequenceAnimation): its AnimationData ID, and the ground speed it was made for. */
	id?: number;
	speed?: number;
	/** When a foot comes down in the loop (seconds), from the model's footstep events. */
	steps?: number[];
}

const EVENT_SIZE = 36;
/** The M2 event a model marks each footfall with in its walking and running sequences. */
const FOOTSTEP_EVENT = '$FSD';

/**
 * When a foot comes down in a sequence (seconds), from the model's $FSD events: each event has a
 * list of times per sequence. Empty when the model marks none.
 */
function footsteps(s: StandSequence): number[] {
	const { view, md20 } = s;
	const count = view.getUint32(md20 + 0x100, true);
	const offset = view.getUint32(md20 + 0x104, true);
	const out: number[] = [];
	for (let i = 0; i < count; i++) {
		const o = md20 + offset + i * EVENT_SIZE;
		const id = String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
		if (id !== FOOTSTEP_EVENT) continue;
		// The event's enabled track: interpolation, global sequence, then times per sequence.
		const sequences = view.getUint32(o + 28, true);
		if (s.seq >= sequences) continue;
		const list = md20 + view.getUint32(o + 32, true) + s.seq * 8;
		const n = view.getUint32(list, true);
		const times = md20 + view.getUint32(list + 4, true);
		for (let k = 0; k < n; k++) out.push(view.getUint32(times + k * 4, true) / 1000);
	}
	return out.sort((a, b) => a - b);
}

/** Loops sampled for GPU skinning: per frame, per bone, a 3x4 matrix as three rows. */
export interface BoneAnimation {
	bones: number;
	/** Stand, then Walk (the same as Stand when the model has no walk). */
	clips: AnimationClip[];
	/** frames x bones x 12 floats (rows of the 3x4 bone matrix), every clip's frames in turn. */
	data: Float32Array;
}

const SAMPLES_PER_SECOND = 15;
const MAX_FRAMES = 64;

/**
 * Samples the Stand loop (and with walk, the Walk loop) for GPU skinning. Returns null when
 * nothing would move (then the model is drawn in its static first-frame pose instead).
 */
export function standAnimation(bytes: Uint8Array, md20: number, walk = false): BoneAnimation | null {
	const stand = findStand(bytes, md20);
	if (!stand || stand.duration < 50) return null;
	const standLoop = sampleLoop(stand);
	const walkSeq = walk ? findStand(bytes, md20, ANIM_WALK) : null;
	const walkLoop = walkSeq && walkSeq.duration >= 50 ? sampleLoop(walkSeq) : null;
	if (!standLoop.moving && !walkLoop) return null;
	const standClip = { row: 0, frames: standLoop.frames, duration: stand.duration / 1000 };
	if (!walkLoop) return { bones: stand.boneCount, clips: [standClip, standClip], data: standLoop.data };
	const data = new Float32Array(standLoop.data.length + walkLoop.data.length);
	data.set(standLoop.data);
	data.set(walkLoop.data, standLoop.data.length);
	return { bones: stand.boneCount, clips: [standClip, { row: standLoop.frames, frames: walkLoop.frames, duration: walkSeq!.duration / 1000, steps: footsteps(walkSeq!) }], data };
}

/** The walking character is seen up close, and its sequences more finely sampled. */
const CHARACTER_SAMPLES_PER_SECOND = 30;
const CHARACTER_MAX_FRAMES = 200;

/**
 * Samples the listed sequences (AnimationData IDs) for GPU skinning, each a clip with its ID and
 * speed, in the order given; those the model lacks are left out. Null when it has none of them.
 */
export function sequenceAnimation(bytes: Uint8Array, md20: number, ids: number[]): BoneAnimation | null {
	const clips: AnimationClip[] = [];
	const parts: Float32Array[] = [];
	let bones = 0;
	let row = 0;
	for (const id of ids) {
		const s = findStand(bytes, md20, id);
		if (!s || s.duration < 50) continue;
		const loop = sampleLoop(s, CHARACTER_SAMPLES_PER_SECOND, CHARACTER_MAX_FRAMES);
		clips.push({ row, frames: loop.frames, duration: s.duration / 1000, id, speed: s.speed, steps: footsteps(s) });
		parts.push(loop.data);
		bones = s.boneCount;
		row += loop.frames;
	}
	if (!clips.length) return null;
	const data = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		data.set(p, at);
		at += p.length;
	}
	return { bones, clips, data };
}

/**
 * All of a model's Stand variations (its idles, as the game picks between at random) played one
 * after another, as one long loop for GPU skinning: each sampled at the same rate, so each keeps
 * its own pace. Null when the model has none with keys of its own.
 */
export function standVariations(bytes: Uint8Array, md20: number, rate = SAMPLES_PER_SECOND): BoneAnimation | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u32 = (o: number) => view.getUint32(md20 + o, true);
	const boneCount = u32(0x2c);
	const seqCount = u32(0x1c);
	const seqOffset = u32(0x20);
	if (!boneCount) return null;
	const globalLoops = Array.from({ length: u32(0x14) }, (_, k) => view.getUint32(md20 + u32(0x18) + k * 4, true));
	const parts: Float32Array[] = [];
	let frames = 0;
	let duration = 0;
	for (let i = 0; i < seqCount; i++) {
		const o = md20 + seqOffset + i * SEQUENCE_SIZE;
		if (view.getUint16(o, true) !== ANIM_STAND || !(view.getUint32(o + 12, true) & SEQUENCE_EMBEDDED)) continue;
		const s: StandSequence = { view, md20, seq: i, duration: view.getUint32(o + 4, true), boneCount, boneOffset: u32(0x30), globalLoops, speed: view.getFloat32(o + 8, true) };
		if (s.duration < 50) continue;
		const loop = sampleLoop(s, rate, Infinity);
		parts.push(loop.data);
		frames += loop.frames;
		duration += s.duration / 1000;
	}
	if (!parts.length) return null;
	const data = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		data.set(p, at);
		at += p.length;
	}
	const clip = { row: 0, frames, duration };
	return { bones: boneCount, clips: [clip, clip], data };
}

/** One loop's frames, and whether anything in it moves. */
function sampleLoop(s: StandSequence, rate = SAMPLES_PER_SECOND, maxFrames = MAX_FRAMES): { frames: number; data: Float32Array; moving: boolean } {
	const frames = Math.max(2, Math.min(maxFrames, Math.round((s.duration / 1000) * rate)));

	const data = new Float32Array(frames * s.boneCount * 12);
	let moving = false;
	for (let f = 0; f < frames; f++) {
		const pose = poseAt(s, (f / frames) * s.duration);
		pose.forEach((m, b) => {
			const o = (f * s.boneCount + b) * 12;
			for (let r = 0; r < 3; r++) {
				data[o + r * 4] = m[r];
				data[o + r * 4 + 1] = m[4 + r];
				data[o + r * 4 + 2] = m[8 + r];
				data[o + r * 4 + 3] = m[12 + r];
			}
		});
		if (f > 0 && !moving) {
			const frame = data.subarray(f * s.boneCount * 12, (f + 1) * s.boneCount * 12);
			for (let k = 0; k < frame.length; k++) {
				if (Math.abs(frame[k] - data[k]) > 1e-3) {
					moving = true;
					break;
				}
			}
		}
	}
	return { frames, data, moving };
}
/** Applies bone matrices to one 48-byte M2 vertex, writing position and normal. */
export function skinVertex(view: DataView, o: number, bones: Mat4[], pos: Float32Array, nrm: Float32Array, out: number): void {
	const px = view.getFloat32(o, true), py = view.getFloat32(o + 4, true), pz = view.getFloat32(o + 8, true);
	const nx = view.getFloat32(o + 20, true), ny = view.getFloat32(o + 24, true), nz = view.getFloat32(o + 28, true);
	let x = 0, y = 0, z = 0, a = 0, b = 0, c = 0, total = 0;
	for (let k = 0; k < 4; k++) {
		const w = view.getUint8(o + 12 + k) / 255;
		if (!w) continue;
		const m = bones[view.getUint8(o + 16 + k)];
		if (!m) continue;
		x += w * (m[0] * px + m[4] * py + m[8] * pz + m[12]);
		y += w * (m[1] * px + m[5] * py + m[9] * pz + m[13]);
		z += w * (m[2] * px + m[6] * py + m[10] * pz + m[14]);
		a += w * (m[0] * nx + m[4] * ny + m[8] * nz);
		b += w * (m[1] * nx + m[5] * ny + m[9] * nz);
		c += w * (m[2] * nx + m[6] * ny + m[10] * nz);
		total += w;
	}
	if (total === 0) {
		x = px; y = py; z = pz; a = nx; b = ny; c = nz;
	} else if (total < 0.999) {
		x /= total; y /= total; z /= total;
	}
	const len = Math.hypot(a, b, c) || 1;
	pos[out * 3] = x; pos[out * 3 + 1] = y; pos[out * 3 + 2] = z;
	nrm[out * 3] = a / len; nrm[out * 3 + 1] = b / len; nrm[out * 3 + 2] = c / len;
}

/** M2 attachment point IDs used for gear. */
export const ATTACH_SHIELD = 0;
export const ATTACH_HAND_RIGHT = 1;
export const ATTACH_HAND_LEFT = 2;
export const ATTACH_SHOULDER_RIGHT = 5;
export const ATTACH_SHOULDER_LEFT = 6;
export const ATTACH_HELM = 11;

const ATTACHMENT_SIZE = 40;

/** An attachment point: its bone, and its frame in model space (carried by the bone's pose). */
export interface AttachmentPoint {
	bone: number;
	/** Frame in bind space (for animated models, whose vertices stay in bind space). */
	bind: Mat4;
	/** Frame in the static pose (the bind frame moved by the bone's pose when bones is given). */
	posed: Mat4;
}

/** Attachment points by id. Gear models are drawn in these frames. */
export function attachmentPoints(bytes: Uint8Array, md20: number, bones: Mat4[] | null): Map<number, AttachmentPoint> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = view.getUint32(md20 + 0xf0, true);
	const offset = view.getUint32(md20 + 0xf4, true);
	const points = new Map<number, AttachmentPoint>();
	for (let i = 0; i < count; i++) {
		const o = md20 + offset + i * ATTACHMENT_SIZE;
		const id = view.getUint32(o, true);
		const bone = view.getUint16(o + 4, true);
		const at = translation(view.getFloat32(o + 8, true), view.getFloat32(o + 12, true), view.getFloat32(o + 16, true));
		const pose = bones?.[bone];
		if (!points.has(id)) points.set(id, { bone, bind: at, posed: pose ? multiply(pose, at) : at });
	}
	return points;
}
