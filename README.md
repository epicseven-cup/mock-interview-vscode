# Mock Interview

AI-powered mock coding interviews inside VS Code. Drop in a problem set, write your solution, and get feedback from a configurable AI interviewer — harsh, hint-giving, or Socratic. Sessions persist across restarts so your work is never lost.

---

## Quick start

1. Create a problem folder inside `~/.mock-interviews/` (global) or your workspace's `.mock-interviews/` folder:
   ```
   mock-interview-problems-two-sum/
   ├── problem.md       ← problem statement (required)
   └── solution.js      ← starter file(s)
   ```
2. Open VS Code — the extension auto-detects the folder and asks if you want to start.
3. Your starter files are copied to `working-mock-interview-two-sum/` in your workspace. The originals are never modified.
4. Write your solution, then click **Ready for Review** in the sidebar, status bar, or AI panel.
5. The AI interviewer responds in the chat panel. Keep coding and review again — only your changes are sent each time, not the full file.

---

## Commands

Open the Command Palette with `Ctrl+Shift+P` (`Cmd+Shift+P` on Mac) and type **Mock Interview**.

| Command | Description |
|---|---|
| **Ready for Review** | Send your current solution to the AI interviewer for feedback. |
| **Open AI Panel** | Open the interview chat panel. |
| **Select Interviewer Mode** | Switch between Harsh, Hint, and Follow-up modes. Resets the conversation. |
| **Setup Claude** | Enter your Anthropic API key and immediately select a model. Switches provider to Claude. |
| **Select Claude Model** | Change the active Claude model (fetched live from the Anthropic API). |
| **Select Ollama Model** | Pick a locally running Ollama model. Switches provider to Ollama. |
| **Add Files to Context** | Manually add files or folders to the interview context. |
| **Clear Session** | End the session and reset conversation history. Optionally delete the working directory. |

The **sidebar toolbar** (activity bar panel) also has quick-access buttons for: Ready for Review, Add Files, Open AI Panel, Clear Session, Select Ollama Model, and Select Mode.

---

## AI Panel

The panel opens in a second editor column. From top to bottom:

**Mode bar**
- **Hint / Harsh / Follow-up** pills — click to switch interviewer personality. Resets the conversation.
- **Model button** (right side) — shows the active model (`claude: sonnet-4-5`, `ollama: llama3`, `copilot`). Click to open the model/mode picker for the current provider.

**Message area** — full conversation history with the interviewer.

**Bottom bar**
- **Ready for Review** button — sends your current solution for feedback.
- **Text input** — chat with the interviewer directly. `Enter` to send, `Shift+Enter` for a new line.

---

## Interviewer modes

| Mode | Behavior |
|---|---|
| **Hint** | Supportive. Acknowledges what's working, nudges you toward the right direction without giving the answer. |
| **Harsh** | Demanding. Points out every flaw directly, refuses to give hints, challenges your decisions aggressively. |
| **Follow-up** | Socratic. Never gives answers — only asks deeper questions about your approach, complexity, and edge cases. |

Switching modes resets the conversation history.

---

## AI providers

| Provider | How to set up |
|---|---|
| **GitHub Copilot** (default) | No setup — uses your existing Copilot subscription via the VS Code LM API. |
| **Claude** | Run **Mock Interview: Setup Claude**, paste your `sk-ant-...` key, pick a model. |
| **Ollama** | Start Ollama locally, then run **Mock Interview: Select Ollama Model**. Defaults to `http://localhost:11434`. |

---

## Session lifecycle

- **Auto-detect on open** — if a `working-mock-interview-*/` directory already exists in your workspace, the session resumes automatically (context loaded, no AI triggered). If multiple sessions exist, you choose which one to resume.
- **New session** — if no working directory exists but a problem template is found, you're prompted to start. Clicking Start copies the template files into a new working directory and sends the opening AI message.
- **Resume vs. Start Fresh** — if you start a problem that already has a working directory, you're asked to choose. Start Fresh deletes the working directory and recopies the template.
- **Clear Session** — resets conversation history and removes files from context. You can optionally delete the working directory entirely.

---

## Build integration

If you run a VS Code build task (`Ctrl+Shift+B`), the extension automatically sends the build output and diagnostics to the interviewer after it finishes — same as clicking Ready for Review but with compiler errors included.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `mockInterview.aiProvider` | `vscode-lm` | Active provider: `vscode-lm`, `claude`, or `ollama`. |
| `mockInterview.claudeModel` | `claude-sonnet-4-5` | Claude model ID. Set via **Select Claude Model** command. |
| `mockInterview.ollamaUrl` | `http://localhost:11434` | Ollama server URL. |
| `mockInterview.ollamaModel` | `llama3` | Ollama model name. Set via **Select Ollama Model** command. |

---

## Problem folder conventions

- Global problems: `~/.mock-interviews/mock-interview-problems-{name}/`
- Workspace problems: `.mock-interviews/mock-interview-problems-{name}/` (takes priority over global)
- Working directory: `{workspace}/working-mock-interview-{name}/` (auto-created on start, safe to delete)
- The folder name suffix becomes the display label — `mock-interview-problems-linked-list-cycle` → **linked list cycle**
