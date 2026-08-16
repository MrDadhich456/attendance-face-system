const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('bundles every face model binary referenced by its manifest', () => {
  const modelDir = path.join(root, 'public/vendor/face-api/model');
  for (const manifest of fs.readdirSync(modelDir).filter(file => file.endsWith('manifest.json'))) {
    const entries = JSON.parse(fs.readFileSync(path.join(modelDir, manifest), 'utf8'));
    for (const modelFile of entries.flatMap(entry => entry.paths)) {
      assert.ok(fs.existsSync(path.join(modelDir, modelFile)), `${manifest} is missing ${modelFile}`);
    }
  }
});

test('uses local face assets and includes all approved registration branches', () => {
  assert.match(html, /src="\/vendor\/face-api\/face-api\.js"/);
  assert.match(html, /const MODEL_URL = '\/vendor\/face-api\/model\/'/);
  const branches = [
    'Computer Science & Engineering (IoT)', 'Information Technology',
    'Textile Chemistry', 'Textile Technology',
    'Electronics & Communication Engineering', 'Mechanical Engineering',
  ];
  for (const branch of branches) {
    const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(html, new RegExp(`>${escaped}<`));
  }
});

test('has specific status messages for recognized but rejected check-ins', () => {
  for (const reason of ['already_marked', 'outside_venue', 'attendance_closed']) {
    assert.match(server, new RegExp(`reason: '${reason}'`));
    assert.match(html, new RegExp(`${reason}: '`));
  }
});

test('does not fetch every student photo while matching a face', () => {
  assert.match(server, /SELECT id, name, branch, mobile, email, face_descriptor FROM students/);
  assert.match(server, /SELECT photo FROM students WHERE id = \$1/);
});
