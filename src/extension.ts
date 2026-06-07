import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { ContextProvider, ContextItem } from './contextProvider';
import { AiPanel } from './aiPanel';
import { callAi, ChatMessage, InterviewerMode } from './aiService';
import { scanAllProblems, scanWorkingInterviews, watchForProblems, Problem, WorkingInterview } from './problemScanner';

function gatherContextFiles(paths: string[]): { path: string; content: string }[] {
  const result: { path: string; content: string }[] = [];
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

function getDiagnosticsText(): string {
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

function buildContextMessage(
  problemFiles: { path: string; content: string }[],
  solutionFiles: { path: string; content: string }[],
  diagnostics: string,
  trigger: 'review' | 'build' | 'start'
): string {
  const problemSection = problemFiles.length
    ? `## Problem Statement\n\n${problemFiles.map((f) => f.content).join('\n\n')}\n\n`
    : '';

  const solutionSection = solutionFiles.length
    ? `## Candidate's Solution\n\n${solutionFiles.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')}`
    : '(No solution files added yet)';

  const diagSection = diagnostics ? `\n\n## Build Output / Diagnostics\n${diagnostics}` : '';

  const triggerNote =
    trigger === 'start'
      ? `The interview is beginning. Look at the problem statement and the candidate's current code. React to what you actually see — comment on their starting point, what's there, what's obviously missing, and ask them something specific about their approach. Don't give a structured breakdown. Just respond like you're sitting across from them for the first time.`
      : trigger === 'build'
      ? `The candidate just ran a build and there are diagnostics. React to the errors like a real interviewer watching them compile — call out what's broken, ask them if they see why, and let them work through it.`
      : `The candidate just said they're ready for feedback. Look at their current code against the problem requirements and respond like a real interviewer who's been watching them work. React to what you see — what they got right, what's still off, and push them on something specific.`;

  return `${triggerNote}\n\n${problemSection}${solutionSection}${diagSection}`;
}

async function runAi(
  panel: AiPanel,
  history: ChatMessage[],
  label: string,
  mode: InterviewerMode,
  log?: vscode.OutputChannel
): Promise<void> {
  panel.showThinking(label);
  const token = panel.getCancelToken();
  let response = '';
  try {
    log?.appendLine(`runAi: calling AI with ${history.length} messages, mode=${mode}`);
    await callAi(history, (chunk) => { response += chunk; }, token, mode);
    log?.appendLine(`runAi: done, response length=${response.length}`);
    panel.showMessage(label, response);
    history.push({ role: 'assistant', content: response });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.appendLine(`runAi ERROR: ${msg}`);
    panel.showError(msg);
  }
}

async function fetchClaudeModels(apiKey: string): Promise<string[]> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/models',
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c.toString()));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const ids: string[] = (json.data as { id: string }[])
            .map((m) => m.id)
            .filter((id) => id.startsWith('claude-'));
          resolve(ids.length ? ids : FALLBACK_CLAUDE_MODELS);
        } catch {
          resolve(FALLBACK_CLAUDE_MODELS);
        }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(FALLBACK_CLAUDE_MODELS); });
    req.on('error', () => resolve(FALLBACK_CLAUDE_MODELS));
    req.end();
  });
}

