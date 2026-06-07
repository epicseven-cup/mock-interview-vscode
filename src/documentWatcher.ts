import * as vscode from 'vscode';

type SaveCallback = (savedPath: string) => void;

export class DocumentWatcher {
  private disposables: vscode.Disposable[] = [];
  private saveCallbacks: SaveCallback[] = [];
  private contextPaths = new Set<string>();

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const fsPath = doc.uri.fsPath;
        const matched = [...this.contextPaths].some(
          (p) => fsPath === p || fsPath.startsWith(p + require('path').sep)
        );
        if (matched) {
          this.saveCallbacks.forEach((cb) => cb(fsPath));
        }
      })
    );
  }

  setContextPaths(paths: string[]): void {
    this.contextPaths = new Set(paths);
  }

  onSave(cb: SaveCallback): void {
    this.saveCallbacks.push(cb);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
