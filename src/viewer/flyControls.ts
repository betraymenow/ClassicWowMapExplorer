import * as THREE from 'three';
import { isTyping } from './typing';

const LOOK_SENSITIVITY = 0.0022;
const MAX_PITCH = THREE.MathUtils.degToRad(89.5);
/** Mouse movement (px) under which a press of the left button is still a click rather than a drag. */
const DRAG_SLOP = 4;
/** Speed multiplier for Shift, and for flying forward with both mouse buttons. */
const BOOST = 5;

/** Hides the pointer (it keeps working) while dragging to look around or flying forward fast with both buttons. */
function hidePointer(hidden: boolean): void {
	document.documentElement.classList.toggle('cursor-hidden', hidden);
}
const MIN_CLEARANCE = 2;
/** How quickly the cinematic camera catches up with the mouse: about 1/e of the way left after 1/rate seconds. */
const CINEMATIC_TURN_RATE = 3;
/** How fast S and F turn the view on the spot (radians a second): 72 degrees a second. */
const KEY_TURN_RATE = Math.PI * 0.4;

/** A path the camera rides along (a flight path), set with ride(). */
export interface Ride {
	/** Moves along by dt seconds; the new position, or null at the end. */
	step(dt: number): THREE.Vector3 | null;
	/** Which way the ride is heading now (unit vector). */
	heading(): THREE.Vector3;
}

/** Seconds after the mouse last moved before a ride's view turns back to face the way it's going. */
const RIDE_LOOK_HOLD = 3;
/** How quickly the view turns to face the way the ride's going. */
const RIDE_TURN_RATE = 1.5;

interface Flight {
	from: THREE.Vector3;
	to: THREE.Vector3;
	fromYaw: number;
	toYaw: number;
	fromPitch: number;
	toPitch: number;
	t: number;
	duration: number;
}

/**
 * Free-flying camera: drag with the left button to look around, EDWR to move, Space/C for up/down,
 * Shift to boost, mouse wheel to zoom along the view direction. With smart speed, speed scales
 * with height above the ground, so the same controls work from treetop level to the whole
 * continent; without it, the camera always flies at fixedSpeed.
 */
export class FlyControls {
	/** Where the camera looks now. */
	yaw = 0;
	pitch = 0;
	/** Where the mouse has asked it to look; the view follows at once, or glides there when cinematic. */
	private lookYaw = 0;
	private lookPitch = 0;
	private readonly keys = new Set<string>();
	/** Mouse buttons held (MouseEvent.buttons): left and right together fly forward fast. */
	private buttons = 0;
	/** Both buttons were held since the last click, so that click isn't one (see takeChord). */
	private chorded = false;
	private zoomVelocity = 0;
	private flight: Flight | null = null;
	private riding: { ride: Ride; onEnd: (completed: boolean) => void; looked: number } | null = null;
	/** Ground height under the camera at the end of the last update. */
	private lastGround = -Infinity;
	/** How far below the ground the camera may still be while it eases up after the ground popped. */
	private groundEase = 0;
	/** Height above ground at the last update. */
	altitude = 0;
	speed = 0;

