#!/usr/bin/env node
// SessionEnd hook for the Jarvis vault.
//
// Archives the raw session transcript so nothing is lost on exit. Reads the
// hook payload (JSON) from stdin, then copies the transcript file that Claude
// Code already wrote (transcript_path) into vault/daily/sessions/.
//
// SessionEnd is side-effect only: it cannot inject context or block exit, so
// this hook just does the copy and stays quiet. Failures are swallowed — a
// broken archive step must never disrupt shutdown.

import { readFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readStdin() {
  try {
    return readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch {
    return '';
  }
}

let payload = {};
try {
  payload = JSON.parse(readStdin() || '{}');
} catch {
  // Malformed / empty payload — nothing to archive.
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const outDir = join(projectDir, 'vault', 'daily', 'sessions');

const src = payload.transcript_path;
if (src && existsSync(src)) {
  mkdirSync(outDir, { recursive: true });

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const reason = String(payload.reason || 'other').replace(/[^a-z0-9_-]/gi, '');
  const sid = String(payload.session_id || 'unknown').slice(0, 8);

  const dest = join(outDir, `${stamp}_${reason}_${sid}.jsonl`);
  copyFileSync(src, dest);
}
