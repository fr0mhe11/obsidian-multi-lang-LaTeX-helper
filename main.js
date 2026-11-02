var E = Object.defineProperty;
var L = Object.getOwnPropertyDescriptor;
var A = Object.getOwnPropertyNames;
var k = Object.prototype.hasOwnProperty;
var W = (l, i) => { for (var e in i) E(l, e, { get: i[e], enumerable: !0 }); },
K = (l, i, e, t) => {
	if (i && typeof i == "object" || typeof i == "function")
		for (let s of A(i)) !k.call(l, s) && s !== e && E(l, s, { get: () => i[s], enumerable: !(t = L(i, s)) || t.enumerable });
		return l;
};
var N = l => K(E({}, "__esModule", { value: !0 }), l);
var G = {};
W(G, { default: () => S });
module.exports = N(G);

var r = require("obsidian"),
P = require("@codemirror/view"),
x = require("@codemirror/language"),
p = require("child_process"),
y = process.platform === "win32",
D = process.platform === "linux",
V = {
	autoCompleteDollar: !0,
	strictBoundary: !0,
	regexRange: 3500,
	linuxEngCmd: "fcitx5-remote -s keyboard-us",
	linuxKorCmd: "fcitx5-remote -s hangul",
	windowsKeyCode: "0x15"
};

