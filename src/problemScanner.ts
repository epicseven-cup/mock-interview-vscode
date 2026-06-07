import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const GLOBAL_PROBLEMS_DIR = path.join(os.homedir(), '.mock-interviews');

export interface Problem {
  label: string;
  dir: string;
  problemFile: string;
  solutionFiles: string[];
}

function loadProblemFromDir(dir: string): Problem | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));
  if (!mdFiles.length) return null;

  const problemFile = path.join(dir, mdFiles[0].name);
  const solutionFiles = entries
    .filter((e) => e.isFile() && !e.name.endsWith('.md'))
    .map((e) => path.join(dir, e.name));

  const label = path.basename(dir)
    .replace(/^mock-interview-problems-/, '')
    .replace(/-/g, ' ');

  return { label, dir, problemFile, solutionFiles };
}

function scanDir(dir: string): Problem[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('mock-interview-problems-'))
      .map((e) => loadProblemFromDir(path.join(dir, e.name)))
      .filter((p): p is Problem => p !== null);
  } catch {
    return [];
  }
}

export function scanLocalProblems(): Problem[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.flatMap((f) =>
    scanDir(path.join(f.uri.fsPath, '.mock-interviews'))
  );
}

export function scanGlobalProblems(): Problem[] {
  return scanDir(GLOBAL_PROBLEMS_DIR);
}

export function scanAllProblems(): Problem[] {
  const local = scanLocalProblems();
  return local.length ? local : scanGlobalProblems();
}

export interface WorkingInterview {
  name: string;
  label: string;
  solutionDir: string;
  solutionFiles: string[];
  problemFile: string | null;
}

export function scanWorkingInterviews(): WorkingInterview[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const result: WorkingInterview[] = [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('working-mock-interview-')) continue;
      const name = e.name.replace(/^working-mock-interview-/, '');
      const solutionDir = path.join(root, e.name);
      let solutionFiles: string[];
      try {
        solutionFiles = fs.readdirSync(solutionDir)
          .map((f) => path.join(solutionDir, f))
          .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
      } catch { continue; }
      // Find matching problem.md: check local .mock-interviews first, then global
      const localProblemDir = path.join(root, '.mock-interviews', `mock-interview-problems-${name}`);
      const globalProblemDir = path.join(GLOBAL_PROBLEMS_DIR, `mock-interview-problems-${name}`);
      let problemFile: string | null = null;
      for (const dir of [localProblemDir, globalProblemDir]) {
        try {
          const md = fs.readdirSync(dir).find((f) => f.endsWith('.md'));
          if (md) { problemFile = path.join(dir, md); break; }
        } catch {}
      }
      result.push({ name, label: name.replace(/-/g, ' '), solutionDir, solutionFiles, problemFile });
    }
  }
  return result;
}

export function watchForProblems(
  onFound: (problem: Problem) => void
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const folders = vscode.workspace.workspaceFolders ?? [];

  for (const folder of folders) {
    const pattern = new vscode.RelativePattern(folder, '.mock-interviews/**');
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    w.onDidCreate((uri) => {
      const dir = path.dirname(uri.fsPath);
      // Only trigger when a problem.md is added
      if (path.basename(uri.fsPath).endsWith('.md')) {
        const problem = loadProblemFromDir(dir);
        if (problem) onFound(problem);
      }
    });
    disposables.push(w);
  }

  return { dispose: () => disposables.forEach((d) => d.dispose()) };
}
