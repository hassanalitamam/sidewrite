'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function _baseDir(override) {
  const home = override || os.homedir();
  return path.join(home, '.sidewrite');
}

function _filePath(override) {
  return path.join(_baseDir(override), 'install-id');
}

/**
 * Get-or-create a stable anonymous install id.
 * Returns the same UUID string on every call after the first.
 * @param {string} [homeOverride] — override HOME for testing (e.g. SIDEWRITE_HOME)
 * @returns {string} UUID v4
 */
function getInstallId(homeOverride) {
  const dir = _baseDir(homeOverride);
  const file = _filePath(homeOverride);

  // Try reading existing id
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing && UUID_RE.test(existing)) {
      return existing;
    }
    // Corrupt or empty — fall through to regenerate
  } catch {
    // File or dir missing — fall through to create
  }

  // Ensure directory exists with 0700
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Generate new id
  const id = crypto.randomUUID();

  // Atomic write: write to .tmp then rename
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, id + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);

  return id;
}

// Self-test
if (require.main === module) {
  let passed = 0;
  let failed = 0;

  function assert(cond, msg) {
    if (cond) {
      passed++;
    } else {
      failed++;
      console.error('FAIL: ' + msg);
    }
  }

  // Use a temp directory so we don't pollute real ~/.sidewrite
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidewrite-install-id-test-'));

  try {
    // 1. First call creates the file; second call returns the SAME id
    const id1 = getInstallId(tmpHome);
    const id2 = getInstallId(tmpHome);
    assert(id1 === id2, 'Second call must return the same id');

    // 2. The id looks like a UUID
    assert(UUID_RE.test(id1), 'Id must be a valid UUID v4: ' + id1);

    // 3. File mode is 0600
    const filePath = path.join(tmpHome, '.sidewrite', 'install-id');
    const fileStat = fs.statSync(filePath);
    const fileMode = (fileStat.mode & 0o777);
    assert(fileMode === 0o600, 'File mode must be 0600, got 0o' + fileMode.toString(8));

    // 4. Dir mode is 0700
    const dirPath = path.join(tmpHome, '.sidewrite');
    const dirStat = fs.statSync(dirPath);
    const dirMode = (dirStat.mode & 0o777);
    assert(dirMode === 0o700, 'Dir mode must be 0700, got 0o' + dirMode.toString(8));

    // 5. Corrupt file → regenerates cleanly
    fs.writeFileSync(filePath, 'not-a-uuid', { mode: 0o600 });
    const id3 = getInstallId(tmpHome);
    assert(UUID_RE.test(id3), 'Corrupt file must regenerate a valid UUID');
    assert(id3 !== id1, 'Regenerated id should differ from original');

    // 6. Empty file → regenerates cleanly
    fs.writeFileSync(filePath, '', { mode: 0o600 });
    const id4 = getInstallId(tmpHome);
    assert(UUID_RE.test(id4), 'Empty file must regenerate a valid UUID');

    // 7. Verifies the replaced file still reads back correctly
    const id5 = getInstallId(tmpHome);
    assert(id4 === id5, 'Read-back after empty regeneration must be stable');
  } finally {
    // Clean up temp dir
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED, ${passed} passed`);
    process.exit(1);
  }
  console.log(`PASS — all ${passed} assertions passed`);
}

module.exports = { getInstallId };