var S = class extends r.Plugin {
	constructor() {
		super(...arguments);
		this.isCurrentlyMath = !1;
		this.psProcess = null;
		this.lastPos = -1;
	}

	async onload() {
		await this.loadSettings();
		console.log("🚀 LaTeX 듀얼 엔진 플러그인 로드됨 (조기 필터링 & 점프 스캔 최적화 완료)");
		this.addSettingTab(new v(this.app, this));
		this.registerEvent(this.app.workspace.on("file-open", () => this.checkActiveLeaf()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.checkActiveLeaf()));

		let e = P.EditorView.updateListener.of(s => {
			let a = s.state.selection.main.head;
			if (s.docChanged || (s.selectionSet && a !== this.lastPos)) {
				this.lastPos = a;
				this.checkAndUpdateImeState(s.state);
			}
		});

		let t = P.keymap.of([
			{
				key: "$",
				run: s => {
					if (!this.settings.autoCompleteDollar) return !1;
					let a = s.state,
					{ from: n, to: c } = a.selection.main,
					h = (0, x.syntaxTree)(a).resolveInner(n, -1).name.toLowerCase();
					if (h.includes("code") || h.includes("frontmatter")) return !1;
					if (n !== c) {
						s.dispatch({
							changes: { from: n, to: c, insert: "$" + a.sliceDoc(n, c) + "$" },
								   selection: { anchor: n + 1, head: c + 1 }
						});
						return !0;
					}
					let d = a.sliceDoc(n - 1, n),
							f = a.sliceDoc(n, n + 1);
							if (d === "\\") return !1;
					if (f === "$") {
						if (d === "$") {
							if (this.checkMathEnvironment(a, n)) {
								s.dispatch({
									changes: { from: n - 1, to: n + 1, insert: "$$$$" },
									selection: { anchor: n + 1 }
								});
								this.setMathModeActive();
								return !0;
							}
						}
						s.dispatch({ selection: { anchor: n + 1 } });
						return !0;
					}
					s.dispatch({
						changes: { from: n, insert: "$$" },
						selection: { anchor: n + 1 }
					});
					this.setMathModeActive();
					return !0;
				}
			},
			{
				key: "Backspace",
				run: s => {
					if (!this.settings.autoCompleteDollar) return !1;
					let a = s.state,
					{ from: n, to: c } = a.selection.main,
					h = (0, x.syntaxTree)(a).resolveInner(n, -1).name.toLowerCase();
					if (h.includes("code") || h.includes("frontmatter")) return !1;
					if (n === c && a.sliceDoc(n - 1, n + 1) === "$$") {
						if (!this.checkMathEnvironment(a, n)) return !1;
						s.dispatch({
							changes: { from: n - 1, to: n + 1, insert: "" },
							selection: { anchor: n - 1 }
						});
						return !0;
					}
					return !1;
				}
			}
		]);

		this.registerEditorExtension([e, t]);
		if (y) this.initPowerShell();
	}

	onunload() {
		var e;
		console.log("LaTeX 플러그인 종료됨.");
		if (this.psProcess) {
			(e = this.psProcess.stdin) == null || e.end();
			this.psProcess.kill();
			this.psProcess = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, V, await this.loadData());
		this.updateLinuxCmdCache();
	}

	async saveSettings() {
		this.updateLinuxCmdCache();
		await this.saveData(this.settings);
	}

	parseLinuxCmd(e) {
		let t = (e || "").trim();
		if (!t || /[|&;<>()$`"\\'\n]/.test(t)) return { raw: t, file: null, args: null };
		let [s, ...a] = t.split(/\s+/);
		return { raw: t, file: s, args: a };
	}

	updateLinuxCmdCache() {
		this.parsedEngCmd = this.parseLinuxCmd(this.settings.linuxEngCmd);
		this.parsedKorCmd = this.parseLinuxCmd(this.settings.linuxKorCmd);
	}

	execLinuxCmd(e, t) {
		if (!e || e.raw !== t) e = this.parseLinuxCmd(t);
		if (e.file) (0, p.execFile)(e.file, e.args, () => {});
		else if (e.raw) (0, p.exec)(e.raw, () => {});
	}

	initPowerShell() {
		let e = [
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

		this.psProcess = (0, p.spawn)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"]);
		if (this.psProcess.stdin) this.psProcess.stdin.write(e + "\n");
		this.psProcess.on("error", t => console.error("백그라운드 파워쉘 실행 에러:", t));
	}

	checkActiveLeaf() {
		let e = this.app.workspace.getActiveViewOfType(r.MarkdownView);
		if (e && e.editor) {
			let t = e.editor.cm;
			if (t) this.checkAndUpdateImeState(t.state);
		}
	}

	checkMathEnvironment(e, t) {
		// [엔진 1] CodeMirror SyntaxTree 기반 O(1) 검사
		let s = (0, x.syntaxTree)(e),
		a = s.resolveInner(t, -1),
		n = s.resolveInner(t, 0),
		c = a.name.toLowerCase(),
		h = a === n ? c : n.name.toLowerCase();

		if (c.includes("code") || c.includes("frontmatter") || (a !== n && (h.includes("code") || h.includes("frontmatter")))) {
			return !1;
		}

		let d = (o, g) => {
			for (let C = o; C; C = C.parent) {
				let M = C.name.toLowerCase();
				if (M.includes("math")) {
					return !(this.settings.strictBoundary && ((!g && M.includes("formatting-math-end")) || (g && M.includes("formatting-math-begin"))));
				}
			}
			return !1;
		};

		if (d(a, !1) || d(n, !0)) return !0;

		// [엔진 2-A: 인라인 수식 검사] 인라인 수식($)은 현재 줄을 벗어날 수 없으므로 현재 줄만 O(1) 스캔
		let line = e.doc.lineAt(t),
		lineFrom = line.from,
		curLine = e.sliceDoc(lineFrom, t),
		firstDollar = curLine.indexOf("$");

		if (firstDollar !== -1) {
			let isInlineOpen = !1;
			for (let k = firstDollar; k < curLine.length; k++) {
				if (curLine.charCodeAt(k) === 36) {
					let bs = 0;
					for (let b = k - 1; b >= 0 && curLine.charCodeAt(b) === 92; b--) bs++;
					if ((bs & 1) === 0) {
						let nodeAt = s.resolveInner(lineFrom + k + 1, -1).name.toLowerCase();
						if (!isInlineOpen && k + 1 < curLine.length && curLine.charCodeAt(k + 1) === 36 && !nodeAt.includes("formatting-math-end")) {
							k++; // $$ 는 블록 수식이므로 인라인에서는 2칸 스킵
						} else if (!nodeAt.includes("code")) {
							if (nodeAt.includes("formatting-math-end")) {
								isInlineOpen = !1;
							} else if (nodeAt.includes("formatting-math-begin")) {
								isInlineOpen = !0;
							} else {
								isInlineOpen = !isInlineOpen;
							}
						}
					}
				}
			}
			if (isInlineOpen) return !0;
		}

		// [엔진 2-B: 블록 수식 검사] 블록 수식($$)은 여러 줄을 넘나들 수 있으므로 최근 3500자 내 '$$'만 추적
		let f = this.settings.regexRange || 3500,
		recentStart = Math.max(0, t - f),
		recent = e.sliceDoc(recentStart, t),
		lastDouble = recent.lastIndexOf("$$");

		// 최근 3500자 내에 $$가 없으면 블록 수식도 아니므로 즉시 종료
		if (lastDouble === -1) return !1;

		// 커서 직전의 마지막 $$가 AST상 이미 닫힌 수식이면 O(1) 즉시 종료
		let lastDoubleNode = s.resolveInner(recentStart + lastDouble + 1, -1).name.toLowerCase();
		if (lastDoubleNode.includes("formatting-math-end")) return !1;

		// $$ 짝 검사 (단일 $나 줄바꿈은 무시하고 $$만 점프)
		let idx = recent.indexOf("$$"),
		isBlockOpen = !1,
		openBlockStart = 0;

		while (idx !== -1) {
			let nodeAt = s.resolveInner(recentStart + idx + 1, -1).name.toLowerCase();
			if (!nodeAt.includes("code") && !nodeAt.includes("frontmatter")) {
				let bs = 0;
				for (let b = idx - 1; b >= 0 && recent.charCodeAt(b) === 92; b--) bs++;
				if (bs === idx && recentStart > 0) {
					for (let b = recentStart - 1; b >= 0 && e.sliceDoc(b, b + 1) === "\\"; b--) bs++;
				}
				if ((bs & 1) === 0) {
					if (nodeAt.includes("formatting-math-end")) {
						isBlockOpen = !1;
					} else if (nodeAt.includes("formatting-math-begin")) {
						isBlockOpen = !0;
						openBlockStart = recentStart + idx;
					} else {
						isBlockOpen = !isBlockOpen;
						if (isBlockOpen) openBlockStart = recentStart + idx;
					}
				}
			}
			idx = recent.indexOf("$$", idx + 2);
		}

		return isBlockOpen && (t - openBlockStart <= f);
	}

	checkAndUpdateImeState(e) {
		let t = e.selection.main.head,
		s = this.checkMathEnvironment(e, t);
		if (s && !this.isCurrentlyMath) {
			this.switchToEnglish();
			this.isCurrentlyMath = !0;
		} else if (!s && this.isCurrentlyMath) {
			this.switchToKorean();
			this.isCurrentlyMath = !1;
		}
	}

	setMathModeActive() {
		if (!this.isCurrentlyMath) {
			this.isCurrentlyMath = !0;
			this.switchToEnglish();
		}
	}

	forceWindowsIme(e) {
		if (this.psProcess && this.psProcess.stdin) {
			this.psProcess.stdin.write(e ? "[IME]::SetKorean();\n" : "[IME]::SetEnglish();\n");
		} else {
			let t = [
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
				`[IME]::SendMessage($hIme, 0x0283, 2, ${e ? 1 : 0});`
			].join(" ");
			(0, p.exec)(`powershell -windowstyle hidden -Command "${t}"`);
		}
	}

	switchToEnglish() {
		if (D) this.execLinuxCmd(this.parsedEngCmd, this.settings.linuxEngCmd);
		else if (y) this.forceWindowsIme(!1);
	}

	switchToKorean() {
		if (D) this.execLinuxCmd(this.parsedKorCmd, this.settings.linuxKorCmd);
		else if (y) this.forceWindowsIme(!0);
	}
};

var v = class extends r.PluginSettingTab {
	constructor(i, e) {
		super(i, e);
		this.plugin = e;
	}
	display() {
		let { containerEl: i } = this;
		i.empty();
		i.createEl("h2", { text: "LaTeX Auto IME Switcher Settings" });

		new r.Setting(i)
		.setName("Auto-complete Dollar Sign")
		.setDesc("Automatically complete $ to $$ and move cursor inside.")
		.addToggle(e => e.setValue(this.plugin.settings.autoCompleteDollar).onChange(async t => {
			this.plugin.settings.autoCompleteDollar = t;
			await this.plugin.saveSettings();
		}));

		new r.Setting(i)
		.setName("Math Context Scan Range")
		.setDesc("단일 수식 블록($$...$$)의 최대 허용 글자 수입니다. 문서 전체 길이와는 무관하게 작동합니다. (기본값: 3500)")
		.addText(e => e.setPlaceholder("3500").setValue(String(this.plugin.settings.regexRange)).onChange(async t => {
			let s = parseInt(t);
			if (!isNaN(s)) {
				this.plugin.settings.regexRange = s;
				await this.plugin.saveSettings();
			}
		}));

		new r.Setting(i)
		.setName("Strict Boundary Detection")
		.setDesc("수식 블록($ 또는 $$) 바로 바깥쪽(경계)에 커서가 있을 때 한글 입력이 안 되는 현상을 방지합니다. (기본값: On)")
		.addToggle(e => e.setValue(this.plugin.settings.strictBoundary).onChange(async t => {
			this.plugin.settings.strictBoundary = t;
			await this.plugin.saveSettings();
		}));

		i.createEl("h3", { text: "OS-specific IME Commands" });

		new r.Setting(i)
		.setName("Linux English Command")
		.addText(e => e.setValue(this.plugin.settings.linuxEngCmd).onChange(async t => {
			this.plugin.settings.linuxEngCmd = t;
			await this.plugin.saveSettings();
		}));

		new r.Setting(i)
		.setName("Linux Local Language Command")
		.addText(e => e.setValue(this.plugin.settings.linuxKorCmd).onChange(async t => {
			this.plugin.settings.linuxKorCmd = t;
			await this.plugin.saveSettings();
		}));

		new r.Setting(i)
		.setName("Windows IME Toggle Key Code (Legacy)")
		.setDesc("Virtual key code for IME toggle. (Windows uses native API by default)")
		.addText(e => e.setPlaceholder("0x15").setValue(this.plugin.settings.windowsKeyCode).onChange(async t => {
			this.plugin.settings.windowsKeyCode = t;
			await this.plugin.saveSettings();
		}));
	}
};
