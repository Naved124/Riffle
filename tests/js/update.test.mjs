import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, parseVersion, summarize } from '../../flashcard_viewer/ui/js/core/updatecore.js';

const URL = 'https://github.com/Naved124/flashcard-viewer/releases/download/v1.3.0/';
const RELEASE = {
  tag_name: 'v1.3.0', body: 'notes',
  assets: [
    { name: 'FlashcardViewer-Setup-1.3.0.exe', size: 20, browser_download_url: URL + 'FlashcardViewer-Setup-1.3.0.exe' },
    { name: 'FlashcardViewer-1.3.0.apk', size: 10, digest: 'sha256:' + 'cd'.repeat(32), browser_download_url: URL + 'FlashcardViewer-1.3.0.apk' },
  ],
};

test('version comparison matches the Python updater', () => {
  assert.ok(isNewer('1.2.0', '1.1.9'));
  assert.ok(isNewer('v1.10.0', '1.9.9'));
  assert.ok(!isNewer('1.2.0', '1.2'));
  assert.ok(!isNewer('1.1.2', '1.1.2'));
  assert.ok(!isNewer('garbage', '1.0.0'));
  assert.deepEqual(parseVersion('v2.0.1-beta'), [2, 0, 1]);
});

test('android picks the APK with its checksum', () => {
  const u = summarize(RELEASE, '1.1.2', 'apk');
  assert.ok(u.newer && u.canInstall);
  assert.equal(u.asset.name, 'FlashcardViewer-1.3.0.apk');
  assert.equal(u.asset.sha256, 'cd'.repeat(32));
});

test('a release without an APK, or a browser, cannot install', () => {
  assert.equal(summarize({ ...RELEASE, assets: [RELEASE.assets[0]] }, '1.1.2', 'apk').canInstall, false);
  assert.equal(summarize(RELEASE, '1.1.2', 'none').canInstall, false);
  const foreign = { ...RELEASE, assets: [{ ...RELEASE.assets[1], browser_download_url: 'https://evil.example/FlashcardViewer-1.3.0.apk' }] };
  assert.equal(summarize(foreign, '1.1.2', 'apk').canInstall, false);
});
