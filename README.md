# @cognitive3d/zappar-three

This package integrates the [Cognitive3D WebXR SDK](https://github.com/CognitiveVR/c3d-sdk-webxr) into Zappar's `@zcomponent/zappar-three` WebAR scenes. It wires the analytics session lifecycle directly into Zappar's camera permission and tracking pipeline, giving accurate gaze and dynamic object data in mobile AR replay.

## Installation

### Install via NPM

In the add-ons and dependencies of Mattercraft, search for `@cognitive3d/zappar-three`

## Features

* **Quick Setup:** Add the Cognitive3D Manager directly to your scene hierarchy.
* **UI Properties Panel:** Easily paste your API keys and Scene data.
* **Zappar-Native Session Lifecycle:** Starts the analytics session the moment Zappar grants camera permission and delivers its first frame — no WebXR fallback heuristics.
* **Analytics Origin:** Records gaze and dynamic object poses relative to the scene root, so editor-set translations don't leak into the data.
* **Dynamic Object Tracking:** Attach the `Cognitive3DDynamicObject` behavior to any 3D model to track positions, rotations, and heatmaps in the dashboard.
* **Scene and Dynamic Object Export:** Press `Shift+E` inside Mattercraft preview to export your environment for the dashboard. Press `Shift+D` to export dynamic objects.
  * **NOTE** : Ensure the Scene Export toggle is enabled and you save your scene to export data. You can find this setting under the Cognitive3D Behavior component in your scene hierarchy. Disable the toggle after the export is complete.