	constructor(
		private readonly camera: THREE.PerspectiveCamera,
		private readonly element: HTMLElement,
	) {

		// Looking around: drag with the left button held (pressed over the view, then anywhere), or
		// just move the mouse while it's locked (Caps Lock).
		document.addEventListener('mousemove', (e) => {
			if (!(e.buttons & 1)) this.dragging = false;
			if (!this.enabled || !(this.dragging || this.locked)) return;
			// Browsers now and then report a bogus jump (the hidden cursor being recentred), which
			// would snap the view; no real flick covers a third of the window in one event.
			if (Math.abs(e.movementX) > window.innerWidth / 3 || Math.abs(e.movementY) > window.innerHeight / 3) return;
			if (this.dragging) {
				this.dragDistance += Math.abs(e.movementX) + Math.abs(e.movementY);
				if (this.dragDistance > DRAG_SLOP) {
					hidePointer(true);
					// Lock the mouse for the drag, so the pointer stays where the press was and is
					// back there when the button comes up (the browser restores it on unlock).
					if (!this.locked && !this.dragLock) {
						this.dragLock = true;
						document.documentElement.classList.add('drag-lock');
						this.lock();
					}
				}
			}
			this.flight = null;
			if (this.riding) this.riding.looked = 0;
			this.lookYaw -= e.movementX * LOOK_SENSITIVITY;
			this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - e.movementY * LOOK_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
		});
		element.addEventListener('wheel', (e) => {
			e.preventDefault();
			if (!this.enabled) return;
			this.flight = null;
			this.zoomVelocity += -Math.sign(e.deltaY) * 2.5;
		}, { passive: false });
		element.addEventListener('mousedown', (e) => {
			// A fresh press starts over: a chord's or drag's leftover mark mustn't swallow the next click.
			if (!(this.buttons & 3)) {
				this.chorded = false;
				this.dragDistance = 0;
			}
			this.buttons = e.buttons;
			if (e.button === 0) this.dragging = true;
			if ((e.buttons & 3) === 3 && this.enabled) {
				this.chorded = true;
				hidePointer(true);
				// Flying forward gets you off a ride, as the movement keys do.
				this.flight = null;
				this.endRide(false);
			}
		});
		document.addEventListener('mouseup', (e) => {
			this.buttons = e.buttons;
			if (!(e.buttons & 1)) {
				this.dragging = false;
				// Only the drag's own lock: one made with Caps Lock stays.
				if (this.dragLock) {
					this.dragLock = false;
					// The browser lets go of the mouse a moment later; drag-lock (no crosshair) stays
					// until it has (see pointerlockchange), or the crosshair flashes up in between.
					if (this.locked) document.exitPointerLock();
					else document.documentElement.classList.remove('drag-lock');
				}
			}
			if (!(e.buttons & 3)) hidePointer(false);
		});
		document.addEventListener('pointerlockchange', () => {
			if (this.locked) return;
			this.dragLock = false;
			document.documentElement.classList.remove('drag-lock');
		});
		// The right button is half of flying forward with both buttons, not a context menu.
		element.addEventListener('contextmenu', (e) => e.preventDefault());
		window.addEventListener('keydown', (e) => {
			if (isTyping(e) || !this.enabled) return;
			if ((e.code === 'CapsLock' || e.key === 'CapsLock') && !e.repeat) {
				if (this.locked) document.exitPointerLock();
				else this.lock();
				return;
			}
			this.keys.add(e.code);
			if (['KeyE', 'KeyW', 'KeyD', 'KeyR', 'Space', 'KeyC', 'KeyX'].includes(e.code)) {
				this.flight = null;
				// Moving yourself gets you off a ride, as does Escape.
				this.endRide(false);
			}
			if (e.code === 'Escape') this.endRide(false);
			if (e.code === 'Space') e.preventDefault();
		});
		window.addEventListener('keyup', (e) => this.keys.delete(e.code));
		window.addEventListener('blur', () => {
			this.keys.clear();
			this.buttons = 0;
			this.dragging = false;
			hidePointer(false);
		});
	}

	/** The left button went down over the view and is still held: moving the mouse looks around. */
	private dragging = false;
	/** How far the mouse has moved (px) since the press began, to tell a drag from a click. */
	private dragDistance = 0;
	/** The mouse is locked for the current drag only (released when the left button comes up). */
	private dragLock = false;

	/**
	 * Whether the click just ended a drag (looking around) or a press of both buttons (flying
	 * forward) rather than being a click. Clears once no button is held.
	 */
	takeNonClick(): boolean {
		const not = this.chorded || this.dragDistance > DRAG_SLOP;
		if (!(this.buttons & 3)) {
			this.chorded = false;
			this.dragDistance = 0;
		}
		return not;
	}

	/** Locks the mouse to the view (Caps Lock): it's hidden and moving it looks around. */
	lock(): void {
		if (this.locked) return;
		// Raw mouse movement skips the OS pointer acceleration, which is also where the spurious
		// jumps come from; fall back to the plain lock where it isn't supported.
		const request = (this.element.requestPointerLock as (options?: { unadjustedMovement?: boolean }) => Promise<void> | void).call(this.element, { unadjustedMovement: true });
		if (request instanceof Promise) request.catch(() => this.element.requestPointerLock());
	}

	get locked(): boolean {
		return document.pointerLockElement === this.element;
	}

	/** Gliding between views (flyTo) or riding a flight path or transport, rather than flown by hand. */
	get flying(): boolean {
		return this.flight !== null || this.riding !== null;
	}

	/** Adjusts a move so it doesn't pass through solid things; set by the viewer. */
	collide: ((from: THREE.Vector3, move: THREE.Vector3) => THREE.Vector3) | null = null;

	/** Passing through everything: walls, floors and the ground (G toggles, in the viewer). */
	ghost = false;

