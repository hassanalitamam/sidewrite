'use strict';

/*
 * sidewrite — programmatic entry point.
 *
 * `require('sidewrite')` exposes the resolved paths, data locations, and a few
 * best-effort helpers around the viewer daemon. Everything the CLI and plugin
 * do is available here so the package doubles as a small library.
 *
 * The heavy lifting lives in the (CommonJS) scripts under plugin/scripts and
 * the shell entry points under bin/. This module intentionally has no external
 * dependencies.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT_DIR = __dirname;
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const PLUGIN_DIR = path.join(ROOT_DIR, 'plugin');
const SCRIPTS_DIR = path.join(PLUGIN_DIR, 'scripts');
const HOME = process.env.HOME || os.homedir();
const DATA_DIR = path.join(HOME, '.sidewrite');

const paths = {
  root: ROOT_DIR,
  bin: BIN_DIR,
  plugin: PLUGIN_DIR,
  scripts: SCRIPTS_DIR,
  dataDir: DATA_DIR,
  daemonJson: path.join(DATA_DIR, 'daemon.json'),
  db: path.join(DATA_DIR, 'sidewrite.db'),
  activeJson: path.join(DATA_DIR, 'active.json'),
  providersDir: path.join(HOME, '.claude-providers'),
  daemon: path.join(SCRIPTS_DIR, 'viewer-daemon.cjs'),
  processManager: path.join(SCRIPTS_DIR, 'process-manager.cjs'),
  cli: path.join(SCRIPTS_DIR, 'cli.cjs'),
  sidewriteBin: path.join(BIN_DIR, 'sidewrite'),
  ccxBin: path.join(BIN_DIR, 'ccx'),
};

/** Read the running daemon's { port, pid, token } (or null if not started). */
function readDaemonInfo() {
  try {
    const obj = JSON.parse(fs.readFileSync(paths.daemonJson, 'utf8'));
    if (obj && typeof obj.port === 'number') return obj;
  } catch (_) { /* not running */ }
  return null;
}

/** The dashboard URL, or null if the daemon has never written daemon.json. */
function viewerUrl() {
  const info = readDaemonInfo();
  return info ? 'http://127.0.0.1:' + info.port : null;
}

/** Ensure the viewer daemon is running (spawns it detached if needed). */
function ensureStarted() {
  const r = spawnSync(process.execPath, [paths.processManager, 'ensure-started'], { stdio: 'ignore' });
  return r.status === 0;
}

/** Stop the viewer daemon. */
function stop() {
  const r = spawnSync(process.execPath, [paths.processManager, 'stop'], { stdio: 'ignore' });
  return r.status === 0;
}

module.exports = { paths, readDaemonInfo, viewerUrl, ensureStarted, stop };
