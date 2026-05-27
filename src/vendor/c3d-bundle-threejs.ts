import "./c3d-bundle-threejs.umd.js";

const c3dGlobal = (globalThis as typeof globalThis & { C3D?: any }).C3D;

if (!c3dGlobal) {
	throw new Error("The vendored Cognitive3D bundle did not attach C3D to globalThis.");
}

export default c3dGlobal;
