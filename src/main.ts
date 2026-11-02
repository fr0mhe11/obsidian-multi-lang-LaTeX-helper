import { App, Plugin, PluginSettingTab, Setting, MarkdownView } from 'obsidian';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { exec, execFile, spawn, ChildProcess } from 'child_process';

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

interface ParsedCommand {
	raw: string;
	file: string | null;
	args: string[] | null;
}

interface MultiLangLaTeXSettings {
	autoCompleteDollar: boolean;
	strictBoundary: boolean;
	regexRange: number;
	linuxEngCmd: string;
	linuxKorCmd: string;
	windowsKeyCode: string;
}

const DEFAULT_SETTINGS: MultiLangLaTeXSettings = {
	autoCompleteDollar: true,
	strictBoundary: true,
	regexRange: 3500,
	linuxEngCmd: 'fcitx5-remote -s keyboard-us',
	linuxKorCmd: 'fcitx5-remote -s hangul',
	windowsKeyCode: '0x15',
};

export default class MultiLangLaTeXPlugin extends Plugin {
	settings: MultiLangLaTeXSettings;
	private isCurrentlyMath = false;
	private psProcess: ChildProcess | null = null;
	private lastPos = -1;
	private parsedEngCmd: ParsedCommand;
	private parsedKorCmd: ParsedCommand;

	async onload() {
		await this.loadSettings();
		console.log("🚀 LaTeX 듀얼 엔진 플러그인 로드됨 (조기 필터링 & 점프 스캔 최적화 완료)");

		this.addSettingTab(new MultiLangLaTeXSettingTab(this.app, this));

		this.registerEvent(this.app.workspace.on('file-open', () => this.checkActiveLeaf()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.checkActiveLeaf()));

		const updateListener = EditorView.updateListener.of((update) => {
			const currentPos = update.state.selection.main.head;
			if (update.docChanged || (update.selectionSet && currentPos !== this.lastPos)) {
				this.lastPos = currentPos;
				this.checkAndUpdateImeState(update.state);
			}
		});

		const customKeymap = keymap.of([
			{
				key: "$",
				run: (view) => {
					if (!this.settings.autoCompleteDollar) return false;

					const state = view.state;
					const { from, to } = state.selection.main;

					const currentName = syntaxTree(state).resolveInner(from, -1).name.toLowerCase();
					if (currentName.includes("code") || currentName.includes("frontmatter")) return false;

					if (from !== to) {
						view.dispatch({
							changes: { from, to, insert: "$" + state.sliceDoc(from, to) + "$" },
							selection: { anchor: from + 1, head: to + 1 },
						});
						return true;
					}

					const prevChar = state.sliceDoc(from - 1, from);
					const nextChar = state.sliceDoc(from, from + 1);

					if (prevChar === "\\") return false;

					if (nextChar === "$") {
						if (prevChar === "$") {
							if (this.checkMathEnvironment(state, from)) {
								view.dispatch({
									changes: { from: from - 1, to: from + 1, insert: "$$$$" },
									selection: { anchor: from + 1 },
								});
								this.setMathModeActive();
								return true;
							}
						}
						view.dispatch({ selection: { anchor: from + 1 } });
						return true;
					}

					view.dispatch({
						changes: { from, insert: "$$" },
						selection: { anchor: from + 1 },
					});
					this.setMathModeActive();
					return true;
				},
			},
			{
				key: "Backspace",
				run: (view) => {
					if (!this.settings.autoCompleteDollar) return false;

					const state = view.state;
					const { from, to } = state.selection.main;

					const currentName = syntaxTree(state).resolveInner(from, -1).name.toLowerCase();
					if (currentName.includes("code") || currentName.includes("frontmatter")) return false;

					if (from === to && state.sliceDoc(from - 1, from + 1) === "$$") {
						if (!this.checkMathEnvironment(state, from)) {
							return false;
						}
						view.dispatch({
							changes: { from: from - 1, to: from + 1, insert: "" },
							selection: { anchor: from - 1 },
						});
						return true;
					}
					return false;
				},
			},
		]);

		this.registerEditorExtension([updateListener, customKeymap]);

		if (isWin) {
			this.initPowerShell();
		}
	}

