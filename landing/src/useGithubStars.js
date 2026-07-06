import { useEffect, useState } from "react";
import { GITHUB_URL } from "./content.js";

const CACHE_KEY = "sw_github_stars";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — GitHub's unauthenticated REST API caps at 60 req/hour per IP

function repoPath() {
  try {
    const u = new URL(GITHUB_URL);
    return u.pathname.replace(/^\/+|\/+$/g, "");
  } catch (_) {
    return null;
  }
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.count !== "number" || typeof parsed.at !== "number") return null;
    if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return parsed.count;
  } catch (_) {
    return null;
  }
}

function writeCache(count) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ count, at: Date.now() }));
  } catch (_) {
    // best-effort; a full/blocked localStorage just means every load re-fetches
  }
}

/** Formats a count compactly for a nav badge: 950 -> "950", 1200 -> "1.2k". */
export function formatStars(n) {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(n % 1000 >= 100 ? 1 : 0) + "k";
}

/**
 * Live GitHub star count for the repo, via the public unauthenticated REST
 * API (no token needed for a public repo). Returns null until loaded, and
 * stays null forever on any failure — callers should simply omit the badge
 * rather than show a broken/zero count.
 */
export function useGithubStars() {
  const [stars, setStars] = useState(() => readCache());

  useEffect(() => {
    if (stars != null) return; // fresh cache already covers this render
    const path = repoPath();
    if (!path) return;

    let cancelled = false;
    fetch(`https://api.github.com/repos/${path}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data || typeof data.stargazers_count !== "number") return;
        setStars(data.stargazers_count);
        writeCache(data.stargazers_count);
      })
      .catch(() => {
        // network error / rate-limited — silently stay null, no badge shown
      });

    return () => {
      cancelled = true;
    };
  }, [stars]);

  return stars;
}
