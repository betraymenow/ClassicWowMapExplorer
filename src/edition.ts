/**
 * Which game this build is for, set at build time (`vite build --mode retail` reads .env.retail).
 * Classic (the default) explores WoW Classic; retail explores the live game ("wow"), with only
 * Eastern Kingdoms, Kalimdor and Zandalar, and without the classic NPC spawns.
 */
// import.meta.env only exists under Vite; the Node tools (npm run probe...) run without it.
export const RETAIL = import.meta.env?.VITE_EDITION === 'retail';
