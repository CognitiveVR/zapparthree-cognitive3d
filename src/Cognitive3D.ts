import { Component, Behavior, ContextManager, useOnBeforeRender, started } from "@zcomponent/core";
import { ThreeContext, ThreeSceneContext, OnBeforeRenderPriority } from "@zcomponent/three";
import * as THREE from "three";
import { EditorContext } from "@zcomponent/three/lib/editorcontext";

import C3D from "./vendor/c3d-bundle-threejs";
import { Cognitive3DContext } from "./Cognitive3DContext";
import type { IDynamicObjectBehavior } from "./Cognitive3DContext";

export type { IDynamicObjectBehavior } from "./Cognitive3DContext";

// Lazy-load the ARContext class so the bundle doesn't hard-depend on
// @zcomponent/zappar-three at parse time.
let _arContextClassPromise: Promise<any> | null = null;
function getARContextClass(): Promise<any> {
    if (_arContextClassPromise) return _arContextClassPromise;
    _arContextClassPromise = import("@zcomponent/zappar-three/lib/components/arcontext")
        .then(mod => (mod as any).ARContext)
        .catch(() => null);
    return _arContextClassPromise;
}

export interface Cognitive3DConstructionProps {
    /** @zui */
    apiKey: string;
    /** @zui */
    sceneId: string;
    /** @zui */
    sceneName: string;
    /** @zui */
    sceneVersion?: string;
    /**
     * @zui
     * @zlabel App Version
     * @zdefault "1.0"
     */
    appVersion: string;
    /**
     * @zui
     * @zlabel Toggle Export
     * @zdefault false
     */
    enableExport: boolean;
    /**
     * @zui
     * @zlabel Enable Debug Logging
     * @zdefault false
     */
    enableDebug: boolean;
}

/**
 * @zbehavior
 * @zdescription Cognitive3D Integration (Zappar WebAR)
 * @ztag three/Object3D/Analytics/Cognitive3D
 * @zparents three/Object3D/**
 * @zicon analytics
 */
export class Cognitive3D extends Behavior<Component> {
    private static readonly WEBAR_FLUSH_INTERVAL_MS = 10000;
    private static readonly ZAPPAR_WORLD_SCALE_MODE_ABSOLUTE = 1;

    private ctx: Cognitive3DContext;

    private c3d: any | null = null;
    private c3dAdapter: any = null;
    private threeContext: ThreeContext;
    private sceneContext: ThreeSceneContext;
    private _isStartingSession = false;
    private _isEndingSession = false;
    private _hasConfiguredWebARScaleMode = false;
    private _webARFlushIntervalId: ReturnType<typeof setInterval> | null = null;

    private _arContext: any = null;
    private _arResetHandler: (() => void) | null = null;
    private _analyticsOriginNode: THREE.Object3D | null = null;

    private _sceneExportRequestHandler = () => {
        if (this.constructorProps.enableExport) {
            this.exportScene();
        }
    };
    private _dynamicExportRequestHandler = () => {
        if (this.constructorProps.enableExport) {
            void this.exportDynamicObjects();
        }
    };
    private _visibilityChangeHandler = () => {
        if (document.visibilityState === "hidden" && this.c3d?.isSessionActive()) {
            void this.c3d.sendData().catch((err: unknown) => {
                this.ctx.debug("Cognitive3D: Failed to flush session data on hide", err);
            });
        }
    };
    private _pageHideHandler = () => {
        if (this.c3d?.isSessionActive()) {
            void this._endC3DSession("Page hidden");
        }
    };

