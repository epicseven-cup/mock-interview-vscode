import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class ProjectedFileItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly isDir: boolean
  ) {
    const label = path.basename(filePath);
    super(
      label,
      isDir
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    this.tooltip = filePath;
    this.iconPath = isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    this.contextValue = isDir ? 'directory' : 'file';

    if (!isDir) {
      this.command = {
        command: 'mockInterview.openFile',
        title: 'Open File',
        arguments: [filePath],
      };
    }
  }
}

export class ProjectedFileProvider implements vscode.TreeDataProvider<ProjectedFileItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rootDir: string | undefined;

  refresh(dir?: string): void {
    this.rootDir = dir;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ProjectedFileItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ProjectedFileItem): ProjectedFileItem[] {
    const dir = element ? element.filePath : this.rootDir;

    if (!dir) {
      return [];
    }

    if (!fs.existsSync(dir)) {
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .map((e) => new ProjectedFileItem(path.join(dir, e.name), e.isDirectory()));
  }
}
