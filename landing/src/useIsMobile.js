import { useEffect, useState } from "react";

const DEFAULT_BREAKPOINT = 760;

/**
 * Tracks whether the viewport is at or below a mobile breakpoint (760px by
 * default), mirroring the responsive logic from the source design. Each page
 * in the source uses its own breakpoint — the landing at 760, docs at 860,
 * changelog at 720 — so callers may pass one in.
 */
export function useIsMobile(breakpoint = DEFAULT_BREAKPOINT) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= breakpoint : false
  );

  useEffect(() => {
    const onResize = () => {
      const next = window.innerWidth <= breakpoint;
      setIsMobile((prev) => (prev !== next ? next : prev));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);

  return isMobile;
}
