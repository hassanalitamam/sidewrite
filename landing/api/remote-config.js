// Vercel serverless function — the remote-config channel plugin/scripts/
// remote-config.cjs fetches on every real-usage command (see bin/sidewrite's
// _sw_force_update_gate, called unconditionally, not opt-in).
//
// Client contract: GET, JSON body of exactly { flags, minVersion, killSwitch }.
// The client never trusts unknown shape — mergeWithDefaults() in
// remote-config.cjs falls back to safe defaults (flags:{}, minVersion:null,
// killSwitch:false) for anything missing or malformed, and any network/parse
// error there also falls back to cache-or-defaults. So this endpoint being
// slow, down, or returning garbage never blocks a run — it can only ever make
// the CLI request an update or refuse to proceed, never crash it.
//
// Values are read from env vars (set in the Vercel project settings) so a
// forced update or kill switch can be flipped without a code change or
// redeploy — just edit the env var and it's live within REMOTE_CONFIG_MAX_AGE
// seconds. Defaults are the safe no-op values: no forced version, no kill
// switch, so standing this endpoint up does nothing until deliberately set.

const MAX_AGE_SECONDS = 60;

function readMinVersion() {
  const v = process.env.REMOTE_CONFIG_MIN_VERSION;
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v.trim()) ? v.trim() : null;
}

function readKillSwitch() {
  return process.env.REMOTE_CONFIG_KILL_SWITCH === 'true';
}

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'GET only' });
    return;
  }

  const body = {
    flags: {},
    minVersion: readMinVersion(),
    killSwitch: readKillSwitch(),
  };

  res.setHeader('Cache-Control', `public, max-age=${MAX_AGE_SECONDS}`);
  res.status(200).json(body);
}
