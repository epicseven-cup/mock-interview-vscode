import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class ContextItem extends vscode.TreeItem {
  constructor(
    public readonly fsPath: string,
    isProblem = false
  ) {
    let isDir = false;
    try { isDir = fs.statSync(fsPath).isDirectory(); } catch {}
    super(path.basename(fsPath), vscode.TreeItemCollapsibleState.None);
    this.tooltip = fsPath;
    this.description = isProblem ? 'problem' : path.dirname(fsPath);
    this.iconPath = isProblem
      ? new vscode.ThemeIcon('book', new vscode.ThemeColor('charts.purple'))
      : isDir
      ? vscode.ThemeIcon.Folder
      : vscode.ThemeIcon.File;
    this.contextValue = 'contextItem';
    this.command = isDir
      ? undefined
      : { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(fsPath)] };
  }
}

export class ContextProvider implements vscode.TreeDataProvider<ContextItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private problemFiles: string[] = [];
  private solutionFiles: string[] = [];

  setProblem(fsPath: string): void {
    this.problemFiles = [fsPath];
    this._onDidChangeTreeData.fire();
  }

  add(paths: string[]): void {
    for (const p of paths) {
      if (!this.solutionFiles.includes(p)) {
        this.solutionFiles.push(p);
      }
    }
    this._onDidChangeTreeData.fire();
  }

  remove(fsPath: string): void {
    this.solutionFiles = this.solutionFiles.filter((p) => p !== fsPath);
    this.problemFiles = this.problemFiles.filter((p) => p !== fsPath);
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.solutionFiles = [];
    this._onDidChangeTreeData.fire();
  }

  clearAll(): void {
    this.solutionFiles = [];
    this.problemFiles = [];
    this._onDidChangeTreeData.fire();
  }

  getProblemFiles(): string[] {
    return [...this.problemFiles];
  }

  getSolutionFiles(): string[] {
    return [...this.solutionFiles];
  }

  getTreeItem(element: ContextItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ContextItem[] {
    return [
      ...this.problemFiles.map((p) => new ContextItem(p, true)),
      ...this.solutionFiles.map((p) => new ContextItem(p, false)),
    ];
  }
}
