const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeSession,
  distanceMeters,
  euclideanDistance,
  isValidMobile,
  normalizeMobile,
  sessionLabel,
} = require('../server');

test('normalizes and validates Indian 10-digit mobile numbers', () => {
  assert.equal(normalizeMobile('+91 98765-43210'), '919876543210');
  assert.equal(normalizeMobile('98765 43210'), '9876543210');
  assert.equal(isValidMobile('98765 43210'), true);
  assert.equal(isValidMobile('987654321'), false);
  assert.equal(isValidMobile('abcdefghij'), false);
});

test('calculates geographical distance accurately enough for the venue fence', () => {
  assert.equal(distanceMeters(25.3381956, 74.6158152, 25.3381956, 74.6158152), 0);
  assert.ok(Math.abs(distanceMeters(0, 0, 0, 1) - 111195) < 100);
});

test('compares face descriptors and rejects incompatible vectors', () => {
  assert.equal(euclideanDistance([0, 0, 0], [0, 0, 0]), 0);
  assert.equal(euclideanDistance([0, 0], [3, 4]), 5);
  assert.equal(euclideanDistance([0], [0, 1]), Infinity);
});

test('identifies an always-open morning attendance window and labels sessions', () => {
  const settings = {
    morning_start: '00:00', morning_end: '23:59',
    afternoon_start: '00:00', afternoon_end: '00:00',
  };
  assert.equal(activeSession(settings), 'morning');
  assert.equal(sessionLabel('morning'), 'Before lunch');
  assert.equal(sessionLabel('afternoon'), 'After lunch');
});
