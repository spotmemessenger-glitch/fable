"use client";

import { useEffect, useRef } from "react";

/**
 * DancerModel — /models/hip-hop-dancing.glb in a small three.js viewport,
 * looping its baked dance clip.
 *
 * The source was a 5.8 MB FBX; converted to quantized glTF with WebP
 * textures it is 0.79 MB for the same mesh and all 53 animation channels.
 * Needs KHR_mesh_quantization and EXT_texture_webp, both of which three.js
 * and every current browser support natively — no Draco decoder required
 * (Draco only saved a further 0.18 MB here, since the weight is animation
 * keyframes rather than geometry).
 *
 * three.js and the model are behind a dynamic import and only mount once the
 * hero has actually painted (see hero-dancer.tsx), so nothing sits on the
 * critical path.
 *
 * The rAF loop stops whenever the model is offscreen or the tab is hidden —
 * a character animation nobody is looking at is pure battery burn on a phone.
 */
export default function DancerModel({
  className,
  onReady,
}: {
  className?: string;
  onReady?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  /* keep the callback out of the effect's deps so a re-created parent
     function can never tear down and re-download the model */
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    const boot = async () => {
      const THREE = await import("three");
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      if (disposed) return;

      const width = host.clientWidth || 320;
      const height = host.clientHeight || 420;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 100);

      /* Lit to read against the hero's teal→violet wash: cool ambient fill,
         one key from front-right, one rim from behind to separate the
         silhouette from the background. */
      scene.add(new THREE.HemisphereLight(0xffffff, 0x8fa3d0, 1.5));
      const key = new THREE.DirectionalLight(0xffffff, 1.7);
      key.position.set(2, 3, 3);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xbcd4ff, 0.9);
      rim.position.set(-2, 2, -3);
      scene.add(rim);

      let mixer: import("three").AnimationMixer | null = null;

      try {
        const gltf = await new GLTFLoader().loadAsync("/models/hip-hop-dancing.glb");
        if (disposed) return;
        const model = gltf.scene;

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(center);
        const h = size.y || 1;

        /* Clip planes scale with the rig: Mixamo FBX exports are in
           centimetres (~180 units tall), far outside the default far=100,
           which would clip the model into invisibility. */
        camera.near = Math.max(0.1, h * 0.01);
        camera.far = h * 10;
        /* Full-body framing. The visible height at the model's plane is
           2·d·tan(fov/2); at 32° that is 0.573·d, so d must be ≳ 1.75·h just
           to fit the rig at all. 2.3·h leaves ~30% margin for the arms and
           the travel of the dance, which otherwise clip at the edges. */
        camera.position.set(0, h * 0.04, h * 2.3);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();

        if (gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model);
          mixer.clipAction(gltf.animations[0]).play();
        }
        scene.add(model);
        renderer.render(scene, camera); // paint once even if rAF is throttled
        readyRef.current?.();
      } catch {
        /* model unavailable — the wrapper keeps its placeholder orb */
        return;
      }

      const clock = new THREE.Clock();
      let raf = 0;
      let inView = true;
      let pageVisible = !document.hidden;
      /* Deliberately does NOT gate on prefers-reduced-motion. The dance is the
         point of this element, so it loops for everyone; it stays paused
         offscreen and on hidden tabs, which is what actually protects battery.
         Reverse this if the accessibility trade-off is ever revisited. */
      const running = () => inView && pageVisible;

      const frame = () => {
        mixer?.update(clock.getDelta());
        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
      };
      const start = () => {
        if (raf === 0 && running()) {
          clock.getDelta(); // drop time accrued while paused
          raf = requestAnimationFrame(frame);
        }
      };
      const stop = () => {
        if (raf !== 0) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      };
      const sync = () => (running() ? start() : stop());

      const io = new IntersectionObserver(
        ([e]) => {
          if (!e) return;
          inView = e.isIntersecting;
          sync();
        },
        { rootMargin: "120px" },
      );
      io.observe(host);
      const onVis = () => {
        pageVisible = !document.hidden;
        sync();
      };
      document.addEventListener("visibilitychange", onVis);

      const ro = new ResizeObserver(() => {
        const w = host.clientWidth;
        const hh = host.clientHeight;
        if (w > 0 && hh > 0) {
          renderer.setSize(w, hh);
          camera.aspect = w / hh;
          camera.updateProjectionMatrix();
        }
      });
      ro.observe(host);

      sync();

      cleanup = () => {
        stop();
        io.disconnect();
        ro.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        renderer.dispose();
        renderer.domElement.remove();
      };
    };

    void boot();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return <div ref={hostRef} className={className} aria-hidden />;
}
