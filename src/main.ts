import { App, Plugin, PluginSettingTab, Setting, MarkdownView } from 'obsidian';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { exec, spawn, ChildProcess } from 'child_process';

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

interface Fcitx5LatexSettings {
	autoCompleteDollar: boolean;
	allowEnterInInlineMath: boolean;
	strictBoundary: boolean;
	regexRange: number; // ✨ 스캔 범위 설정 부활
	linuxEngCmd: string;
	linuxKorCmd: string;
	windowsKeyCode: string;
}

const DEFAULT_SETTINGS: Fcitx5LatexSettings = {
	autoCompleteDollar: true,
	allowEnterInInlineMath: false,
	strictBoundary: true,
	regexRange: 3500, // 기본값 3500자
	linuxEngCmd: 'fcitx5-remote -s keyboard-us',
	linuxKorCmd: 'fcitx5-remote -s hangul',
	windowsKeyCode: '0x15'
}

export default class Fcitx5LatexPlugin extends Plugin {
	settings: Fcitx5LatexSettings;
	private isCurrentlyMath = false;
	private lastMathEnterTime = 0;
	private psProcess: ChildProcess | null = null;

	async onload() {
		await this.loadSettings();
		console.log("🚀 LaTeX 듀얼 엔진 플러그인 로드됨 (Range Slice 탐색 적용)");

		this.addSettingTab(new Fcitx5LatexSettingTab(this.app, this));

		this.registerEvent(this.app.workspace.on('file-open', () => this.checkActiveLeaf()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.checkActiveLeaf()));

		const updateListener = EditorView.updateListener.of((update) => {
			if (update.docChanged || update.selectionSet || update.focusChanged) {
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
									  selection: { anchor: from + 1, head: to + 1 }
						});
						return true;
					}

					const prevChar = state.sliceDoc(from - 1, from);
					const nextChar = state.sliceDoc(from, from + 1);

					if (prevChar === "\\") return false;

					if (nextChar === "$") {
						if (prevChar === "$") {
							view.dispatch({
								changes: { from: from - 1, to: from + 1, insert: "$$$$" },
								selection: { anchor: from + 1 }
							});
							this.setMathModeActive();
						} else {
							view.dispatch({ selection: { anchor: from + 1 } });
						}
						return true;
					}

					view.dispatch({
						changes: { from, insert: "$$" },
						selection: { anchor: from + 1 }
					});
					this.setMathModeActive();
					return true;
				}
			},
			{
				key: "Backspace",
				run: (view) => {
					if (!this.settings.autoCompleteDollar) return false;

					const state = view.state;
					const { from, to } = state.selection.main;

					const currentName = syntaxTree(state).resolveInner(from, -1).name.toLowerCase();
					if (currentName.includes("code") || currentName.includes("frontmatter")) return false;

					if (from === to) {
						const prevChar = state.sliceDoc(from - 1, from);
						const nextChar = state.sliceDoc(from, from + 1);

						if (prevChar === "$" && nextChar === "$") {
							view.dispatch({
								changes: { from: from - 1, to: from + 1, insert: "" },
								selection: { anchor: from - 1 }
							});

							this.isCurrentlyMath = false;
							this.switchToKorean();

							return true;
						}
					}
					return false;
				}
			}
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
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private initPowerShell() {
		const setupScript = `
		Add-Type -TypeDefinition '
		using System;
		using System.Runtime.InteropServices;
		public class IME {
			[DllImport("user32.dll")]
			public static extern IntPtr GetForegroundWindow();
			[DllImport("imm32.dll")]
			public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);
			[DllImport("user32.dll", CharSet = CharSet.Auto)]
			public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 Msg, IntPtr wParam, IntPtr lParam);

			public static void SetEnglish() {
				IntPtr hwnd = GetForegroundWindow();
				IntPtr hIme = ImmGetDefaultIMEWnd(hwnd);
				SendMessage(hIme, 0x0283, (IntPtr)0x0002, (IntPtr)0);
			}

			public static void SetKorean() {
				IntPtr hwnd = GetForegroundWindow();
				IntPtr hIme = ImmGetDefaultIMEWnd(hwnd);
				SendMessage(hIme, 0x0283, (IntPtr)0x0002, (IntPtr)1);
			}
		}';
		`;

		this.psProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-']);
		if (this.psProcess.stdin) {
			this.psProcess.stdin.write(setupScript + '\n');
		}
		this.psProcess.on('error', (err) => console.error('백그라운드 파워쉘 실행 에러:', err));
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

	// ✨ 핵심: Range 슬라이스를 적용한 하이브리드 엔진
	private checkMathEnvironment(state: EditorState, pos: number): boolean {
		const tree = syntaxTree(state);
		const nodeLeft = tree.resolveInner(pos, -1);
		const nodeRight = tree.resolveInner(pos, 0);
		const leftName = nodeLeft.name.toLowerCase();
		const rightName = nodeRight.name.toLowerCase();

		// 0. 예외 처리
		if (leftName.includes("code") || leftName.includes("frontmatter") ||
			rightName.includes("code") || rightName.includes("frontmatter")) {
			return false;
			}

			// 1. [판단 A] 옵시디안 내장 파서 (Syntax Tree) + Strict Boundary
			const isObsidianMath = (node: any, isRightNode: boolean): boolean => {
				let curr = node;
				while (curr) {
					const name = curr.name.toLowerCase();
					if (name.includes("math")) {
						if (this.settings.strictBoundary) {
							if (!isRightNode && name.includes("formatting-math-end")) return false;
							if (isRightNode && name.includes("formatting-math-begin")) return false;
						}
						return true;
					}
					curr = curr.parent;
				}
				return false;
			};

			if (isObsidianMath(nodeLeft, false) || isObsidianMath(nodeRight, true)) {
				return true;
			}

			// 2. [판단 B] 설정된 Range만큼 잘라와서 State Machine 탐색
			let startPos = 0;

			if (this.settings.allowEnterInInlineMath) {
				// ✨ 줄바꿈을 허용할 경우: 사용자가 설정한 regexRange 만큼 뒤로 가서 통째로 슬라이스
				const scanRange = this.settings.regexRange || 3500;
				startPos = Math.max(0, pos - scanRange);
			} else {
				// 엄격 모드(허용 안함): 정확히 현재 줄의 시작점부터만 스캔 (초고속 유지)
				const line = state.doc.lineAt(pos);
				startPos = line.from;
			}

			// 받아온 범위만큼 문자열을 슬라이스
			const textToScan = state.sliceDoc(startPos, pos);

			let isEscaped = false;
			let inlineDollarCount = 0;
			let blockMathOpen = false;

			// 정규식 대신 순수 State Machine으로 스캔 (문자열이 3500자여도 0.1ms 컷)
			for (let i = 0; i < textToScan.length; i++) {
				const char = textToScan[i];

				if (char === '\\') {
					isEscaped = !isEscaped;
					continue;
				}

				if (char === '$' && !isEscaped) {
					if (i + 1 < textToScan.length && textToScan[i + 1] === '$') {
						blockMathOpen = !blockMathOpen;
						i++; // 다음 $ 건너뛰기
					} else {
						inlineDollarCount++;
					}
				}
				isEscaped = false;
			}

			// 블록 수식이 열려있거나, 인라인 수식이 열려있다면 (홀수 개)
			if (blockMathOpen || (inlineDollarCount % 2 === 1)) {
				return true;
			}

			// 3. [예외 케이스] $ $ 사이 (자동완성 직후 찰나)
			const prevChar = state.sliceDoc(pos - 1, pos);
			const nextChar = state.sliceDoc(pos, pos + 1);
			if (prevChar === '$' && nextChar === '$') {
				return true;
			}

			return false;
	}

	private checkAndUpdateImeState(state: EditorState) {
		const pos = state.selection.main.head;
		const isMath = this.checkMathEnvironment(state, pos);

		if (isMath && !this.isCurrentlyMath) {
			this.switchToEnglish();
			this.lastMathEnterTime = Date.now();
			this.isCurrentlyMath = true;
		} else if (!isMath && this.isCurrentlyMath) {
			this.switchToKorean();
			this.isCurrentlyMath = false;
		}
	}

	private setMathModeActive() {
		this.isCurrentlyMath = true;
		this.lastMathEnterTime = Date.now();
		this.switchToEnglish();
	}

	private forceWindowsIme(isKorean: boolean) {
		if (this.psProcess && this.psProcess.stdin) {
			const cmd = isKorean ? '[IME]::SetKorean();\n' : '[IME]::SetEnglish();\n';
			this.psProcess.stdin.write(cmd);
		} else {
			const psCommand = `
			Add-Type -TypeDefinition '
			using System;
			using System.Runtime.InteropServices;
			public class IME {
				[DllImport("user32.dll")]
				public static extern IntPtr GetForegroundWindow();
				[DllImport("imm32.dll")]
				public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);
				[DllImport("user32.dll", CharSet = CharSet.Auto)]
				public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 Msg, IntPtr wParam, IntPtr lParam);
			}';
			$hwnd = [IME]::GetForegroundWindow();
			$hIme = [IME]::ImmGetDefaultIMEWnd($hwnd);
			[IME]::SendMessage($hIme, 0x0283, 2, ${isKorean ? 1 : 0});
			`.replace(/\n/g, ' ');
			exec(`powershell -windowstyle hidden -Command "${psCommand}"`);
		}
	}

	private switchToEnglish() {
		if (isLinux) exec(this.settings.linuxEngCmd, () => {});
		else if (isWin) this.forceWindowsIme(false);
	}

	private switchToKorean() {
		if (isLinux) exec(this.settings.linuxKorCmd, () => {});
		else if (isWin) this.forceWindowsIme(true);
	}
}

