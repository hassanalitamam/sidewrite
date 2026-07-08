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
// Values are read from the Supabase version_config_public view (which anon
// can SELECT) so a forced update or kill switch can be managed without
// redeploying this function — just update the database row and it's live
// within REMOTE_CONFIG_MAX_AGE seconds. Defaults are the safe no-op values:
// no forced version, no kill switch.

import { createClient } from '@supabase/supabase-js';

const MAX_AGE_SECONDS = 60;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'GET only' });
    return;
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { data, error } = await supabase
      .from('version_config_public')
      .select('current_version, min_version, kill_switch, flags')
      .single();

    let body;

    if (error || !data) {
      // Fail gracefully: return safe defaults if query fails
      body = {
        flags: {},
        minVersion: null,
        killSwitch: false,
      };
    } else {
      body = {
        flags: data.flags || {},
        minVersion: data.min_version || null,
        killSwitch: Boolean(data.kill_switch),
      };
    }

    res.setHeader('Cache-Control', `public, max-age=${MAX_AGE_SECONDS}`);
    res.status(200).json(body);
  } catch (err) {
    // Fail gracefully: any exception returns safe defaults
    const body = {
      flags: {},
      minVersion: null,
      killSwitch: false,
    };
    res.setHeader('Cache-Control', `public, max-age=${MAX_AGE_SECONDS}`);
    res.status(200).json(body);
  }
}