	/** Turning glides after the mouse instead of following it at once (J toggles, in the viewer). */
	cinematic = false;

	/** Multiplies the flying speed (the View panel's slider, Y in the viewer). */
	speedScale = 1;

	/** Speed scales with height above the ground; off, the camera flies at fixedSpeed everywhere. */
	smartSpeed = true;

	/** Flying speed when smart speed is off, yd/s (before Shift's boost). */
	fixedSpeed = 64;

	/** Off while another controller (walking) has the camera: keys, mouse and wheel are left alone. */
	get enabled(): boolean {
		return this.active;
	}

	set enabled(on: boolean) {
		this.active = on;
		this.keys.clear();
		this.zoomVelocity = 0;
	}

	private active = true;

	/**
	 * Called before this takes the camera back to put it somewhere (set, flyTo, ride), so the
	 * viewer can stop walking first.
	 */
	onTakeOver: (() => void) | null = null;

	/**
	 * While another controller has the camera, keeps what the viewer reads from here (the view's
	 * direction, height above ground and speed) in step with it.
	 */
	mirror(yaw: number, pitch: number, altitude: number, speed: number): void {
		this.yaw = this.lookYaw = yaw;
		this.pitch = this.lookPitch = pitch;
		this.altitude = altitude;
		this.speed = speed;
	}


	forward(out = new THREE.Vector3()): THREE.Vector3 {
		return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
	}

	/** Smoothly moves the camera to a position and orientation. */
	flyTo(position: THREE.Vector3, yaw: number, pitch: number, duration = 2): void {
		this.onTakeOver?.();
		// Take the short way round when turning.
		let fromYaw = this.yaw;
		while (yaw - fromYaw > Math.PI) fromYaw += Math.PI * 2;
		while (fromYaw - yaw > Math.PI) fromYaw -= Math.PI * 2;
		this.flight = { from: this.camera.position.clone(), to: position.clone(), fromYaw, toYaw: yaw, fromPitch: this.pitch, toPitch: pitch, t: 0, duration };
	}

	/**
	 * Rides along a path: the camera follows it, the mouse still looks around, and the view turns
	 * back to face the way it's going a few seconds after the mouse stops. Moving gets you off.
	 * onEnd says whether the ride reached its end.
	 */
	ride(ride: Ride, onEnd: (completed: boolean) => void = () => {}): void {
		this.onTakeOver?.();
		this.endRide(false);
		this.flight = null;
		this.riding = { ride, onEnd, looked: RIDE_LOOK_HOLD };
	}

	get onRide(): boolean {
		return this.riding !== null;
	}

	endRide(completed: boolean): void {
		const r = this.riding;
		if (!r) return;
		this.riding = null;
		r.onEnd(completed);
	}

	set(position: THREE.Vector3, yaw: number, pitch: number): void {
		this.onTakeOver?.();
		this.endRide(false);
		this.camera.position.copy(position);
		this.yaw = this.lookYaw = yaw;
		this.pitch = this.lookPitch = pitch;
		this.flight = null;
		this.lastGround = -Infinity;
		this.groundEase = 0;
		this.apply();
	}

