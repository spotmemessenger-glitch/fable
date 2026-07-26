"use client";

import { useEffect, useRef } from "react";

/**
 * AgentAvatar — renders /models/talking.glb in a small three.js viewport.
 * (Was a 6.45 MB FBX; quantized glTF with WebP textures is 0.54 MB for the
 * same rig and clip.)
 *
 * Liveliness model:
 * - the model's own "talking" clip provides GESTURES: full speed while the
 *   agent speaks, slowed to a gentle idle sway otherwise
 * - LIP SYNC is best-effort amplitude sync: if the mesh exposes mouth/jaw
 *   morph targets they're driven from the live audio level; else if a jaw
 *   bone exists it's rotated; if neither, gestures alone carry the life.
 *   (window.__ysnapAgentLevel is set each frame by the widget's analyser.)
 *
 * three.js is imported dynamically so the ~600 KB module and the 6.7 MB
 * model only ever load after a visitor opens the widget.
 */

declare global {
  interface Window {
    __ysnapAgentLevel?: number; // 0..1 speech amplitude, written by the widget
    __ysnapAgentSpeaking?: boolean;
    __ysnapAvatarStatus?: string; // load diagnostics
  }
}

export default function AgentAvatar({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

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
      const height = host.clientHeight || 200;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);

      scene.add(new THREE.HemisphereLight(0xffffff, 0x8899bb, 1.4));
      const dir = new THREE.DirectionalLight(0xffffff, 1.6);
      dir.position.set(1.5, 3, 2.5);
      scene.add(dir);

      let mixer: import("three").AnimationMixer | null = null;
      const morphs: { mesh: import("three").Mesh; idx: number }[] = [];
      let jaw: import("three").Bone | null = null;
      let jawBase = 0;

      try {
        const gltf = await new GLTFLoader().loadAsync("/models/talking.glb");
        if (disposed) return;
        const model = gltf.scene;

        /* frame the model: center it, camera on the upper half */
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(center); // model centered at origin
        const h = size.y;
        /* mid-shot framing: with a 30° vfov, a distance of 1.3·h frames
           roughly hips-to-above-head regardless of the rig's proportions.
           Clip planes must scale with the rig too — FBX rigs are often in
           centimetres (~200 units tall), far beyond the default far=100. */
        camera.near = Math.max(0.1, h * 0.01);
        camera.far = h * 8;
        camera.position.set(0, h * 0.18, h * 1.3);
        camera.lookAt(0, h * 0.2, 0);
        camera.updateProjectionMatrix();

        /* Find lip-sync handles: mouth/jaw morph targets, else a jaw bone.
           This rig reports 0 morphs and no jaw bone, so in practice the
           gesture clip carries the performance on its own — the search stays
           for the day the model is swapped for one that is rigged for it. */
        model.traverse((obj) => {
          const mesh = obj as import("three").Mesh;
          if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
            for (const [name, idx] of Object.entries(mesh.morphTargetDictionary)) {
              if (/mouth|jaw|viseme|aa|open/i.test(name)) morphs.push({ mesh, idx });
            }
          }
          if ((obj as import("three").Bone).isBone && /jaw/i.test(obj.name) && !jaw) {
            jaw = obj as import("three").Bone;
            jawBase = jaw.rotation.x;
          }
        });

        if (gltf.animations.length > 0) {
          mixer = new THREE.AnimationMixer(model);
          mixer.clipAction(gltf.animations[0]).play();
        }
        scene.add(model);
        /* paint one frame immediately — the rAF loop takes over after, but
           this guarantees a visible model even if rAF is throttled */
        renderer.render(scene, camera);
        window.__ysnapAvatarStatus = `loaded · ${morphs.length} morphs · jaw:${!!jaw} · clips:${gltf.animations.length} · h:${h.toFixed(1)}`;
      } catch (err) {
        /* model failed to load — leave the viewport empty; chat still works */
        window.__ysnapAvatarStatus = `error: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`;
      }

      const clock = new THREE.Clock();
      let raf = 0;
      let level = 0;
      const rm = window.matchMedia("(prefers-reduced-motion: reduce)");
      const frame = () => {
        const dt = clock.getDelta();
        const speaking = !!window.__ysnapAgentSpeaking;
        const target = window.__ysnapAgentLevel ?? 0;
        level += (target - level) * 0.35;
        if (mixer) {
          /* full gesture speed while speaking; slow living sway at rest */
          mixer.timeScale = rm.matches ? 0 : speaking ? 1 : 0.18;
          mixer.update(dt);
        }
        const open = Math.min(1, level * 2.4);
        for (const m of morphs) m.mesh.morphTargetInfluences![m.idx] = open;
        if (jaw) jaw.rotation.x = jawBase + open * 0.22;
        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      const ro = new ResizeObserver(() => {
        const w = host.clientWidth;
        const hgt = host.clientHeight;
        if (w > 0 && hgt > 0) {
          renderer.setSize(w, hgt);
          camera.aspect = w / hgt;
          camera.updateProjectionMatrix();
        }
      });
      ro.observe(host);

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        renderer.dispose();
        renderer.domElement.remove();
      };
    };

    /* This component only mounts once the visitor opens the chat, so the
       three.js chunk and the model are already off the page's critical path.
       Start immediately — they asked to see him. */
    void boot();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return <div ref={hostRef} className={className} aria-hidden />;
}