const FALLBACK_CLAUDE_MODELS = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  const url = new globalThis.URL('/api/tags', baseUrl);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    transport
      .get(url.toString(), (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve((json.models as { name: string }[]).map((m) => m.name));
          } catch {
            resolve([]);
          }
        });
      })
      .on('error', () => resolve([]));
  });
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Mock Interview');
  context.subscriptions.push(log);
  log.appendLine('Extension activated');

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

  function currentModelLabel(): string {
    const config = vscode.workspace.getConfiguration('mockInterview');
    const provider = config.get<string>('aiProvider', 'vscode-lm');
    if (provider === 'claude') return `claude: ${config.get<string>('claudeModel', 'sonnet-4-5').replace('claude-', '')}`;
    if (provider === 'ollama') return `ollama: ${config.get<string>('ollamaModel', 'llama3')}`;
    return 'copilot';
  }

  function syncModelLabel() {
    AiPanel.currentPanel?.setModelLabel(currentModelLabel());
  }

  const triggerAi = (trigger: 'review' | 'build' | 'start') => {
    const problemFiles = gatherContextFiles(provider.getProblemFiles());
    const solutionFiles = gatherContextFiles(provider.getSolutionFiles());
    log.appendLine(`triggerAi(${trigger}) — problem: ${problemFiles.length}, solution: ${solutionFiles.length}`);
    if (!problemFiles.length && !solutionFiles.length) {
      log.appendLine('No context files — skipping AI call');
      vscode.window.showWarningMessage('No files in context. Start or resume an interview first.');
      return;
    }
    const diagnostics = trigger === 'build' ? getDiagnosticsText() : '';
    const userMsg = buildContextMessage(problemFiles, solutionFiles, diagnostics, trigger);
    history.push({ role: 'user', content: userMsg });

    const config = vscode.workspace.getConfiguration('mockInterview');
    log.appendLine(`AI provider: ${config.get('aiProvider')} | model: ${config.get('ollamaModel')} | key set: ${!!config.get('apiKey')}`);

    const label = trigger === 'start' ? 'Interview started' : trigger === 'build' ? 'Build completed' : 'Review';
    const panel = AiPanel.createOrShow(context.extensionUri);

    panel.onUserMessage((text) => {
      log.appendLine(`User message: ${text}`);
      panel.showMessage('You', text, 'user');
      history.push({ role: 'user', content: text });
      runAi(panel, history, 'Interviewer', mode, log);
    });

    panel.onReviewRequest(() => {
      log.appendLine('Review requested from panel');
      triggerAi('review');
    });

    panel.onModeChange((newMode) => {
      mode = newMode as InterviewerMode;
      history.length = 0;
      log.appendLine(`Mode changed to: ${mode}`);
    });

    panel.onSelectModel(() => {
      const provider = vscode.workspace.getConfiguration('mockInterview').get<string>('aiProvider', 'vscode-lm');
      const cmd = provider === 'claude' ? 'mockInterview.selectClaudeModel'
                : provider === 'ollama' ? 'mockInterview.selectOllamaModel'
                : 'mockInterview.selectMode';
      vscode.commands.executeCommand(cmd).then(() => syncModelLabel());
    });

    panel.setMode(mode);
    panel.setModelLabel(currentModelLabel());
    runAi(panel, history, label, mode, log);
  };

  // Trigger AI after build task finishes
  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.group === vscode.TaskGroup.Build) {
        setTimeout(() => triggerAi('build'), 500);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.requestReview', () => {
      triggerAi('review');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.openAiPanel', () => {
      const panel = AiPanel.createOrShow(context.extensionUri);
      panel.onUserMessage((text) => {
        panel.showMessage('You', text, 'user');
        history.push({ role: 'user', content: text });
        runAi(panel, history, 'Interviewer', mode, log);
      });
      panel.onReviewRequest(() => triggerAi('review'));
      panel.onModeChange((newMode) => {
        mode = newMode as InterviewerMode;
        history.length = 0;
      });
      panel.onSelectModel(() => {
        const provider = vscode.workspace.getConfiguration('mockInterview').get<string>('aiProvider', 'vscode-lm');
        const cmd = provider === 'claude' ? 'mockInterview.selectClaudeModel'
                  : provider === 'ollama' ? 'mockInterview.selectOllamaModel'
                  : 'mockInterview.selectMode';
        vscode.commands.executeCommand(cmd).then(() => syncModelLabel());
      });
      panel.setMode(mode);
      panel.setModelLabel(currentModelLabel());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.selectMode', async () => {
      const options: { label: string; description: string; value: InterviewerMode }[] = [
        { label: '$(flame) Harsh', description: 'Strict, no hints, brutally honest', value: 'harsh' },
        { label: '$(lightbulb) Hint', description: 'Supportive, gives hints, encouraging', value: 'hint' },
        { label: '$(comment-discussion) Follow-up', description: 'Socratic, probes with relentless questions', value: 'followup' },
      ];
      const picked = await vscode.window.showQuickPick(
        options.map((o) => ({ ...o, picked: o.value === mode })),
        { placeHolder: 'Select interviewer mode' }
      );
      if (picked) {
        mode = picked.value;
        history.length = 0;
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

      history.length = 0;
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
    vscode.commands.registerCommand('mockInterview.clearContext', () => {
      provider.clear();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.setupClaude', async () => {
      const config = vscode.workspace.getConfiguration('mockInterview');
      const current = config.get<string>('apiKey', '');
      const key = await vscode.window.showInputBox({
        title: 'Setup Claude',
        prompt: 'Enter your Anthropic API key',
        value: current,
        password: true,
        placeHolder: 'sk-ant-...',
        validateInput: (v) => v.trim().length < 10 ? 'Key looks too short' : undefined,
      });
      if (key === undefined) return;
      await config.update('apiKey', key.trim(), vscode.ConfigurationTarget.Global);
      await config.update('aiProvider', 'claude', vscode.ConfigurationTarget.Global);

      // Immediately offer model selection
      vscode.commands.executeCommand('mockInterview.selectClaudeModel');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mockInterview.selectClaudeModel', async () => {
      const config = vscode.workspace.getConfiguration('mockInterview');
      const apiKey = config.get<string>('apiKey', '');
      if (!apiKey) {
        vscode.window.showErrorMessage('Set your API key first — run Mock Interview: Setup Claude.');
        return;
      }

      const models = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching Claude models...' },
        () => fetchClaudeModels(apiKey)
      );

      const current = config.get<string>('claudeModel', 'claude-sonnet-4-5');
      const picked = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m, description: m === current ? '(current)' : '' })),
        { placeHolder: 'Select Claude model' }
      );
      if (!picked) return;

      await config.update('claudeModel', picked.label, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Claude model set to: ${picked.label}`);
      syncModelLabel();
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
        syncModelLabel();
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
    history.length = 0;
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

  // On activation: resume existing sessions first, then check for new problem templates
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
