import { describe, expect, test } from 'bun:test';
import { parseSemver, isNewerVersion } from '../../src/update/semver.js';

describe('parseSemver', () => {
  test('parses a bare version', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  test('strips a leading v', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  test('ignores a pre-release/build suffix', () => {
    expect(parseSemver('v1.2.3-rc1')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  test('returns undefined for garbage', () => {
    expect(parseSemver('not-a-version')).toBeUndefined();
    expect(parseSemver('')).toBeUndefined();
    expect(parseSemver('1.2')).toBeUndefined();
  });
});

describe('isNewerVersion', () => {
  test('major/minor/patch each independently make a version newer', () => {
    expect(isNewerVersion('v2.0.0', 'v1.9.9')).toBe(true);
    expect(isNewerVersion('v1.3.0', 'v1.2.9')).toBe(true);
    expect(isNewerVersion('v1.2.4', 'v1.2.3')).toBe(true);
  });
  test('an equal or older version is not newer', () => {
    expect(isNewerVersion('v1.2.3', 'v1.2.3')).toBe(false);
    expect(isNewerVersion('v1.2.2', 'v1.2.3')).toBe(false);
  });
  test('mixed v-prefix and bare both compare correctly', () => {
    expect(isNewerVersion('1.2.4', 'v1.2.3')).toBe(true);
  });
  test('an unparseable candidate or current is never newer', () => {
    expect(isNewerVersion('garbage', 'v1.2.3')).toBe(false);
    expect(isNewerVersion('v1.2.4', 'garbage')).toBe(false);
  });
});
