#!/usr/bin/env node
/**
 * Extracts the release notes for a given version from CHANGELOG.md.
 * Prints markdown containing the version header (e.g. "## [2.1.0] - 2026-09-09")
 * to stdout, ready to be used as a GitHub Release body.
 *
 * Usage:
 *   node scripts/extract-release-notes.js 2.1.0
 *   node scripts/extract-release-notes.js            # falls back to package.json version
 */

const fs = require('fs');
const path = require('path');

const changelogPath = path.resolve(__dirname, '..', 'CHANGELOG.md');
const packagePath = path.resolve(__dirname, '..', 'package.json');

function normalize(version) {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .replace(/^\[+|\]+$/g, '');
}

const requested =
  normalize(process.argv[2]) ||
  normalize(JSON.parse(fs.readFileSync(packagePath, 'utf8')).version);

if (!requested) {
  console.error('[ShotShorts] No version requested and package.json has no version.');
  process.exit(1);
}

const changelog = fs.readFileSync(changelogPath, 'utf8');
const lines = changelog.split(/\r?\n/);

const headingRegex = /^##\s+\[?([^\]]+)\]?\s*(?:-\s*(.*))?$/;
let capturing = false;
let found = false;
const captured = [];

for (const line of lines) {
  const match = line.match(headingRegex);
  if (match) {
    if (capturing) break; // reached the next "## " section — stop
    const headingVersion = normalize(match[1]);
    if (headingVersion === requested) {
      capturing = true;
      found = true;
      captured.push(`## ShotShorts v${requested}${match[2] ? ` (${match[2].trim()})` : ''}`);
      continue;
    }
  } else if (capturing) {
    captured.push(line);
  }
}

if (!found) {
  console.error(`[ShotShorts] Version ${requested} not found in CHANGELOG.md`);
  process.exit(1);
}

// Trim leading/trailing blank lines, keep inner structure intact
const notes = captured.join('\n').trim();

if (!notes || notes === `## ShotShorts v${requested}`) {
  console.error(`[ShotShorts] Section for ${requested} in CHANGELOG.md is empty.`);
  process.exit(1);
}

console.log(notes);
