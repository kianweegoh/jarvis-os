#!/usr/bin/env node
// SessionStart hook for the Jarvis vault.
//
// Injects the standing context every session needs — vault/CLAUDE.md,
// vault/USER.md, vault/MEMORY.md, and the two most recent daily notes — into
// the model's context before the first prompt. This automates the "read these
// at the start of every session" protocol in vault/CLAUDE.md.
//
// Output: a JSON object on stdout with hookSpecificOutput.additionalContext.
// Claude Code injects that string as context at session start.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const vault = join(projectDir, 'vault');
const dailyDir = join(vault, 'daily');

const parts = [];

function addFile(label, path) {
  if (existsSync(path)) {
    parts.push(`===== ${label} =====\n${readFileSync(path, 'utf8').trimEnd()}`);
  }
}

addFile('vault/CLAUDE.md', join(vault, 'CLAUDE.md'));
addFile('vault/USER.md', join(vault, 'USER.md'));
addFile('vault/MEMORY.md', join(vault, 'MEMORY.md'));

// Two most recent daily notes. Filenames are YYYY-MM-DD.md, so a lexical sort
// is chronological. The strict pattern match means archived session logs and
// any other files under daily/ are never mistaken for daily notes.
let recent = [];
try {
  recent = readdirSync(dailyDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .slice(-2);
} catch {
  // daily/ may not exist yet; that's fine.
}
for (const f of recent) {
  addFile(`vault/daily/${f}`, join(dailyDir, f));
}

const context = parts.join('\n\n');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  })
);
