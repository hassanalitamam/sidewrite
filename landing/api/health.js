// Vercel serverless function — health check endpoint for Supabase reachability.
//
// Used by the future verification/canary loop to confirm that the Supabase
// backend is reachable and responding to queries. This endpoint performs a
// trivial read from the version_config_public view (the only anon-readable
// table/view in the schema) and reports the result.
//
// Response:
// - Status 200 always (this endpoint reports health, doesn't fail itself).
// - If Supabase is reachable: { ok: true, supabase: 'reachable' }
// - If unreachable or errored: { ok: false, supabase: 'unreachable', error: '...' }
//
// Monitoring scripts should read the ok field, not interpret HTTP status as
// a health signal (the endpoint never 5xxes).

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      res.status(200).json({
        ok: false,
        supabase: 'unreachable',
        error: 'missing env vars (SUPABASE_URL, SUPABASE_ANON_KEY)',
      });
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey);

    // Perform a trivial read from version_config_public view (anon-readable).
    // This tests actual Supabase connectivity without attempting to read any
    // admin-only tables.
    const { data, error } = await supabase
      .from('version_config_public')
      .select('current_version')
      .limit(1);

    if (error) {
      res.status(200).json({
        ok: false,
        supabase: 'unreachable',
        error: String(error.message || error),
      });
      return;
    }

    res.status(200).json({
      ok: true,
      supabase: 'reachable',
    });
  } catch (err) {
    // Catch any uncaught errors (Supabase client construction, etc.) and
    // report them as unreachable without 5xxing.
    res.status(200).json({
      ok: false,
      supabase: 'unreachable',
      error: String(err.message || err),
    });
  }
}