    private _emitRuntimeDebug(message: string, details?: unknown) {
        if (details === undefined) {
            this.ctx.debug(message);
        } else {
            this.ctx.debug(message, details);
        }

        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("c3d-runtime-debug", {
                detail: { message, details }
            }));
        }
    }

    constructor(contextManager: ContextManager, instance: Component, protected constructorProps: Cognitive3DConstructionProps) {
        super(contextManager, instance);

        this.ctx = this.contextManager.get(Cognitive3DContext);

        this.ctx.pendingRegistrations.forEach(b => this.ctx.trackedBehaviors.add(b));
        this.ctx.pendingRegistrations = [];

        this.threeContext = this.contextManager.get(ThreeContext);
        this.sceneContext = this.contextManager.get(ThreeSceneContext);

        try {
            this.c3d = new C3D({
                config: {
                    APIKey: this.constructorProps.apiKey,
                    LOG: this.constructorProps.enableDebug,
                    gazeTrackingSource: "engine",
                    allSceneData: [{
                        sceneId: this.constructorProps.sceneId,
                        sceneName: this.constructorProps.sceneName,
                        versionNumber: this.constructorProps.sceneVersion || "1"
                    }]
                }
            });

            this.c3dAdapter = new (C3D as any).Adapter(this.c3d);

            if (this.constructorProps.sceneName) {
                this.c3d.setScene(this.constructorProps.sceneName);
            }
            this.c3d.setDeviceProperty("AppEngine", "MatterCraft");
            this.c3d.setAppVersion(this.constructorProps.appVersion || "1.0");

            this.ctx.c3d = this.c3d;
            this.ctx.c3dAdapter = this.c3dAdapter;
            this.ctx.sceneName = this.constructorProps.sceneName;
            this.ctx.enableDebug = this.constructorProps.enableDebug;
            this.ctx.registerDynamicObject = (b) => this.registerDynamicObject(b);
            this._emitRuntimeDebug("Cognitive3D behavior initialized.");

            started(this.contextManager).then(() => {
                this._configureWebARWorldScaleMode();
                this._emitRuntimeDebug("Mattercraft runtime started; wiring Zappar lifecycle.");
                void this._setupZapparLifecycle();
            });

            this.register(
                useOnBeforeRender(this.contextManager),
                (_dt: number) => {
                    if (this.c3dAdapter) {
                        this.c3dAdapter.update();
                    }
                },
                OnBeforeRenderPriority.AfterTransforms
            );

            window.addEventListener('keydown', this.handleKeyDown);
            window.addEventListener('c3d-export-scene', this._sceneExportRequestHandler as EventListener);
            window.addEventListener('c3d-export-dynamic-objects', this._dynamicExportRequestHandler as EventListener);
            document.addEventListener("visibilitychange", this._visibilityChangeHandler);
            window.addEventListener("pagehide", this._pageHideHandler);

        } catch (err) {
            this._emitRuntimeDebug("Cognitive3D initialization failed.", err);
            console.error("Cognitive3D: Init Failed", err);
        }
    }

    public registerDynamicObject(behavior: IDynamicObjectBehavior) {
        this.ctx.trackedBehaviors.add(behavior);

        if (!this.c3d || !this.c3dAdapter || !this.c3d.isSessionActive()) {
            return;
        }

        if (this.ctx.registeredWithSDK.has(behavior)) {
            return;
        }

        const groupObj = behavior.getTrackedObject();
        const props = behavior.getProps();

        if (!groupObj) {
            console.warn("Cognitive3D: Dynamic Object has no Three.js element yet.");
            return;
        }

        const fallbackName = groupObj.name || "UnnamedObject";
        const objectName = props.c3dMeshName || fallbackName;
        const meshName = this.getDynamicObjectAssetName(objectName);
        const customId = props.c3dCustomId || groupObj.uuid;

        groupObj.updateWorldMatrix(true, true);
        const worldPos = new THREE.Vector3();
        const worldQuat = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        groupObj.matrixWorld.decompose(worldPos, worldQuat, worldScale);
        const localScale = groupObj.scale.clone();

        if (typeof this.c3dAdapter.transformWorldToAnalyticsOrigin === "function") {
            this.c3dAdapter.transformWorldToAnalyticsOrigin(worldPos, worldQuat);
        }

        const runtimeId = this.c3d.dynamicObject.registerObjectCustomId(
            objectName,
            meshName,
            customId,
            [worldPos.x, worldPos.y, worldPos.z * -1],
            [worldQuat.x, worldQuat.y, worldQuat.z * -1, worldQuat.w * -1],
            [localScale.x, localScale.y, localScale.z]
        );

        groupObj.userData.c3dId = runtimeId;
        this.ctx.registeredWithSDK.add(behavior);

        this.c3dAdapter.trackDynamicObject(groupObj, runtimeId, {
            positionThreshold: props.positionThreshold,
            rotationThreshold: props.rotationThreshold,
            useLocalScale: true,
        });

        this.ctx.debug(
            `Cognitive3D: Dynamic Object registered '${objectName}' ` +
            `(asset=${meshName}, local=${localScale.toArray().join(", ")}, world=${worldScale.toArray().join(", ")})`
        );

        if (typeof this.c3dAdapter.addInteractable === 'function') {
            let raycastTarget: THREE.Object3D = groupObj;

            if (!this.hasGeometry(groupObj)) {
                const visualNode = this.findVisualNodeForTrackedObject(objectName);
                if (visualNode) {
                    raycastTarget = visualNode;
                }

                if (raycastTarget !== groupObj) {
                    this.ctx.debug(`Cognitive3D: Swapped empty tracker '${objectName}' for visual node in raycaster.`);
                }
            }

            raycastTarget.userData.c3dTrackedRoot = groupObj;
            this.c3dAdapter.addInteractable(raycastTarget, groupObj);
            this.ctx.debug(`Cognitive3D: Raycasting enabled for '${objectName}'`);
        }

        this.ctx.debug(`Cognitive3D: Dynamic Object Registered: ${objectName}`);
    }

    public unregisterDynamicObject(behavior: IDynamicObjectBehavior) {
        this.ctx.trackedBehaviors.delete(behavior);
    }

    private getDynamicObjectAssetName(name: string): string {
        return name.replace(/\.(glb|gltf|fbx|obj|usdz)$/i, "");
    }

    private _configureWebARWorldScaleMode() {
        if (this._hasConfiguredWebARScaleMode) return;

        let configuredTrackers = 0;
        const zcomponent = this.getZComponentInstance();
        const entities = zcomponent?.entityByID?.values ? Array.from(zcomponent.entityByID.values()) : [];

        for (const entity of entities) {
            const worldTracker = (entity as any)?._worldTrackerContext?.worldTracker;
            if (!worldTracker || typeof worldTracker.scaleMode !== "number") continue;

            worldTracker.scaleMode = Cognitive3D.ZAPPAR_WORLD_SCALE_MODE_ABSOLUTE;
            configuredTrackers += 1;
        }

        if (configuredTrackers > 0) {
            this._hasConfiguredWebARScaleMode = true;
            this._emitRuntimeDebug(`Configured ${configuredTrackers} Zappar world tracker(s) for absolute scale.`);
        }
    }

    // Resolves the scene's root Group entity (id="root" by Mattercraft convention).
    // Using this as the analytics origin cancels out any editor-set root translation
    // from recorded poses.
    private _findSceneRootGroup(): THREE.Object3D | null {
        const zcomponent = this.getZComponentInstance();
        if (!zcomponent?.entityByID) return null;
        const rootEntity = zcomponent.entityByID.get('root');
        const element = (rootEntity as any)?.element;
        return element && (element as THREE.Object3D).isObject3D ? (element as THREE.Object3D) : null;
    }

    private hasGeometry(obj: THREE.Object3D): boolean {
        let hasGeom = false;
        obj.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) hasGeom = true;
        });
        return hasGeom;
    }

    private findVisualNodeForTrackedObject(objectName: string): THREE.Object3D | null {
        const scene = this.sceneContext.scene;
        let visualNode: THREE.Object3D | null = null;

        scene.traverse((node) => {
            if (visualNode) return;
            if (node.name === objectName && this.hasGeometry(node)) {
                visualNode = node;
            }
        });

        return visualNode;
    }

    private createExportRootFromTrackedObject(rootObj: THREE.Object3D, objectName: string): THREE.Object3D {
        const rootClone = rootObj.clone(true);
        if (this.hasGeometry(rootClone)) {
            return rootClone;
        }

        const visualNode = this.findVisualNodeForTrackedObject(objectName);
        if (!visualNode) {
            console.warn(`Cognitive3D: Could not find visual geometry for '${objectName}'. Exporting tracked root as-is.`);
            return rootClone;
        }

        rootObj.updateWorldMatrix(true, false);
        visualNode.updateWorldMatrix(true, false);

        const rootInverse = rootObj.matrixWorld.clone().invert();
        const visualLocalMatrix = rootInverse.multiply(visualNode.matrixWorld.clone());

        const anchoredRoot = new THREE.Group();
        anchoredRoot.name = objectName;

        const anchoredVisual = visualNode.clone(true);
        const localPosition = new THREE.Vector3();
        const localRotation = new THREE.Quaternion();
        const localScale = new THREE.Vector3();

        visualLocalMatrix.decompose(localPosition, localRotation, localScale);
        anchoredVisual.position.copy(localPosition);
        anchoredVisual.quaternion.copy(localRotation);
        anchoredVisual.scale.copy(localScale);
        anchoredVisual.updateMatrixWorld(true);

        anchoredRoot.add(anchoredVisual);
        this.ctx.debug(`Cognitive3D: Built anchored export root for '${objectName}' from detached visual node.`);
        return anchoredRoot;
    }

    private async _setupZapparLifecycle(): Promise<void> {
        const ARContextClass = await getARContextClass();
        if (!ARContextClass) {
            this._emitRuntimeDebug("ARContext not found — is @zcomponent/zappar-three installed?");
            return;
        }

        let arContext: any;
        try {
            arContext = this.contextManager.get(ARContextClass);
        } catch (err) {
            this._emitRuntimeDebug("ARContext lookup failed.", err);
            return;
        }

        if (!arContext) {
            this._emitRuntimeDebug("No ARContext in scene.");
            return;
        }

        this._arContext = arContext;
        this._emitRuntimeDebug("Zappar ARContext detected; wiring session lifecycle.");

        this._analyticsOriginNode = this._findSceneRootGroup();
        if (this._analyticsOriginNode && typeof this.c3dAdapter?.setAnalyticsOrigin === "function") {
            this.c3dAdapter.setAnalyticsOrigin(this._analyticsOriginNode);
            this._emitRuntimeDebug(
                `Analytics origin bound to scene root '${this._analyticsOriginNode.name || "(unnamed)"}'.`
            );
        } else if (!this._analyticsOriginNode) {
            this._emitRuntimeDebug("Could not resolve scene root; analytics will use raw world coords.");
        }

        const maybeStart = () => {
            if (!this.c3d || this.c3d.isSessionActive() || this._isStartingSession || this._isEndingSession) return;
            if (!arContext.permissionGranted.value) return;
            if (!arContext.hadFirstFrame.value) return;

            this._emitRuntimeDebug("Camera permission granted + first frame received; starting analytics session.");
            void this._startC3DSession();
        };

        this.register(arContext.permissionGranted, () => maybeStart());
        this.register(arContext.hadFirstFrame, () => maybeStart());

        // Flush on world-tracking resets — poses across a reset boundary belong
        // to different tracking frames.
        this._arResetHandler = () => {
            if (this.c3d?.isSessionActive()) {
                void this.c3d.sendData().catch((err: unknown) => {
                    this.ctx.debug("Cognitive3D: Flush on Zappar reset failed", err);
                });
            }
        };
        arContext.onResetWorldTracking.addListener(this._arResetHandler);

        if (arContext.permissionDenied) {
            this.register(arContext.permissionDenied, (denied: boolean) => {
                if (denied && this.c3d?.isSessionActive()) {
                    void this._endC3DSession("Zappar camera permission denied");
                }
            });
        }

        maybeStart();
    }

    private _startWebARFlushLoop() {
        if (this._webARFlushIntervalId) {
            clearInterval(this._webARFlushIntervalId);
        }

        this._webARFlushIntervalId = setInterval(() => {
            if (!this.c3d?.isSessionActive()) return;
            void this.c3d.sendData().catch((err: unknown) => {
                this.ctx.debug("Cognitive3D: Periodic flush failed", err);
            });
        }, Cognitive3D.WEBAR_FLUSH_INTERVAL_MS);
    }

    private _stopWebARFlushLoop() {
        if (!this._webARFlushIntervalId) return;
        clearInterval(this._webARFlushIntervalId);
        this._webARFlushIntervalId = null;
    }

    private async _endC3DSession(reason: string) {
        if (!this.c3d || !this.c3d.isSessionActive() || this._isEndingSession) return;

        this._isEndingSession = true;
        this._stopWebARFlushLoop();

        try {
            this._emitRuntimeDebug(`Ending analytics session (${reason}).`);
            await this.c3d.endSession();
            this._emitRuntimeDebug("Analytics session ended.");
        } catch (err) {
            this._emitRuntimeDebug("Analytics session end failed.", err);
            console.error("Cognitive3D: Error ending session", err);
        } finally {
            this._isEndingSession = false;
        }
    }

    private async _startC3DSession() {
        if (!this.c3d || this._isStartingSession || this._isEndingSession) return;

        this._isStartingSession = true;
        try {
            this._configureWebARWorldScaleMode();
            this._emitRuntimeDebug("Starting WebAR analytics session.");

            const renderer = this.threeContext.renderer as THREE.WebGLRenderer;
            const scene = this.sceneContext.scene;
            const trackingCamera = this.sceneContext.activeCamera.value;

            if (renderer && trackingCamera) {
                (this.c3d as any).config.gazeTrackingSource = "engine";
                this.c3dAdapter?.startTracking(renderer, trackingCamera as THREE.Camera, scene);

                // Re-bind the analytics origin after startTracking resets adapter state.
                if (this._analyticsOriginNode && typeof this.c3dAdapter?.setAnalyticsOrigin === "function") {
                    this.c3dAdapter.setAnalyticsOrigin(this._analyticsOriginNode);
                }
            } else {
                this._emitRuntimeDebug("Renderer or camera missing during startup.", {
                    hasRenderer: Boolean(renderer),
                    hasTrackingCamera: Boolean(trackingCamera),
                });
            }

            const success = await this.c3d.startSession(null);

            if (success) {
                this._startWebARFlushLoop();
                this._emitRuntimeDebug("Analytics session started (zappar-webar).");

                this.sceneContext.scene.updateMatrixWorld(true);
                let initCount = 0;
                this.ctx.trackedBehaviors.forEach(behavior => {
                    this.registerDynamicObject(behavior);
                    initCount++;
                });
                this._emitRuntimeDebug(`Registered ${initCount} dynamic objects.`);

                void this.c3d.sendData()
                    .then((status: number | string) => {
                        this._emitRuntimeDebug(`Initial flush completed (${status}).`);
                    })
                    .catch((err: unknown) => {
                        this._emitRuntimeDebug("Initial flush failed.", err);
                    });
            } else {
                this._emitRuntimeDebug("Session start returned false.");
            }
        } catch (err) {
            this._emitRuntimeDebug("Session start failed.", err);
            console.error("Cognitive3D: Error starting session", err);
        } finally {
            this._isStartingSession = false;
        }
    }

    private handleKeyDown = (event: KeyboardEvent) => {
        if (!this.constructorProps.enableExport) return;

        if (event.shiftKey && (event.key === 'E' || event.key === 'e')) {
            this.exportScene();
        }
        if (event.shiftKey && (event.key === 'D' || event.key === 'd')) {
            this.exportDynamicObjects();
        }
    }

    private async exportDynamicObjects() {
        if (!this.c3dAdapter) {
            console.warn("Cognitive3D: Cannot export, adapter not initialized.");
            return;
        }

        const renderer = this.threeContext.renderer;
        const camera = this.sceneContext.activeCamera.value;

        if (!renderer || !camera) {
            console.warn("Cognitive3D: Missing Renderer or Camera for export.");
            return;
        }

        this.ctx.debug(`Cognitive3D: Checking ${this.ctx.trackedBehaviors.size} Dynamic Objects for export...`);

        const dynamicNames = new Set<string>();
        for (const behavior of Array.from(this.ctx.trackedBehaviors)) {
            const wrapper = behavior.getTrackedObject();
            const props = behavior.getProps();
            if (wrapper) {
                const fallbackName = wrapper.name || "UnnamedObject";
                dynamicNames.add(props.c3dMeshName || fallbackName);
            }
        }

        const exportedMeshes = new Set<string>();

        for (const behavior of Array.from(this.ctx.trackedBehaviors)) {
            const wrapper = behavior.getTrackedObject();
            const props = behavior.getProps();

            if (wrapper) {
                const fallbackName = wrapper.name || "UnnamedObject";
                const objectName = props.c3dMeshName || fallbackName;
                const exportName = this.getDynamicObjectAssetName(objectName);

                if (exportedMeshes.has(exportName)) {
                    this.ctx.debug(`Cognitive3D: Skipping duplicate export: '${exportName}'`);
                    continue;
                }

                exportedMeshes.add(exportName);

                this.ctx.debug(`Cognitive3D: Exporting Dynamic Object '${objectName}' as '${exportName}'`);

                let objToExport = this.createExportRootFromTrackedObject(wrapper, objectName);

                const nodesToRemove: THREE.Object3D[] = [];
                objToExport.traverse((node) => {
                    if (node === objToExport) return;
                    if (dynamicNames.has(node.name)) nodesToRemove.push(node);
                });
                nodesToRemove.forEach(node => { if (node.parent) node.parent.remove(node); });

                objToExport.position.set(0, 0, 0);
                objToExport.quaternion.identity();
                // Reset authored scale so the GLB doesn't double-apply it.
                // The snapshot stream records localScale every frame, and the
                // dashboard multiplies that onto the GLB scale — leaving the
                // authored value baked in would square it.
                objToExport.scale.set(1, 1, 1);
                objToExport.updateMatrixWorld(true);

                const exportRoot = new THREE.Group();
                exportRoot.name = "CoordinateSystemFix";
                exportRoot.add(objToExport);
                exportRoot.scale.z = -1;
                exportRoot.scale.x = -1;

                if (typeof this.c3dAdapter.exportObject === 'function') {
                    await this.c3dAdapter.exportObject(
                        exportRoot,
                        exportName,
                        renderer as THREE.WebGLRenderer,
                        camera
                    );
                } else {
                    console.error("Cognitive3D: c3dAdapter.exportObject not found.");
                }
            }
        }
    }

    private exportScene() {
        if (!this.c3dAdapter) return;
        const renderer = this.threeContext.renderer as THREE.WebGLRenderer;
        const liveScene = this.sceneContext.scene;
        let camera = this.sceneContext.activeCamera.value;

        try {
            const editorContext = this.contextManager.get(EditorContext);
            if (editorContext && editorContext.orbitControls.value) {
                camera = editorContext.orbitControls.value.object as THREE.Camera;
                this.ctx.debug("Cognitive3D: Using Editor camera for export.");
            }
        } catch (e) {
            this.ctx.debug("Cognitive3D: Editor environment not found, using active camera.");
        }

        if (!renderer || !liveScene || !camera) return;

        this.ctx.debug("Cognitive3D: Exporting Scene...");

        const strippedUserData: { obj: THREE.Object3D, isDynamic?: boolean, c3dId?: string }[] = [];
        liveScene.traverse((obj) => {
            if (obj.userData && (obj.userData.c3dId !== undefined || obj.userData.isDynamic !== undefined)) {
                strippedUserData.push({ obj, isDynamic: obj.userData.isDynamic, c3dId: obj.userData.c3dId });
                delete obj.userData.isDynamic;
                delete obj.userData.c3dId;
            }
        });

        const hiddenObjects: { obj: THREE.Object3D, originalVisibility: boolean }[] = [];
        this.ctx.trackedBehaviors.forEach(behavior => {
            const obj = behavior.getTrackedObject();
            if (obj) {
                hiddenObjects.push({ obj, originalVisibility: obj.visible });
                obj.visible = false;
            }
        });

        renderer.render(liveScene, camera);

        const exportName = this.constructorProps.sceneName || "Unnamed-WebAR-Scene";

        try {
            const sceneToExport = this._buildExportScene(liveScene);
            this.c3dAdapter.exportScene(sceneToExport, exportName, renderer, camera);
        } finally {
            hiddenObjects.forEach(({ obj, originalVisibility }) => { obj.visible = originalVisibility; });
            strippedUserData.forEach(({ obj, isDynamic, c3dId }) => {
                if (isDynamic !== undefined) obj.userData.isDynamic = isDynamic;
                if (c3dId !== undefined) obj.userData.c3dId = c3dId;
            });
        }

        this.ctx.debug(`Cognitive3D: Scene '${exportName}' exported.`);
    }

    // When an analytics origin is bound, clone its children into a fresh Scene
    // at identity transform. This puts the export in the same coordinate frame
    // as the recorded gaze and object samples.
    private _buildExportScene(liveScene: THREE.Scene): THREE.Scene {
        if (!this._analyticsOriginNode) return liveScene;

        const exportScene = new THREE.Scene();
        if (liveScene.background) exportScene.background = liveScene.background;

        for (const child of this._analyticsOriginNode.children) {
            if (this._isDynamicObjectRoot(child)) continue;
            exportScene.add(child.clone(true));
        }

        // Include scene-level nodes (lights etc.) that live above the origin.
        for (const sceneChild of liveScene.children) {
            if (this._isDescendantOfOrigin(sceneChild)) continue;
            exportScene.add(sceneChild.clone(true));
        }

        exportScene.updateMatrixWorld(true);
        return exportScene;
    }

    private _isDescendantOfOrigin(node: THREE.Object3D): boolean {
        if (!this._analyticsOriginNode) return false;
        let cur: THREE.Object3D | null = node;
        while (cur) {
            if (cur === this._analyticsOriginNode) return true;
            cur = cur.parent;
        }
        return false;
    }

    private _isDynamicObjectRoot(node: THREE.Object3D): boolean {
        let isDynamic = false;
        node.traverse(child => {
            if (isDynamic) return;
            if (child.userData?.c3dId || child.userData?.isDynamic) isDynamic = true;
        });
        return isDynamic;
    }

    public override dispose() {
        window.removeEventListener('keydown', this.handleKeyDown);
        window.removeEventListener('c3d-export-scene', this._sceneExportRequestHandler as EventListener);
        window.removeEventListener('c3d-export-dynamic-objects', this._dynamicExportRequestHandler as EventListener);
        document.removeEventListener("visibilitychange", this._visibilityChangeHandler);
        window.removeEventListener("pagehide", this._pageHideHandler);
        this._stopWebARFlushLoop();

        if (this._arContext && this._arResetHandler) {
            try {
                this._arContext.onResetWorldTracking.removeListener(this._arResetHandler);
            } catch { /* defensive */ }
            this._arResetHandler = null;
        }
        this._arContext = null;
        this._analyticsOriginNode = null;
        if (this.c3dAdapter && typeof this.c3dAdapter.setAnalyticsOrigin === "function") {
            this.c3dAdapter.setAnalyticsOrigin(null);
        }

        if (this.c3d && this.c3d.isSessionActive()) {
            void this._endC3DSession("Behavior disposed");
        }

        this.c3d = null;
        this.c3dAdapter = null;
        this.ctx.c3d = null;
        this.ctx.c3dAdapter = null;
        this.ctx.registerDynamicObject = null;
        this.ctx.trackedBehaviors.clear();
        this.ctx.registeredWithSDK.clear();

        return super.dispose();
    }
}