class Fcitx5LatexSettingTab extends PluginSettingTab {
	plugin: Fcitx5LatexPlugin;

	constructor(app: App, plugin: Fcitx5LatexPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'LaTeX Auto IME Switcher Settings' });

		new Setting(containerEl)
		.setName('Auto-complete Dollar Sign')
		.setDesc('Automatically complete $ to $$ and move cursor inside.')
		.addToggle(toggle => toggle
		.setValue(this.plugin.settings.autoCompleteDollar)
		.onChange(async (value) => {
			this.plugin.settings.autoCompleteDollar = value;
			await this.plugin.saveSettings();
		}));

		new Setting(containerEl)
		.setName('Allow Line Breaks in Inline Math ($)')
		.setDesc('인라인 수식 내부에 줄바꿈을 허용합니다. 이 옵션이 켜져 있으면 아래의 Scan Range 값만큼 문서를 역추적하여 수식 환경을 판단합니다.')
		.addToggle(toggle => toggle
		.setValue(this.plugin.settings.allowEnterInInlineMath)
		.onChange(async (value) => {
			this.plugin.settings.allowEnterInInlineMath = value;
			await this.plugin.saveSettings();
		}));

		// ✨ 설정 탭: 스캔 범위 설정 부활
		new Setting(containerEl)
		.setName('Math Context Scan Range')
		.setDesc('수식 줄바꿈이 허용되었을 때 커서 기준으로 문서를 몇 글자 뒤로 거슬러 올라가 검사할지 결정합니다. (기본값: 3500)')
		.addText(text => text
		.setPlaceholder('3500')
		.setValue(String(this.plugin.settings.regexRange))
		.onChange(async (value) => {
			const num = parseInt(value);
			if (!isNaN(num)) {
				this.plugin.settings.regexRange = num;
				await this.plugin.saveSettings();
			}
		}));

		new Setting(containerEl)
		.setName('Strict Boundary Detection')
		.setDesc('수식 블록($ 또는 $$) 바로 바깥쪽(경계)에 커서가 있을 때 한글 입력이 안 되는 현상을 방지합니다. (기본값: On)')
		.addToggle(toggle => toggle
		.setValue(this.plugin.settings.strictBoundary)
		.onChange(async (value) => {
			this.plugin.settings.strictBoundary = value;
			await this.plugin.saveSettings();
		}));

		containerEl.createEl('h3', { text: 'OS-specific IME Commands' });

		new Setting(containerEl)
		.setName('Linux English Command')
		.addText(text => text
		.setValue(this.plugin.settings.linuxEngCmd)
		.onChange(async (value) => {
			this.plugin.settings.linuxEngCmd = value;
			await this.plugin.saveSettings();
		}));

		new Setting(containerEl)
		.setName('Linux Local Language Command')
		.addText(text => text
		.setValue(this.plugin.settings.linuxKorCmd)
		.onChange(async (value) => {
			this.plugin.settings.linuxKorCmd = value;
			await this.plugin.saveSettings();
		}));

		new Setting(containerEl)
		.setName('Windows IME Toggle Key Code (Legacy)')
		.setDesc('Virtual key code for IME toggle. (Windows uses native API by default)')
		.addText(text => text
		.setPlaceholder('0x15')
		.setValue(this.plugin.settings.windowsKeyCode)
		.onChange(async (value) => {
			this.plugin.settings.windowsKeyCode = value;
			await this.plugin.saveSettings();
		}));
	}
}