	/**
	 * groundHeight is where the camera can't go below (-Infinity over holes such as cave and mine
	 * entrances); surfaceHeight is the terrain surface ignoring holes.
	 */
	update(dt: number, groundHeight: (x: number, z: number) => number, surfaceHeight: (x: number, z: number) => number = groundHeight): void {
		const pos = this.camera.position;
		// The ground under the camera rose without it moving: a tile's detailed heights replaced the
		// coarse ones. Ease up out of it rather than snapping.
		const groundNow = groundHeight(pos.x, pos.z);
		if (Number.isFinite(groundNow) && Number.isFinite(this.lastGround) && groundNow > this.lastGround) {
			this.groundEase = Math.max(this.groundEase, groundNow - this.lastGround);
		}
		this.groundEase *= Math.exp(-dt * 6);
		if (this.groundEase < 0.01) this.groundEase = 0;
		const surface = surfaceHeight(pos.x, pos.z);
		this.altitude = Math.max(0, pos.y - Math.max(surface, 0));
		// Underground (entered through a hole): caves and mines lie below the surface, so the
		// ground only stops the camera when it comes from above.
		const aboveGround = pos.y >= surface - 0.5;

		if (this.riding) {
			const r = this.riding;
			const next = r.ride.step(dt);
			if (next) pos.copy(next);
			r.looked += dt;
			if (r.looked > RIDE_LOOK_HOLD) {
				const h = r.ride.heading();
				let yaw = Math.atan2(-h.x, -h.z);
				while (yaw - this.lookYaw > Math.PI) yaw -= Math.PI * 2;
				while (this.lookYaw - yaw > Math.PI) yaw += Math.PI * 2;
				// Looking a little down over the side, as a passenger does.
				const pitch = Math.asin(THREE.MathUtils.clamp(h.y, -1, 1)) - 0.15;
				const ease = 1 - Math.exp(-dt * RIDE_TURN_RATE);
				this.lookYaw += (yaw - this.lookYaw) * ease;
				this.lookPitch += (pitch - this.lookPitch) * ease;
			}
			const ease = 1 - Math.exp(-dt * CINEMATIC_TURN_RATE * 2);
			this.yaw += (this.lookYaw - this.yaw) * ease;
			this.pitch += (this.lookPitch - this.pitch) * ease;
			this.speed = 0;
			if (!next) this.endRide(true);
			this.lastGround = groundHeight(pos.x, pos.z);
			this.apply();
			return;
		}
		if (this.flight) {
			const f = this.flight;
			f.t = Math.min(1, f.t + dt / f.duration);
			const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
			pos.lerpVectors(f.from, f.to, e);
			this.yaw = f.fromYaw + (f.toYaw - f.fromYaw) * e;
			this.pitch = f.fromPitch + (f.toPitch - f.fromPitch) * e;
			this.lookYaw = this.yaw;
			this.lookPitch = this.pitch;
			if (f.t >= 1) this.flight = null;
		} else {
			// S and F turn the view left and right on the spot.
			const turn = (this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('KeyF') ? 1 : 0);
			this.lookYaw += turn * KEY_TURN_RATE * dt;
			if (this.cinematic) {
				const ease = 1 - Math.exp(-dt * CINEMATIC_TURN_RATE);
				this.yaw += (this.lookYaw - this.yaw) * ease;
				this.pitch += (this.lookPitch - this.pitch) * ease;
			} else {
				this.yaw = this.lookYaw;
				this.pitch = this.lookPitch;
			}

			const k = this.keys;
			const base = this.smartSpeed ? THREE.MathUtils.clamp(this.altitude * 0.8, 25, 25000) * this.speedScale : this.fixedSpeed;
			this.speed = base * (k.has('ShiftLeft') || k.has('ShiftRight') ? BOOST : 1);
			// Both mouse buttons: forward at the boosted speed, on top of the keys at their own speed.
			const rushing = (this.buttons & 3) === 3;

			const forward = this.forward();
			const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
			const move = new THREE.Vector3();
			if ((k.has('KeyE') || k.has('ArrowUp')) && !rushing) move.add(forward);
			if (k.has('KeyD') || k.has('ArrowDown')) move.sub(forward);
			if (k.has('KeyR') || k.has('ArrowRight')) move.add(right);
			if (k.has('KeyW') || k.has('ArrowLeft')) move.sub(right);
			if (k.has('Space')) move.y += 1;
			if (k.has('KeyC') || k.has('KeyX')) move.y -= 1;
			const delta = new THREE.Vector3();
			if (move.lengthSq() > 0) delta.addScaledVector(move.normalize(), this.speed * dt);
			if (rushing) {
				delta.addScaledVector(forward, base * BOOST * dt);
				this.speed = Math.max(this.speed, base * BOOST);
			}

			// Wheel zoom: move along the view by a fraction of the current height (or of the fixed
			// speed), decaying smoothly.
			if (Math.abs(this.zoomVelocity) > 0.01) {
				const reach = this.smartSpeed ? Math.max(this.altitude, 20) : this.fixedSpeed;
				const step = this.zoomVelocity * reach * 0.12 * Math.min(1, dt * 8);
				delta.addScaledVector(forward, step);
				this.zoomVelocity *= Math.pow(0.004, dt);
			}
			// Walls, floors and ceilings of buildings and caves are solid (flights between views aren't).
			pos.add(this.collide && !this.ghost ? this.collide(pos, delta) : delta);
		}

		const ground = groundHeight(pos.x, pos.z);
		const floor = ground + MIN_CLEARANCE - this.groundEase;
		if (aboveGround && !this.ghost && pos.y < floor) pos.y = floor;
		this.lastGround = ground;
		this.apply();
	}

	private apply(): void {
		this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
	}
}
