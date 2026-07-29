---
name: physics-simulation-3d
description: Rigid-body, collision and GPU-accelerated physics simulation with PyBullet and NVIDIA Warp. Use for physics sims, collision setup, rigid-body dynamics, robotics/reinforcement-learning environments, differentiable simulation, or GPU-parallel geometry kernels. Verified with pybullet 3.2.7 and warp-lang 1.15.0 on cuda:0.
---

# 3D physics simulation

Interpreter: `C:\Users\yuv\.venvs\threed\Scripts\python.exe`

Two complementary tools:
- **PyBullet** — mature rigid-body/robotics engine, CPU, URDF support.
- **NVIDIA Warp** — GPU kernels in Python, **verified on `cuda:0`** here;
  differentiable, ideal for particles/cloth/custom solvers at scale.

## PyBullet — verified

```python
import pybullet as p, pybullet_data
p.connect(p.DIRECT)                 # DIRECT = headless; GUI = viewer
p.setAdditionalSearchPath(pybullet_data.getDataPath())
p.setGravity(0, 0, -9.81)
plane = p.loadURDF('plane.urdf')
box   = p.loadURDF('r2d2.urdf', [0, 0, 1])
for _ in range(240):
    p.stepSimulation()
pos, orn = p.getBasePositionAndOrientation(box)
```

**Use `p.DIRECT` for headless/batch** — `p.GUI` opens a window and will block or
fail in background contexts.

### Rules that matter

- **Default timestep is 1/240 s.** `stepSimulation()` advances one step, so 240
  calls = 1 simulated second. Do not conflate steps with frames.
- Larger timesteps make stacks jitter and objects tunnel through thin walls. If
  you must, raise solver iterations rather than the timestep:
  `p.setPhysicsEngineParameter(numSolverIterations=50)`.
- **Concave meshes do not collide correctly as dynamic bodies.** Bullet treats
  dynamic collision shapes as convex. Either decompose (V-HACD:
  `p.vhacd(in, out, log)`) or keep concave geometry static.
- Mass 0 = static body. A "floor" is just a mass-0 body.

## Warp — GPU kernels

```python
import warp as wp
wp.init()
print(wp.get_preferred_device())      # cuda:0

@wp.kernel
def integrate(pos: wp.array(dtype=wp.vec3),
              vel: wp.array(dtype=wp.vec3), dt: float):
    i = wp.tid()
    vel[i] = vel[i] + wp.vec3(0.0, -9.81, 0.0) * dt
    pos[i] = pos[i] + vel[i] * dt

n = 10000
pos = wp.zeros(n, dtype=wp.vec3); vel = wp.zeros(n, dtype=wp.vec3)
wp.launch(integrate, dim=n, inputs=[pos, vel, 1.0/60.0])
wp.synchronize()
p = pos.numpy()
```

- `wp.tid()` gives the thread index; `dim` sets thread count.
- Kernels are **JIT-compiled on first launch** — the first call is slow, so
  warm up before timing anything.
- Copying to `.numpy()` forces a sync and is the usual hidden bottleneck; keep
  data resident on GPU across steps.
- Warp is **differentiable** (`wp.Tape()`), which is why it suits optimisation
  and learning loops in a way Bullet does not.

## VRAM reality on this machine

GTX 1050 Ti, 4 GB, shared with OmniParser/SAM 2 if those are loaded. Warp
particle counts in the low millions are fine; large cloth/fluid grids are not.

## Choosing

| Need | Use |
|---|---|
| Robotics, URDF, RL envs | PyBullet |
| Rigid-body with contacts | PyBullet |
| Particles, cloth, custom solver | Warp |
| Differentiable / optimisation | Warp |
| Visual FX for rendering | Blender physics ([[blender-automation]]) |
