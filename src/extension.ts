import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ContextProvider, ContextItem } from './contextProvider';
import { AiPanel } from './aiPanel';
import { callAi, ChatMessage, InterviewerMode, fetchClaudeModels, fetchOllamaModels } from './aiService';
import { gatherContextFiles, getDiagnosticsText, buildContextMessage } from './contextBuilder';
import { scanAllProblems, scanWorkingInterviews, watchForProblems, Problem, WorkingInterview } from './problemScanner';

async function runAi(
  panel: AiPanel,
  history: ChatMessage[],
  label: string,
  mode: InterviewerMode,
  apiKey: string,
  log?: vscode.OutputChannel
): Promise<void> {
  panel.showThinking(label);
  const token = panel.getCancelToken();
  let response = '';
  try {
    log?.appendLine(`runAi: calling AI with ${history.length} messages, mode=${mode}`);
    await callAi(history, (chunk) => { response += chunk; }, token, mode, apiKey);
    log?.appendLine(`runAi: done, response length=${response.length}`);
    panel.showMessage(label, response);
    history.push({ role: 'assistant', content: response });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.appendLine(`runAi ERROR: ${msg}`);
    panel.showError(msg);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Mock Interview');
  context.subscriptions.push(log);
  log.appendLine('Extension activated');

  // One-time migration: move API key from plaintext settings to SecretStorage.
  // We can't clear the old setting (it's no longer registered), but we only
  // migrate when secrets is empty so this only runs once.
  {
    const existing = await context.secrets.get('mockInterview.apiKey');
    if (!existing) {
      const legacyKey = vscode.workspace.getConfiguration('mockInterview').get<string>('apiKey', '');
      if (legacyKey) {
        await context.secrets.store('mockInterview.apiKey', legacyKey);
        log.appendLine('Migrated API key from settings to SecretStorage');
      }
    }
  }

  let cachedApiKey = (await context.secrets.get('mockInterview.apiKey')) ?? '';

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(eye) Ready for Review';
  statusBar.tooltip = 'Request AI review of your current solution';
  statusBar.command = 'mockInterview.requestReview';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const provider = new ContextProvider();
  const treeView = vscode.window.createTreeView('mockInterviewContext', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  const history: ChatMessage[] = [];
  let mode: InterviewerMode = 'hint';
  const snapshots = new Map<string, string>();
  let problemSent = false;

  function currentModelLabel(): string {
    const config = vscode.workspace.getConfiguration('mockInterview');
    const p = config.get<string>('aiProvider', 'vscode-lm');
    if (p === 'claude') return `claude: ${config.get<string>('claudeModel', 'sonnet-4-5').replace('claude-', '')}`;
    if (p === 'ollama') return `ollama: ${config.get<string>('ollamaModel', 'llama3')}`;
    return 'copilot';
  }

  function resetSession() {
    history.length = 0;
    snapshots.clear();
    problemSent = false;
  }

  function setupPanelHandlers(panel: AiPanel) {
    panel.onUserMessage((text) => {
      log.appendLine(`User message: ${text}`);
      panel.showMessage('You', text, 'user');
      history.push({ role: 'user', content: text });
      runAi(panel, history, 'Interviewer', mode, cachedApiKey, log);
    });
    panel.onReviewRequest(() => {
      log.appendLine('Review requested from panel');
      triggerAi('review');
    });
    panel.onModeChange((newMode) => {
      mode = newMode as InterviewerMode;
      resetSession();
      log.appendLine(`Mode changed to: ${mode}`);
    });
    panel.onSelectModel(() => {
      const p = vscode.workspace.getConfiguration('mockInterview').get<string>('aiProvider', 'vscode-lm');
      const cmd = p === 'claude' ? 'mockInterview.selectClaudeModel'
                : p === 'ollama' ? 'mockInterview.selectOllamaModel'
                : 'mockInterview.selectMode';
      vscode.commands.executeCommand(cmd).then(() => {
        panel.setModelLabel(currentModelLabel());
      });
    });
    panel.setMode(mode);
    panel.setModelLabel(currentModelLabel());
  }

  const triggerAi = (trigger: 'review' | 'build' | 'start') => {
    const problemFiles = gatherContextFiles(provider.getProblemFiles());
    const solutionFiles = gatherContextFiles(provider.getSolutionFiles());
    log.appendLine(`triggerAi(${trigger}) — problem: ${problemFiles.length}, solution: ${solutionFiles.length}`);

    if (!problemFiles.length && !solutionFiles.length) {
      vscode.window.showWarningMessage('No files in context. Start or resume an interview first.');
      return;
    }

    const diagnostics = trigger === 'build' ? getDiagnosticsText() : '';
    const userMsg = buildContextMessage(problemFiles, solutionFiles, diagnostics, trigger, snapshots, problemSent);
    history.push({ role: 'user', content: userMsg });

    problemSent = true;
    for (const f of solutionFiles) snapshots.set(f.path, f.content);

    const cfg = vscode.workspace.getConfiguration('mockInterview');
    log.appendLine(`AI provider: ${cfg.get('aiProvider')} | model: ${cfg.get('ollamaModel')} | key set: ${!!cachedApiKey}`);

    const label = trigger === 'start' ? 'Interview started' : trigger === 'build' ? 'Build completed' : 'Review';
    const panel = AiPanel.createOrShow(context.extensionUri);
    setupPanelHandlers(panel);
    runAi(panel, history, label, mode, cachedApiKey, log);
  };

  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.group === vscode.TaskGroup.Build) {
        setTimeout(() => triggerAi('build'), 500);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.requestReview', () => triggerAi('review'))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.openAiPanel', () => {
      const panel = AiPanel.createOrShow(context.extensionUri);
      setupPanelHandlers(panel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.selectMode', async () => {
      const options = [
        { label: '$(flame) Harsh', description: 'Strict, no hints, brutally honest', value: 'harsh' as InterviewerMode },
        { label: '$(lightbulb) Hint', description: 'Supportive, gives hints, encouraging', value: 'hint' as InterviewerMode },
        { label: '$(comment-discussion) Follow-up', description: 'Socratic, probes with relentless questions', value: 'followup' as InterviewerMode },
      ];
      const picked = await vscode.window.showQuickPick(
        options.map((o) => ({ ...o, picked: o.value === mode })),
        { placeHolder: 'Select interviewer mode' }
      );
      if (picked) {
        mode = picked.value;
        resetSession();
        AiPanel.currentPanel?.setMode(mode);
        vscode.window.showInformationMessage(`Interviewer mode: ${picked.label}. Conversation reset.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.addToContext', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        openLabel: 'Add to Interview Context',
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      });
      if (uris?.length) {
        provider.add(uris.map((u) => u.fsPath));
        triggerAi('start');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.removeFromContext', (item: ContextItem) => {
      provider.remove(item.fsPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.clearSession', async () => {
      const solutionPaths = provider.getSolutionFiles();
      const workingDir = solutionPaths.length > 0 ? path.dirname(solutionPaths[0]) : undefined;
      const isWorkingDir = workingDir && path.basename(workingDir).startsWith('working-mock-interview-');

      const options = ['Clear Context Only', ...(isWorkingDir ? ['Delete Working Files Too'] : [])];
      const choice = await vscode.window.showWarningMessage(
        'End this interview session?',
        { modal: true },
        ...options
      );
      if (!choice) return;

      resetSession();
      provider.clearAll();

      if (choice === 'Delete Working Files Too' && workingDir) {
        try {
          fs.rmSync(workingDir, { recursive: true, force: true });
          log.appendLine(`Deleted working dir: ${workingDir}`);
          vscode.window.showInformationMessage(`Session cleared and ${path.basename(workingDir)}/ deleted.`);
        } catch (err) {
          vscode.window.showErrorMessage(`Could not delete ${workingDir}: ${err}`);
        }
      } else {
        vscode.window.showInformationMessage('Session cleared. Your working files are kept.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.clearContext', () => provider.clear())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.setupClaude', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Setup Claude',
        prompt: cachedApiKey ? 'API key is already set. Paste a new key to replace it.' : 'Enter your Anthropic API key',
        password: true,
        placeHolder: 'sk-ant-...',
        validateInput: (v) => v.trim().length < 10 ? 'Key looks too short' : undefined,
      });
      if (key === undefined) return;
      cachedApiKey = key.trim();
      await context.secrets.store('mockInterview.apiKey', cachedApiKey);
      await vscode.workspace.getConfiguration('mockInterview').update('aiProvider', 'claude', vscode.ConfigurationTarget.Global);
      vscode.commands.executeCommand('mockInterview.selectClaudeModel');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.selectClaudeModel', async () => {
      if (!cachedApiKey) {
        vscode.window.showErrorMessage('Set your API key first — run Mock Interview: Setup Claude.');
        return;
      }
      const models = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching Claude models...' },
        () => fetchClaudeModels(cachedApiKey)
      );
      const cfg = vscode.workspace.getConfiguration('mockInterview');
      const current = cfg.get<string>('claudeModel', 'claude-sonnet-4-5');
      const picked = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m, description: m === current ? '(current)' : '' })),
        { placeHolder: 'Select Claude model' }
      );
      if (!picked) return;
      await cfg.update('claudeModel', picked.label, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Claude model set to: ${picked.label}`);
      AiPanel.currentPanel?.setModelLabel(currentModelLabel());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.selectOllamaModel', async () => {
      const config = vscode.workspace.getConfiguration('mockInterview');
      const ollamaUrl = config.get<string>('ollamaUrl', 'http://localhost:11434');
      const models = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching Ollama models...' },
        () => fetchOllamaModels(ollamaUrl)
      );
      if (!models.length) {
        vscode.window.showErrorMessage(`No Ollama models found at ${ollamaUrl}. Is Ollama running?`);
        return;
      }
      const current = config.get<string>('ollamaModel', '');
      const picked = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m, description: m === current ? '(current)' : '' })),
        { placeHolder: 'Select Ollama model' }
      );
      if (picked) {
        await config.update('ollamaModel', picked.label, vscode.ConfigurationTarget.Global);
        await config.update('aiProvider', 'ollama', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Ollama model set to: ${picked.label}`);
        AiPanel.currentPanel?.setModelLabel(currentModelLabel());
      }
    })
  );

  const resumeInterview = (working: WorkingInterview) => {
    log.appendLine(`resumeInterview: ${working.solutionDir}`);
    if (working.problemFile) provider.setProblem(working.problemFile);
    provider.clear();
    if (working.solutionFiles.length) {
      provider.add(working.solutionFiles);
      vscode.window.showTextDocument(vscode.Uri.file(working.solutionFiles[0]));
    }
    vscode.window.showInformationMessage(
      `Resumed: "${working.label}" — click Ready for Review when you want feedback.`
    );
  };

  const startInterview = async (problem: Problem) => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showWarningMessage('Open a folder in VS Code first so the interview files can be created there.');
      return;
    }

    const problemName = path.basename(problem.dir).replace(/^mock-interview-problems-/, '');
    const solutionDir = path.join(workspaceRoot, `working-mock-interview-${problemName}`);

    if (fs.existsSync(solutionDir)) {
      const choice = await vscode.window.showInformationMessage(
        `You already have a working session for "${problem.label}".`,
        'Resume',
        'Start Fresh'
      );
      if (!choice || choice === 'Resume') {
        const solutionFiles = fs.readdirSync(solutionDir)
          .map((f) => path.join(solutionDir, f))
          .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
        const problemDir = path.join(workspaceRoot, '.mock-interviews', path.basename(problem.dir));
        const resolvedProblemFile = path.join(problemDir, path.basename(problem.problemFile));
        const problemFile = fs.existsSync(resolvedProblemFile) ? resolvedProblemFile : problem.problemFile;
        resumeInterview({ name: problemName, label: problem.label, solutionDir, solutionFiles, problemFile });
        return;
      }
      fs.rmSync(solutionDir, { recursive: true, force: true });
      log.appendLine(`Deleted existing working dir: ${solutionDir}`);
    }

    const problemDir = path.join(workspaceRoot, '.mock-interviews', path.basename(problem.dir));
    const isGlobal = !problem.dir.startsWith(workspaceRoot);
    if (isGlobal && !fs.existsSync(problemDir)) {
      fs.mkdirSync(problemDir, { recursive: true });
      fs.copyFileSync(problem.problemFile, path.join(problemDir, path.basename(problem.problemFile)));
    }

    fs.mkdirSync(solutionDir, { recursive: true });
    const copiedSolutionFiles: string[] = [];
    for (const file of problem.solutionFiles) {
      const dest = path.join(solutionDir, path.basename(file));
      fs.copyFileSync(file, dest);
      copiedSolutionFiles.push(dest);
    }

    const resolvedProblemFile = path.join(problemDir, path.basename(problem.problemFile));
    const activeProblem = { ...problem, dir: solutionDir, problemFile: resolvedProblemFile, solutionFiles: copiedSolutionFiles };

    vscode.window.showInformationMessage(`Interview started — edit files in ${path.basename(solutionDir)}/`);
    provider.setProblem(activeProblem.problemFile);
    provider.clear();
    if (activeProblem.solutionFiles.length) {
      provider.add(activeProblem.solutionFiles);
      vscode.window.showTextDocument(vscode.Uri.file(activeProblem.solutionFiles[0]));
    }
    resetSession();
    triggerAi('start');
  };

  const promptForProblem = async (problem: Problem) => {
    const choice = await vscode.window.showInformationMessage(
      `Mock interview problem found: "${problem.label}" — start this interview?`,
      'Start Interview',
      'Dismiss'
    );
    if (choice === 'Start Interview') startInterview(problem);
  };

  const workingSessions = scanWorkingInterviews();
  if (workingSessions.length === 1) {
    resumeInterview(workingSessions[0]);
  } else if (workingSessions.length > 1) {
    vscode.window.showQuickPick(
      workingSessions.map((w) => ({ label: w.label, detail: w.solutionDir, working: w })),
      { placeHolder: 'Multiple in-progress interviews found — pick one to resume' }
    ).then((picked) => { if (picked) resumeInterview(picked.working); });
  } else {
    const problems = scanAllProblems();
    if (problems.length === 1) {
      promptForProblem(problems[0]);
    } else if (problems.length > 1) {
      vscode.window.showQuickPick(
        problems.map((p) => ({ label: p.label, detail: p.dir, problem: p })),
        { placeHolder: 'Multiple interview problems found — pick one to start' }
      ).then((picked) => { if (picked) promptForProblem(picked.problem); });
    }
  }

  context.subscriptions.push(
    watchForProblems((problem) => promptForProblem(problem))
  );
}

export function deactivate() {}
