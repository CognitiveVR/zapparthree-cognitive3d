// The vendored Cognitive3D bundle is a UMD. When loaded via a <script> tag it
// attaches C3D to globalThis. When loaded via a CommonJS-style bundler (which
// is what Mattercraft and most modern toolchains do) it sets module.exports
// directly. Read globalThis first for the script-tag case, fall back to the
// default import for the bundler case.
import { isAppClip } from "@zappar/zappar";

import C3DBundle from "./c3d-bundle-threejs.umd.js";

const c3dGlobal =
	(globalThis as typeof globalThis & { C3D?: any }).C3D ?? (C3DBundle as any);

if (!c3dGlobal) {
	throw new Error("The vendored Cognitive3D bundle did not produce a C3D class.");
}

/**
 * In an iOS App Clip's WKWebView, FingerprintJS (loaded by initializeDeviceId)
 * opens an `about:blank` iframe. The native nav handler routes that non-http URL
 * to SFSafariViewController, which throws an uncaught NSException -> SIGABRT.
 * Disable the device-id probe in App Clips only (trade-off: no `c3d.deviceid`).
 */
if (isAppClip()) {
	const c3dProto = (c3dGlobal as { prototype?: Record<string, unknown> }).prototype;
	if (c3dProto && typeof c3dProto.initializeDeviceId === "function") {
		c3dProto.initializeDeviceId = async function disabledInitializeDeviceId() {};
	}
}

export default c3dGlobal;
