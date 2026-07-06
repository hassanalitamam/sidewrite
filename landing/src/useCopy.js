import { useCallback, useEffect, useRef, useState } from "react";
import { INSTALL_CMD } from "./content.js";

/**
 * Clipboard-copy of the install command with a transient "copied ✓" label,
 * mirroring the source design's copyInstall behavior (1.8s reset).
 */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  const copy = useCallback(() => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(INSTALL_CMD).catch(() => {});
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { copied, copyLabel: copied ? "copied ✓" : "copy", copy };
}
