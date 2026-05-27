import { Context, ContextManager } from "@zcomponent/core";
import * as THREE from "three";

export interface IDynamicObjectBehavior {
    getTrackedObject(): THREE.Object3D | null;
    getProps(): any;
}

interface Cognitive3DContextProps {}

/** @zcontext */
export class Cognitive3DContext extends Context<Cognitive3DContextProps> {

    public c3d: any | null = null;
    public c3dAdapter: any = null;
    public trackedBehaviors: Set<IDynamicObjectBehavior> = new Set();
    public registeredWithSDK: Set<IDynamicObjectBehavior> = new Set();
    public pendingRegistrations: IDynamicObjectBehavior[] = [];
    public sceneName: string = "";
    public enableDebug: boolean = false;

    public registerDynamicObject: ((behavior: IDynamicObjectBehavior) => void) | null = null;

    constructor(contextManager: ContextManager, constructorProps: Cognitive3DContextProps) {
        super(contextManager, constructorProps);
    }

    public debug(...args: any[]): void {
        if (this.enableDebug) {
            console.log(...args);
        }
    }

    public recordSensor(name: string, value: number | boolean): void {
        if (!this.c3d || !this.c3d.isSessionActive()) return;
        this.c3d.sensor.recordSensor(name, value);
    }

    public sendEvent(
        category: string,
        position: number[] = [0, 0, 0],
        properties?: Record<string, any>
    ): void {
        if (!this.c3d || !this.c3d.isSessionActive()) return;
        this.c3d.customEvent.send(category, position, properties);
    }

    dispose() {
        this.c3d = null;
        this.c3dAdapter = null;
        this.trackedBehaviors.clear();
        this.registeredWithSDK.clear();
        this.pendingRegistrations = [];
        return super.dispose();
    }
}
