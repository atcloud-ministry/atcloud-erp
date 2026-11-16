import type { PointerEvent } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import { useCurrentTime } from "../../hooks/useCurrentTime";

// Outline cloud matching the @Cloud mark; drawn in a 100x60 box.
const CLOUD_PATH =
  "M27 50 H76 A15 15 0 0 0 76 20 A23 23 0 0 0 33 17 A17 17 0 0 0 27 50 Z";

interface CloudProps {
  className: string;
  depth: number;
  drift: number;
  duration: number;
  pointerX: ReturnType<typeof useSpring>;
  pointerY: ReturnType<typeof useSpring>;
  strokeWidth?: number;
}

function Cloud({
  className,
  depth,
  drift,
  duration,
  pointerX,
  pointerY,
  strokeWidth = 2.2,
}: CloudProps) {
  const reduceMotion = useReducedMotion();
  const x = useTransform(pointerX, (v) => v * depth);
  const y = useTransform(pointerY, (v) => v * depth);

  return (
    <motion.div className={`absolute ${className}`} style={{ x, y }}>
      <motion.svg
        animate={reduceMotion ? undefined : { x: [0, drift, 0] }}
        className="h-full w-full overflow-visible"
        fill="none"
        transition={{ duration, repeat: Infinity, ease: "easeInOut" }}
        viewBox="0 0 100 60"
      >
        <path
          d={CLOUD_PATH}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      </motion.svg>
    </motion.div>
  );
}

export default function WelcomeHeader() {
  const { greeting, formattedDate } = useCurrentTime();
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const pointerX = useSpring(rawX, { stiffness: 60, damping: 18 });
  const pointerY = useSpring(rawY, { stiffness: 60, damping: 18 });
  const markX = useTransform(pointerX, (v) => v * 14);
  const markY = useTransform(pointerY, (v) => v * 14);

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    rawX.set(((event.clientX - rect.left) / rect.width - 0.5) * 2);
    rawY.set(((event.clientY - rect.top) / rect.height - 0.5) * 2);
  };

  const resetPointer = () => {
    rawX.set(0);
    rawY.set(0);
  };

  return (
    <section
      className="relative isolate overflow-hidden rounded-2xl border border-gray-200/80 bg-white px-6 py-8 shadow-sm sm:px-8 sm:py-10"
      onPointerLeave={resetPointer}
      onPointerMove={handlePointerMove}
    >
      {/* Dot field, faded toward the copy so text stays crisp. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(theme(colors.gray.300)_1px,transparent_1px)] [background-size:20px_20px] [mask-image:linear-gradient(to_left,black,transparent_65%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-24 -z-10 h-72 w-72 rounded-full bg-brand-100/60 blur-3xl"
      />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 hidden w-[42%] md:block"
      >
        <Cloud
          className="right-[14%] top-[18%] h-28 w-44 text-brand-400"
          depth={10}
          drift={10}
          duration={9}
          pointerX={pointerX}
          pointerY={pointerY}
          strokeWidth={2.5}
        />
        <Cloud
          className="right-[46%] top-[52%] h-16 w-28 text-brand-200"
          depth={18}
          drift={-14}
          duration={12}
          pointerX={pointerX}
          pointerY={pointerY}
        />
        <Cloud
          className="right-[4%] top-[62%] h-12 w-20 text-gray-300"
          depth={26}
          drift={8}
          duration={7}
          pointerX={pointerX}
          pointerY={pointerY}
        />
        <motion.span
          animate={{ scale: [1, 1.12, 1] }}
          className="absolute right-[38%] top-[22%] flex h-7 w-7 items-center justify-center rounded-full bg-accent-100 font-display text-sm font-semibold text-accent-600 ring-4 ring-white"
          style={{ x: markX, y: markY }}
          transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        >
          @
        </motion.span>
      </div>

      <div className="relative max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-700">
          {formattedDate}
        </p>
        <h1 className="mt-3 text-3xl leading-tight text-gray-900 sm:text-[2.5rem]">
          {greeting}, Welcome to @Cloud Events!
        </h1>
        <p className="mt-4 text-base leading-relaxed text-gray-600 sm:text-lg">
          Welcome to @Cloud Marketplace Ministry Events Management System. Here
          you can create or join events, connect with the community, and grow
          your ministry and career.
        </p>
      </div>
    </section>
  );
}
