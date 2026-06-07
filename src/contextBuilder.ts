import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ContextFile {
  path: string;
  content: string;
}

export function gatherContextFiles(paths: string[]): ContextFile[] {
  const result: ContextFile[] = [];
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) {
        result.push({ path: p, content: fs.readFileSync(p, 'utf8') });
      } else if (stat.isDirectory()) {
        const files = fs.readdirSync(p).slice(0, 20);
        for (const f of files) {
          const fp = path.join(p, f);
          try {
            if (fs.statSync(fp).isFile()) {
              result.push({ path: fp, content: fs.readFileSync(fp, 'utf8') });
            }
          } catch {}
        }
      }
    } catch {}
  }
  return result;
}

export function getDiagnosticsText(): string {
  const lines: string[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    const relevant = diags.filter(
      (d) =>
        d.severity === vscode.DiagnosticSeverity.Error ||
        d.severity === vscode.DiagnosticSeverity.Warning
    );
    if (relevant.length) {
      lines.push(`${uri.fsPath}:`);
      relevant.forEach((d) => {
        const level = d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
        lines.push(`  [${level}] Line ${d.range.start.line + 1}: ${d.message}`);
      });
    }
  }
  return lines.join('\n');
}

export function diffLines(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);

  const changed = new Set<number>();
  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] !== newLines[i]) changed.add(i);
  }
  if (changed.size === 0) return '';

  const CONTEXT = 2;
  const hunks: [number, number][] = [];
  let start = -1, end = -1;
  for (let i = 0; i < maxLen; i++) {
    const near = [...changed].some((c) => Math.abs(c - i) <= CONTEXT);
    if (near) { if (start === -1) start = i; end = i; }
    else if (start !== -1) { hunks.push([start, end]); start = -1; }
  }
  if (start !== -1) hunks.push([start, end]);

  return hunks.map(([s, e]) => {
    const lines = [`@@ lines ${s + 1}–${e + 1} @@`];
    for (let i = s; i <= e; i++) {
      const o = oldLines[i] ?? '';
      const n = newLines[i] ?? '';
      if (o === n) { lines.push(`  ${n}`); }
      else { if (i < oldLines.length) lines.push(`- ${o}`); if (i < newLines.length) lines.push(`+ ${n}`); }
    }
    return lines.join('\n');
  }).join('\n...\n');
}

export function buildContextMessage(
  problemFiles: ContextFile[],
  solutionFiles: ContextFile[],
  diagnostics: string,
  trigger: 'review' | 'build' | 'start',
  snapshots: Map<string, string>,
  problemSent: boolean
): string {
  const triggerNote =
    trigger === 'start'
      ? `The interview is beginning. Look at the problem statement and the candidate's current code. React to what you actually see — comment on their starting point, what's there, what's obviously missing, and ask them something specific about their approach. Don't give a structured breakdown. Just respond like you're sitting across from them for the first time.`
      : trigger === 'build'
      ? `The candidate just ran a build and there are diagnostics. React to the errors like a real interviewer watching them compile — call out what's broken, ask them if they see why, and let them work through it.`
      : `The candidate just said they're ready for feedback. Look at their current code against the problem requirements and respond like a real interviewer who's been watching them work. React to what you see — what they got right, what's still off, and push them on something specific.`;

  const problemSection = (!problemSent && problemFiles.length)
    ? `## Problem Statement\n\n${problemFiles.map((f) => f.content).join('\n\n')}\n\n`
    : '';

  const solutionParts: string[] = [];
  for (const f of solutionFiles) {
    const prev = snapshots.get(f.path);
    if (prev === undefined) {
      solutionParts.push(`### ${path.basename(f.path)} (full)\n\`\`\`\n${f.content}\n\`\`\``);
    } else {
      const diff = diffLines(prev, f.content);
      if (diff) {
        solutionParts.push(`### ${path.basename(f.path)} (changes since last review)\n\`\`\`diff\n${diff}\n\`\`\``);
      }
    }
  }

  const solutionSection = solutionParts.length
    ? `## Candidate's Solution\n\n${solutionParts.join('\n\n')}`
    : problemSent ? '(No changes to solution files since last review.)' : '(No solution files added yet)';

  const diagSection = diagnostics ? `\n\n## Build Output / Diagnostics\n${diagnostics}` : '';

  return `${triggerNote}\n\n${problemSection}${solutionSection}${diagSection}`;
}
