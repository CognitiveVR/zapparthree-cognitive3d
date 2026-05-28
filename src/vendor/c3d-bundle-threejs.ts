// The vendored Cognitive3D bundle is a UMD. When loaded via a <script> tag it
// attaches C3D to globalThis. When loaded via a CommonJS-style bundler (which
// is what Mattercraft and most modern toolchains do) it sets module.exports
// directly. Read globalThis first for the script-tag case, fall back to the
// default import for the bundler case.
import C3DBundle from "./c3d-bundle-threejs.umd.js";

const c3dGlobal =
	(globalThis as typeof globalThis & { C3D?: any }).C3D ?? (C3DBundle as any);

if (!c3dGlobal) {
	throw new Error("The vendored Cognitive3D bundle did not produce a C3D class.");
}

export default c3dGlobal;
