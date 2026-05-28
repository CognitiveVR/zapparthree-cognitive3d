import { Component, ContextManager, useOnBeforeRender, started } from "@zcomponent/core";
import { OnBeforeRenderPriority } from "@zcomponent/three";
import * as THREE from "three";

import { Cognitive3DContext, IDynamicObjectBehavior } from "./Cognitive3DContext";

const _vec = new THREE.Vector3();

export interface Cognitive3DDynamicObjectConstructionProps {
    /**
     * @zui
     * @zlabel Model Mesh Name (must match the uploaded object mesh name of Cognitive3d Dashboard)
     */
    c3dMeshName?: string;

    /**
     * @zui
     * @zlabel Custom ID (must be unique for each object)
     */
    c3dCustomId?: string;

    /**
     * @zui
     * @zdefault 0.1
     */
    positionThreshold: number;

    /**
     * @zui
     * @zdefault 0.1
     */
    rotationThreshold: number;
}

/**
 * @zcomponent
 * @zdescription Marks an object for Cognitive3D Tracking & Movement
 * @ztag three/Object3D/Analytics/Cognitive3DDynamicObject
 * @zparents three/Object3D/**
 * @zicon track_changes
 */
export class Cognitive3DDynamicObject extends Component<Cognitive3DDynamicObjectConstructionProps> implements IDynamicObjectBehavior {

    private _isInitialized = false;
    private _lastTrackedUUID: string | null = null;
    private ctx: Cognitive3DContext;

    constructor(contextManager: ContextManager, protected constructorProps: Cognitive3DDynamicObjectConstructionProps) {
        super(contextManager, constructorProps);

        this.ctx = this.contextManager.get(Cognitive3DContext);

        this.register(
            useOnBeforeRender(this.contextManager),
            (_dt: number) => this.onUpdate(),
            OnBeforeRenderPriority.AfterTransforms
        );

        this.tryRegisterWithManager();
    }

    private tryRegisterWithManager() {
        if (this.ctx.registerDynamicObject) {
            started(this.contextManager).then(() => {
                this.ctx.registerDynamicObject?.(this);
            });
        } else {
            if (!this.ctx.pendingRegistrations.includes(this)) {
                this.ctx.pendingRegistrations.push(this);
            }
        }
    }

    // Generates a stable ID using the scene name, mesh name, ZComponent parent
    // chain, and world position as inputs. Only runs when c3dCustomId is blank.
    private _generateDeterministicId(meshName: string, obj: THREE.Object3D): string {
        const pad = (s: string, len: number): string => {
            while (s.length < len) s = '0' + s;
            return s;
        };

        const sceneName = this.ctx.sceneName || 'scene';
        const instancePath = this._collectInstancePath().join('/');
        const posKey = this._positionFingerprint(obj);
        const uniqueKey = (instancePath || obj.uuid) + '|' + posKey;
        const fullKey = sceneName + '::' + meshName + '::' + uniqueKey;

        const djb2 = (input: string): number => {
            let h = 5381;
            for (let i = 0; i < input.length; i++) {
                h = Math.imul(h, 33) + input.charCodeAt(i);
                h = h | 0;
            }
            return h >>> 0;
        };

        const keyHash  = pad(djb2(fullKey).toString(16), 8);
        const nameHash = pad(djb2(uniqueKey).toString(16), 4);
        const keyLen   = pad(fullKey.length.toString(16), 4);

        return 'c3d-' + keyHash + '-' + nameHash + '-' + keyLen;
    }

    // Walks the ZComponent parent chain to build a placement-unique path string.
    // Outer placement IDs differ per instance even when the inner template IDs match.
    private _collectInstancePath(): string[] {
        const path: string[] = [];
        const seen = new Set<string>();
        // @ts-ignore — .parent is not in public typedefs but exists at runtime
        let current: any = this.parent;
        while (current) {
            try {
                const zc = current.getZComponentInstance?.();
                if (zc?.idByElement && current.element) {
                    const entityId = zc.idByElement.get(current.element);
                    if (entityId && !seen.has(entityId)) {
                        seen.add(entityId);
                        path.push(entityId);
                    }
                }
            } catch (_) { /* keep walking */ }
            current = current.parent;
        }
        return path;
    }

    private _positionFingerprint(obj: THREE.Object3D): string {
        obj.updateWorldMatrix(true, false);
        const p = new THREE.Vector3();
        obj.getWorldPosition(p);
        const round = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);
        return round(p.x) + ',' + round(p.y) + ',' + round(p.z);
    }

    public getTrackedObject(): THREE.Object3D | null {
        const parent = this.parent as any;
        let obj = parent?.element as THREE.Object3D | undefined;

        if (!obj && parent?.elementsResolved && parent.elementsResolved.length > 0) {
            obj = parent.elementsResolved[0] as THREE.Object3D;
        }

        if (obj) {
            if (!this._isInitialized) {
                if (!this.constructorProps.c3dMeshName && obj.name) {
                    this.constructorProps.c3dMeshName = obj.name;
                }

                if (this.constructorProps.c3dMeshName) {
                    obj.name = this.constructorProps.c3dMeshName;
                }

                if (!this.constructorProps.c3dCustomId) {
                    const meshNameForId = this.constructorProps.c3dMeshName || obj.name;
                    this.constructorProps.c3dCustomId = this._generateDeterministicId(meshNameForId, obj);
                    this.ctx.debug(
                        'Cognitive3D: Auto-generated deterministic ID for \'' + meshNameForId + '\': ' +
                        this.constructorProps.c3dCustomId + '\n' +
                        '  → To make this permanent and rename-safe, paste this value into the \'Custom ID\' inspector field.'
                    );
                }

                const fallbackName = obj.name || "UnnamedObject";
                obj.userData.isDynamic = true;
                obj.userData.modelId = this.constructorProps.c3dMeshName || fallbackName;
                obj.userData.positionThreshold = this.constructorProps.positionThreshold;
                obj.userData.rotationThreshold = this.constructorProps.rotationThreshold;

                if (!obj.name) {
                    console.warn(`Cognitive3D: Object with Model '${this.constructorProps.c3dMeshName}' has no name.`);
                }

                this._isInitialized = true;
            }
            return obj;
        }

        return null;
    }

    private onUpdate() {
        const obj = this.getTrackedObject();
        if (!obj) return;

        obj.getWorldPosition(_vec);

        if (obj.uuid !== this._lastTrackedUUID) {
            this._lastTrackedUUID = obj.uuid;
            this.tryRegisterWithManager();
        }
    }

    public getProps() {
        return this.constructorProps;
    }

    public override dispose() {
        const idx = this.ctx.pendingRegistrations.indexOf(this);
        if (idx !== -1) this.ctx.pendingRegistrations.splice(idx, 1);

        this.ctx.trackedBehaviors.delete(this);
        this.ctx.registeredWithSDK.delete(this);

        return super.dispose();
    }
}
