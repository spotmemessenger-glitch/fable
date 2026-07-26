// Ybot avatar — pick a 3D model from the registry (or the lightweight orb).
// Add more models by dropping FBX files in assets/ and adding an entry to MODELS.
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

// Registry — extend this to offer more avatars in the Models menu.
export const MODELS = {
  george: { name: "George (old man)", idle: "assets/Idle.fbx", talk: "assets/Talking.fbx" },
  hiphop: { name: "Hip-Hop Dancer", idle: "assets/HipHop.fbx", talk: "assets/HipHop.fbx" },
  orb: { name: "Orb (lightweight)", orb: true },
};

const currentModel = localStorage.getItem("ybotModel") || "george";
window.ybotModels = { list: MODELS, current: currentModel };

const mount = document.getElementById("avatar");
const model = MODELS[currentModel] || MODELS.george;

if (model.orb) {
  // No 3D — keep the pulsing orb; speaking state just brightens it via CSS if desired.
  window.ybotAvatar = { setSpeaking() {} };
} else {
  initThreeAvatar(model);
}

function initThreeAvatar(model) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, mount.clientWidth / mount.clientHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  mount.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.25));
  const key = new THREE.DirectionalLight(0x9ff0e6, 1.6);
  key.position.set(1, 3, 2);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x4c8dff, 0.85);
  rim.position.set(-2, 1, -2);
  scene.add(rim);

  const clock = new THREE.Clock();
  const loader = new FBXLoader();
  let mixer, idleAction, talkAction, current;

  function frameUpperBody(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    obj.scale.setScalar(1.7 / size.y);
    const b2 = new THREE.Box3().setFromObject(obj);
    const c = new THREE.Vector3();
    b2.getCenter(c);
    obj.position.x -= c.x;
    obj.position.z -= c.z;
    obj.position.y -= b2.min.y;
    const top = b2.max.y - b2.min.y;
    camera.position.set(0, top * 0.78, top * 0.95);
    camera.lookAt(0, top * 0.72, 0);
  }

  loader.load(
    model.idle,
    (fbx) => {
      document.getElementById("orb")?.remove();
      frameUpperBody(fbx);
      scene.add(fbx);
      mixer = new THREE.AnimationMixer(fbx);
      idleAction = mixer.clipAction(fbx.animations[0]);
      idleAction.play();
      current = idleAction;
      if (model.talk) {
        loader.load(model.talk, (t) => {
          if (t.animations[0]) talkAction = mixer.clipAction(t.animations[0]);
        });
      }
      animate();
    },
    undefined,
    (err) => {
      console.error("avatar load failed", err);
      const s = document.getElementById("state");
      if (s) s.textContent = "avatar failed to load (using orb)";
    }
  );

  function crossfade(to) {
    if (!to || to === current) return;
    to.reset().play();
    current.crossFadeTo(to, 0.3, false);
    current = to;
  }

  window.ybotAvatar = {
    setSpeaking(on) {
      crossfade(on ? talkAction : idleAction);
    },
  };

  function animate() {
    requestAnimationFrame(animate);
    if (mixer) mixer.update(clock.getDelta());
    renderer.render(scene, camera);
  }

  window.addEventListener("resize", () => {
    if (!mount.clientWidth) return;
    camera.aspect = mount.clientWidth / mount.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(mount.clientWidth, mount.clientHeight);
  });
}
