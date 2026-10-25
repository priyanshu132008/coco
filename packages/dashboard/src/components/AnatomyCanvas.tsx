'use client'

import { useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

/** Ink on paper. One colour, one weight — the whole figure is drawn in #111111. */
const INK = '#111111'

/** The three shells the assistant runs inside, from the outside in.
 *  Each carries its own tilt and speed, so they turn on different axes. */
const RINGS = [
  { radius: 1.75, tilt: [0, 0, 0], speed: 0.12 },
  { radius: 2.1, tilt: [Math.PI / 2.6, 0.4, 0.2], speed: -0.08 },
  { radius: 2.45, tilt: [0.3, Math.PI / 2.4, -0.35], speed: 0.05 },
]

/** WebGL is not universal — say so plainly rather than showing an empty frame. */
function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/** The figure: a wireframe core with three orbital shells, tilted by the pointer.
 *  Everything is animated in useFrame against refs — no React state, no re-render. */
function Anatomy({ reduced }: { reduced: boolean }): React.ReactElement {
  const group = useRef<THREE.Group>(null)
  const core = useRef<THREE.Mesh>(null)
  const shells = useRef<THREE.Mesh[]>([])
  // pointer target, eased toward in the frame loop
  const target = useRef({ x: 0, y: 0 })
  const eased = useRef({ x: 0, y: 0 })
  const { size } = useThree()

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const w = window.innerWidth || 1
      const h = window.innerHeight || 1
      target.current.x = ((e.clientX / w) - 0.5) * 2
      target.current.y = ((e.clientY / h) - 0.5) * 2
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 1 / 30) // a backgrounded tab must not jump
    const g = group.current
    if (!g) return

    // pointer tilt — exponential follow, so the figure never snaps to the cursor
    const t = reduced ? { x: 0, y: 0 } : target.current
    const k = 1 - Math.exp(-dt / 0.28)
    eased.current.x += (t.x - eased.current.x) * k
    eased.current.y += (t.y - eased.current.y) * k
    g.rotation.y = eased.current.x * 0.35
    g.rotation.x = -eased.current.y * 0.25

    if (core.current && !reduced) core.current.rotation.y += dt * 0.25
    if (!reduced) {
      shells.current.forEach((shell, i) => {
        if (shell) shell.rotation.y += dt * RINGS[i].speed
      })
    }
    // keep the figure framed as the canvas resizes
    const s = Math.min(size.width, size.height)
    g.scale.setScalar(Math.max(0.55, Math.min(1, s / 560)))
  })

  return (
    <group ref={group}>
      {/* Local Vault & Machine Execution */}
      <mesh ref={core}>
        <sphereGeometry args={[1.05, 18, 12]} />
        <meshBasicMaterial color={INK} wireframe transparent opacity={0.55} />
      </mesh>

      {RINGS.map((ring, i) => (
        <mesh
          key={ring.radius}
          ref={(el) => {
            if (el) shells.current[i] = el
          }}
          rotation={ring.tilt as [number, number, number]}
        >
          <torusGeometry args={[ring.radius, 0.012, 6, 96]} />
          <meshBasicMaterial color={INK} transparent opacity={0.5} />
        </mesh>
      ))}
    </group>
  )
}

/** Overlaid callouts — plain type, in the page's own sans, positioned over the canvas.
 *  Each rule ends on its label, so the mark resolves against the type. */
function Callouts(): React.ReactElement {
  return (
    <div className="pointer-events-none absolute inset-0 font-sans text-[11px] tracking-wide text-ink">
      <div className="absolute left-[8%] top-[18%]">
        <span className="border-l border-ink/40 pl-2">Local Encrypted Vault</span>
      </div>
      <div className="absolute bottom-[22%] right-[6%] text-right">
        <span className="border-r border-ink/40 pr-2">Zero Data Retention</span>
      </div>
    </div>
  )
}

/** No WebGL: the same figure, drawn flat and kept clear of the corner labels. */
function Fallback(): React.ReactElement {
  return (
    <svg viewBox="0 0 400 400" className="absolute inset-0 h-full w-full" role="presentation">
      <g fill="none" stroke={INK} strokeWidth="1">
        <circle cx="200" cy="200" r="42" strokeOpacity="0.5" />
        <ellipse cx="200" cy="200" rx="78" ry="24" strokeOpacity="0.4" />
        <ellipse cx="200" cy="200" rx="92" ry="30" strokeOpacity="0.3" transform="rotate(-28 200 200)" />
        <ellipse cx="200" cy="200" rx="98" ry="26" strokeOpacity="0.3" transform="rotate(52 200 200)" />
      </g>
    </svg>
  )
}

export default function AnatomyCanvas(): React.ReactElement {
  const [ok, setOk] = useState<boolean | null>(null) // null = not yet known
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    setOk(webglAvailable())
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return (
    <div className="relative h-[450px] w-full">
      {ok === true ? (
        <Canvas
          dpr={[1, 1.5]}
          gl={{ alpha: true, antialias: true }}
          camera={{ position: [0, 0, 6], fov: 45 }}
          onCreated={({ gl }) => gl.setClearColor(0x000000, 0)} // transparent — paper shows through
        >
          <Anatomy reduced={reduced} />
        </Canvas>
      ) : ok === false ? (
        <Fallback />
      ) : null}
      <Callouts />
    </div>
  )
}