	onunload() {
		console.log("LaTeX 플러그인 종료됨.");
		if (this.psProcess) {
			this.psProcess.stdin?.end();
			this.psProcess.kill();
			this.psProcess = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.updateLinuxCmdCache();
	}

	async saveSettings() {
		this.updateLinuxCmdCache();
		await this.saveData(this.settings);
	}

	private parseLinuxCmd(cmd: string): ParsedCommand {
		const trimmed = (cmd || "").trim();
		if (!trimmed || /[|&;<>()$`"\\'\n]/.test(trimmed)) {
			return { raw: trimmed, file: null, args: null };
		}
		const [file, ...args] = trimmed.split(/\s+/);
		return { raw: trimmed, file, args };
	}

	private updateLinuxCmdCache() {
		this.parsedEngCmd = this.parseLinuxCmd(this.settings.linuxEngCmd);
		this.parsedKorCmd = this.parseLinuxCmd(this.settings.linuxKorCmd);
	}

	private execLinuxCmd(cached: ParsedCommand, rawCmd: string) {
		let cmd = cached;
		if (!cmd || cmd.raw !== rawCmd) {
			cmd = this.parseLinuxCmd(rawCmd);
		}
		if (cmd.file) {
			execFile(cmd.file, cmd.args || [], () => {});
		} else if (cmd.raw) {
			exec(cmd.raw, () => {});
		}
	}

	private initPowerShell() {
		const setupScript = [
			"Add-Type -TypeDefinition '",
			"using System;",
			"using System.Runtime.InteropServices;",
			"public class IME {",
			"    [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
			"    [DllImport(\"imm32.dll\")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);",
			"    [DllImport(\"user32.dll\", CharSet = CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 Msg, IntPtr wParam, IntPtr lParam);",
			"    public static void SetEnglish() {",
			"        IntPtr hwnd = GetForegroundWindow();",
			"        IntPtr hIme = ImmGetDefaultIMEWnd(hwnd);",
			"        SendMessage(hIme, 0x0283, (IntPtr)0x0002, (IntPtr)0);",
			"    }",
			"    public static void SetKorean() {",
			"        IntPtr hwnd = GetForegroundWindow();",
			"        IntPtr hIme = ImmGetDefaultIMEWnd(hwnd);",
			"        SendMessage(hIme, 0x0283, (IntPtr)0x0002, (IntPtr)1);",
			"    }",
			"}';"
		].join("\n");

		this.psProcess = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"]);
		if (this.psProcess.stdin) {
			this.psProcess.stdin.write(setupScript + "\n");
		}
		this.psProcess.on("error", (err) => console.error("백그라운드 파워쉘 실행 에러:", err));
	}

	private checkActiveLeaf() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.editor) {
			// @ts-ignore
			const cmView = view.editor.cm as EditorView;
			if (cmView) {
				this.checkAndUpdateImeState(cmView.state);
			}
		}
	}

	private checkMathEnvironment(state: EditorState, pos: number): boolean {
		// [엔진 1] CodeMirror SyntaxTree 기반 O(1) 검사
		const tree = syntaxTree(state);
		const nodeLeft = tree.resolveInner(pos, -1);
		const nodeRight = tree.resolveInner(pos, 0);
		const leftName = nodeLeft.name.toLowerCase();
		const rightName = nodeLeft === nodeRight ? leftName : nodeRight.name.toLowerCase();

		if (leftName.includes("code") || leftName.includes("frontmatter") ||
			(nodeLeft !== nodeRight && (rightName.includes("code") || rightName.includes("frontmatter")))) {
			return false;
		}

		const isObsidianMath = (node: any, isRightNode: boolean): boolean => {
			for (let curr = node; curr; curr = curr.parent) {
				const name = curr.name.toLowerCase();
				if (name.includes("math")) {
					return !(this.settings.strictBoundary && (
						(!isRightNode && name.includes("formatting-math-end")) ||
						(isRightNode && name.includes("formatting-math-begin"))
					));
				}
			}
			return false;
		};

		if (isObsidianMath(nodeLeft, false) || isObsidianMath(nodeRight, true)) {
			return true;
		}

		// [엔진 2-A: 인라인 수식 검사] 인라인 수식($)은 현재 줄을 벗어날 수 없으므로 현재 줄만 O(1) 스캔
		const line = state.doc.lineAt(pos);
		const lineFrom = line.from;
		const curLine = state.sliceDoc(lineFrom, pos);
		const firstDollar = curLine.indexOf("$");

		if (firstDollar !== -1) {
			let isInlineOpen = false;
			for (let k = firstDollar; k < curLine.length; k++) {
				if (curLine.charCodeAt(k) === 36) { // 36 is '$'
					let bs = 0;
					for (let b = k - 1; b >= 0 && curLine.charCodeAt(b) === 92; b--) bs++; // 92 is '\'
					if ((bs & 1) === 0) {
						const nodeAt = tree.resolveInner(lineFrom + k + 1, -1).name.toLowerCase();
						// 수식 밖에서 시작하는 $$만 블록 수식으로 취급 (인라인 닫는 $와 다음 인라인 여는 $가 인접한 $A$$B$ 케이스 구분)
						if (!isInlineOpen && k + 1 < curLine.length && curLine.charCodeAt(k + 1) === 36 && !nodeAt.includes("formatting-math-end")) {
							k++; // $$ 는 블록 수식이므로 인라인에서는 2칸 스킵
						} else if (!nodeAt.includes("code")) {
							if (nodeAt.includes("formatting-math-end")) {
								isInlineOpen = false;
							} else if (nodeAt.includes("formatting-math-begin")) {
								isInlineOpen = true;
							} else {
								isInlineOpen = !isInlineOpen;
							}
						}
					}
				}
			}
			if (isInlineOpen) return true;
		}

		// [엔진 2-B: 블록 수식 검사] 블록 수식($$)은 여러 줄을 넘나들 수 있으므로 최근 3500자 내 '$$'만 추적
		const scanRange = this.settings.regexRange || 3500;
		const recentStart = Math.max(0, pos - scanRange);
		const recent = state.sliceDoc(recentStart, pos);
		const lastDouble = recent.lastIndexOf("$$");

		// 최근 scanRange 내에 $$가 없으면 블록 수식도 아니므로 즉시 종료
		if (lastDouble === -1) return false;

		// 커서 직전의 마지막 $$가 AST상 이미 닫힌 수식이면 O(1) 즉시 종료
		const lastDoubleNode = tree.resolveInner(recentStart + lastDouble + 1, -1).name.toLowerCase();
		if (lastDoubleNode.includes("formatting-math-end")) return false;

		// $$ 짝 검사 (단일 $나 줄바꿈은 무시하고 $$만 점프)
		let idx = recent.indexOf("$$");
		let isBlockOpen = false;
		let openBlockStart = 0;

		while (idx !== -1) {
			const nodeAt = tree.resolveInner(recentStart + idx + 1, -1).name.toLowerCase();
			if (!nodeAt.includes("code") && !nodeAt.includes("frontmatter")) {
				let bs = 0;
				for (let b = idx - 1; b >= 0 && recent.charCodeAt(b) === 92; b--) bs++;
				if (bs === idx && recentStart > 0) {
					for (let b = recentStart - 1; b >= 0 && state.sliceDoc(b, b + 1) === "\\"; b--) bs++;
				}
				if ((bs & 1) === 0) {
					if (nodeAt.includes("formatting-math-end")) {
						isBlockOpen = false;
					} else if (nodeAt.includes("formatting-math-begin")) {
						isBlockOpen = true;
						openBlockStart = recentStart + idx;
					} else {
						isBlockOpen = !isBlockOpen;
						if (isBlockOpen) openBlockStart = recentStart + idx;
					}
				}
			}
			idx = recent.indexOf("$$", idx + 2);
		}

		return isBlockOpen && (pos - openBlockStart <= scanRange);
	}

	private checkAndUpdateImeState(state: EditorState) {
		const pos = state.selection.main.head;
		const isMath = this.checkMathEnvironment(state, pos);

		if (isMath && !this.isCurrentlyMath) {
			this.switchToEnglish();
			this.isCurrentlyMath = true;
		} else if (!isMath && this.isCurrentlyMath) {
			this.switchToKorean();
			this.isCurrentlyMath = false;
		}
	}

	private setMathModeActive() {
		if (!this.isCurrentlyMath) {
			this.isCurrentlyMath = true;
			this.switchToEnglish();
		}
	}

	private forceWindowsIme(isKorean: boolean) {
		if (this.psProcess && this.psProcess.stdin) {
			const cmd = isKorean ? "[IME]::SetKorean();\n" : "[IME]::SetEnglish();\n";
			this.psProcess.stdin.write(cmd);
		} else {
			const psCommand = [
				"Add-Type -TypeDefinition '",
				"using System;",
				"using System.Runtime.InteropServices;",
				"public class IME {",
				"    [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
				"    [DllImport(\"imm32.dll\")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);",
				"    [DllImport(\"user32.dll\", CharSet = CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 Msg, IntPtr wParam, IntPtr lParam);",
				"}';",
				"$hwnd = [IME]::GetForegroundWindow();",
				"$hIme = [IME]::ImmGetDefaultIMEWnd($hwnd);",
				`[IME]::SendMessage($hIme, 0x0283, 2, ${isKorean ? 1 : 0});`
			].join(" ");
			exec(`powershell -windowstyle hidden -Command "${psCommand}"`);
		}
	}

	private switchToEnglish() {
		if (isLinux) this.execLinuxCmd(this.parsedEngCmd, this.settings.linuxEngCmd);
		else if (isWin) this.forceWindowsIme(false);
	}

	private switchToKorean() {
		if (isLinux) this.execLinuxCmd(this.parsedKorCmd, this.settings.linuxKorCmd);
		else if (isWin) this.forceWindowsIme(true);
	}
}

class MultiLangLaTeXSettingTab extends PluginSettingTab {
	plugin: MultiLangLaTeXPlugin;

	constructor(app: App, plugin: MultiLangLaTeXPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "LaTeX Auto IME Switcher Settings" });

		new Setting(containerEl)
			.setName("Auto-complete Dollar Sign")
			.setDesc("Automatically complete $ to $$ and move cursor inside.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoCompleteDollar)
					.onChange(async (value) => {
						this.plugin.settings.autoCompleteDollar = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Math Context Scan Range")
			.setDesc("단일 수식 블록($$...$$)의 최대 허용 글자 수입니다. 문서 전체 길이와는 무관하게 작동합니다. (기본값: 3500)")
			.addText((text) =>
				text
					.setPlaceholder("3500")
					.setValue(String(this.plugin.settings.regexRange))
					.onChange(async (value) => {
						const num = parseInt(value);
						if (!isNaN(num)) {
							this.plugin.settings.regexRange = num;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Strict Boundary Detection")
			.setDesc("수식 블록($ 또는 $$) 바로 바깥쪽(경계)에 커서가 있을 때 한글 입력이 안 되는 현상을 방지합니다. (기본값: On)")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.strictBoundary)
					.onChange(async (value) => {
						this.plugin.settings.strictBoundary = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "OS-specific IME Commands" });

		new Setting(containerEl)
			.setName("Linux English Command")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.linuxEngCmd)
					.onChange(async (value) => {
						this.plugin.settings.linuxEngCmd = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Linux Local Language Command")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.linuxKorCmd)
					.onChange(async (value) => {
						this.plugin.settings.linuxKorCmd = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Windows IME Toggle Key Code (Legacy)")
			.setDesc("Virtual key code for IME toggle. (Windows uses native API by default)")
			.addText((text) =>
				text
					.setPlaceholder("0x15")
					.setValue(this.plugin.settings.windowsKeyCode)
					.onChange(async (value) => {
						this.plugin.settings.windowsKeyCode = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
