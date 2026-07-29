---
name: web3d-development
description: Build realtime 3D for the browser with Three.js, Babylon.js or PlayCanvas — scene setup, glTF loading, PBR lighting, and web performance. Use when building web 3D, embedding models in a page, choosing a web 3D engine, or debugging browser rendering performance. Verified installs three 0.185.1, @babylonjs/core 9.18.1, playcanvas 2.21.3.
---

# Web 3D development

Installed globally via npm: `three` 0.185.1, `@babylonjs/core` 9.18.1,
`playcanvas` 2.21.3.

## Choosing

| Engine | Pick it when |
|---|---|
| **Three.js** | Custom/creative rendering, maximum control, largest ecosystem. Lowest level — you build the engine parts you need. |
| **Babylon.js** | Batteries included: physics, GUI, inspector, animation. Best for apps/games without assembling libraries. |
| **PlayCanvas** | Team/editor workflow, mobile-first, smallest runtime. |

Default to Three.js for embedding models and bespoke visuals; Babylon when you'd
otherwise reimplement half an engine.

## Three.js — minimum viable correct scene

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));   // cap! see below
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.append(renderer.domElement);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth/innerHeight, 0.1, 100);
camera.position.set(0, 1, 3);

new GLTFLoader().load('model.glb', g => scene.add(g.scene));
scene.add(new THREE.DirectionalLight(0xffffff, 3));
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

renderer.setAnimationLoop(() => renderer.render(scene, camera));
```

Two things that are wrong in most tutorials:
- **Cap `setPixelRatio` at 2.** Uncapped on a 3× phone you render 9× the pixels
  and tank the framerate for no visible gain.
- Use `setAnimationLoop`, not `requestAnimationFrame` — it is required for
  WebXR and handles tab-visibility correctly.

## PBR needs an environment map

A `MeshStandardMaterial` with no environment renders flat and dark — metals go
black, because metal has no diffuse and reflects only the environment.

```js
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment()).texture;
```
This single line fixes "my glTF looks wrong in the browser" most of the time.

## Performance

- **Draw calls dominate.** Merge static geometry; use `InstancedMesh` for
  repeats. 100 instanced trees = 1 draw call.
- **Compress:** Draco for geometry, KTX2/Basis for textures. A 40 MB glTF
  becomes ~3 MB and decodes on GPU.
  ```js
  loader.setDRACOLoader(dracoLoader); loader.setKTX2Loader(ktx2Loader);
  ```
- **Dispose explicitly.** JS GC does not free GPU memory:
  `geometry.dispose(); material.dispose(); texture.dispose();`
  Failing to do this on scene changes is the classic web3D memory leak.
- Shadows are expensive — one shadow-casting light, tight shadow-camera frustum.
- Mobile: quarter your desktop budgets (see [[game-ready-3d-assets]]).

## Asset prep

Export baked glTF/GLB per [[usd-gltf-pipeline]] — Y-up, metres, metallic-
roughness only, no modifiers. Then compress before shipping.
