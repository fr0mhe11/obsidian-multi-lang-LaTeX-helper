import { App, Plugin, PluginSettingTab, Setting, MarkdownView } from 'obsidian';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { exec, spawn, ChildProcess } from 'child_process';

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

const RE_CODE_BLOCK = /```[\s\S]*?(```|$)/g;
const RE_INLINE_CODE = /`[^`\n]*?`/g;
const RE_DOUBLE_DOLLAR = /\$\$/g;

// [최적화 트릭] 설정에 따라 정규식을 실시간 생성하지 않고 미리 두 버전을 모두 컴파일하여 메모리에 캐싱
// 1. 줄바꿈 허용 안 함 (엄격, 초고속 반응)
const RE_INLINE_MATH_STRICT = /(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;
const RE_UNCLOSED_MATH_STRICT = /(?<!\\)\$[^$\n]*$/;

// 2. 줄바꿈 1회 허용 (기존의 느슨한 방식)
const RE_INLINE_MATH_LOOSE = /(?<!\\)\$((?:(?!\n\n)[^$])+?)(?<!\\)\$/g;
const RE_UNCLOSED_MATH_LOOSE = /(?<!\\)\$(?:(?!\n\n)[^$])*$/;

interface Fcitx5LatexSettings {
    autoCompleteDollar: boolean;
    strictBoundary: boolean;
    allowEnterInInlineMath: boolean; // ✨ 새 옵션 추가
    regexRange: number;
    inlineScanRange: number;
    linuxEngCmd: string;
    linuxKorCmd: string;
    windowsKeyCode: string;
}

const DEFAULT_SETTINGS: Fcitx5LatexSettings = {
    autoCompleteDollar: true,
    strictBoundary: true,
    allowEnterInInlineMath: false, // 기본값은 반응 속도가 빠르고 엇박자가 없는 '엄격 모드'로 설정
    regexRange: 3500,
    inlineScanRange: 800,
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
        console.log("🚀 LaTeX 플러그인 로드됨 (인라인 수식 줄바꿈 옵션 적용)");

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

    private checkMathEnvironment(state: EditorState, pos: number): boolean {
        const tree = syntaxTree(state);
        const currentNode = tree.resolveInner(pos, -1);
        const currentName = currentNode.name.toLowerCase();

        if (currentName.includes("code") || currentName.includes("frontmatter")) {
            return false;
        }

        const prevChar = state.sliceDoc(pos - 1, pos);
        const nextChar = state.sliceDoc(pos, pos + 1);

        if (this.isCurrentlyMath && prevChar === '\\' && nextChar === '$') {
            return true;
        }

        const scanRange = this.settings.regexRange || 3500; 
        const startPos = Math.max(0, pos - scanRange);
        
        const textToCursor = state.sliceDoc(startPos, pos);
        const textWithoutCode = textToCursor.replace(RE_CODE_BLOCK, '').replace(RE_INLINE_CODE, '');
        
        let blockMathCount = 0;
        let lastDollarIdx = -1;
        let i = 0;
        const len = textWithoutCode.length;
        
        while (i < len) {
            const code = textWithoutCode.charCodeAt(i);
            if (code === 92) { i += 2; continue; } // '\\'
            if (code === 36 && textWithoutCode.charCodeAt(i+1) === 36) { // '$'
                blockMathCount++;
                lastDollarIdx = i;
                i += 2;
                continue;
            }
            i++;
        }

        if (blockMathCount % 2 === 1) {
            return true;
        }

        const leftNode = currentNode; 
        const rightNode = tree.resolveInner(pos, 1);
        
        const leftName = currentName; 
        const rightName = rightNode.name.toLowerCase();

        const isLeftMath = leftName.includes("math");
        const isRightMath = rightName.includes("math");

        let isMath = false;
        let referenceNode = null;

        if (this.settings.strictBoundary) {
            if (isLeftMath && !isRightMath && leftName.includes("formatting-math-end")) return false;
            if (!isLeftMath && isRightMath && rightName.includes("formatting-math-begin")) return false;
            
            if (isLeftMath && isRightMath && leftName.includes("formatting-math-end") && rightName.includes("formatting-math-begin")) {
                return false;
            }

            const pChar = state.sliceDoc(pos - 1, pos);
            const nChar = state.sliceDoc(pos, pos + 1);
            if (pChar === '$' && nChar === '$') {
                isMath = true;
                referenceNode = leftNode;
            } else if (isLeftMath || isRightMath) {
                isMath = true;
                referenceNode = isLeftMath ? leftNode : rightNode;
            }
        } else {
            if (isLeftMath || isRightMath) {
                isMath = true;
                referenceNode = isLeftMath ? leftNode : rightNode;
            }
        }

        if (isMath && referenceNode) {
            let topMathNode = referenceNode;
            while (topMathNode.parent && topMathNode.parent.name.toLowerCase().includes("math")) {
                topMathNode = topMathNode.parent;
            }

            const nodePrefix = state.sliceDoc(topMathNode.from, topMathNode.from + 2);
            if (nodePrefix.startsWith('$')) {
                const charBefore = state.sliceDoc(topMathNode.from - 1, topMathNode.from);
                const charBefore2 = state.sliceDoc(topMathNode.from - 2, topMathNode.from - 1);
                if (charBefore === '\\' && charBefore2 !== '\\') return false;
            } else if (nodePrefix === '\\$') {
                const charBefore = state.sliceDoc(topMathNode.from - 1, topMathNode.from);
                if (charBefore !== '\\') return false;
            }

            return true;
        }

        const inlineScanRange = this.settings.inlineScanRange || 500;
        const inlineStartPos = Math.max(0, pos - inlineScanRange);
        const inlineEndPos = Math.min(state.doc.length, pos + inlineScanRange);

        const textAround = state.sliceDoc(inlineStartPos, inlineEndPos);
        const localPos = pos - inlineStartPos;
        
        const cleanText = textAround
            .replace(RE_CODE_BLOCK, match => ' '.repeat(match.length))
            .replace(RE_INLINE_CODE, match => ' '.repeat(match.length))
            .replace(RE_DOUBLE_DOLLAR, '  '); 

        // ✨ 옵션에 따른 정규식 스위칭 (동적 컴파일 오버헤드 0)
        const targetInlineMathRe = this.settings.allowEnterInInlineMath ? RE_INLINE_MATH_LOOSE : RE_INLINE_MATH_STRICT;
        const targetUnclosedMathRe = this.settings.allowEnterInInlineMath ? RE_UNCLOSED_MATH_LOOSE : RE_UNCLOSED_MATH_STRICT;

        targetInlineMathRe.lastIndex = 0;
        let match;
        while ((match = targetInlineMathRe.exec(cleanText)) !== null) {
            if (localPos > match.index && localPos < match.index + match[0].length) {
                return true;
            }
        }

        const textUpToCursor = cleanText.slice(0, localPos);
        const textWithoutClosedMath = textUpToCursor.replace(targetInlineMathRe, match => ' '.repeat(match.length));
        
        targetUnclosedMathRe.lastIndex = 0;
        const unclosedMatch = targetUnclosedMathRe.exec(textWithoutClosedMath);
        
        if (unclosedMatch) {
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
 
        // ✨ 새로 추가된 설정 탭 토글
        new Setting(containerEl)
            .setName('Allow Line Breaks in Inline Math ($)')
            .setDesc('인라인 수식 내부에 줄바꿈(Enter 1번)을 허용할지 결정합니다. 체크를 해제하면 수식 안에서 줄바꿈 시 즉시 한글 모드로 전환되며 플러그인 속도가 약간 더 빨라집니다.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.allowEnterInInlineMath)
                .onChange(async (value) => {
                    this.plugin.settings.allowEnterInInlineMath = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Strict Boundary Detection')
            .setDesc('Enable if Korean input fails just outside math blocks.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.strictBoundary)
                .onChange(async (value) => {
                    this.plugin.settings.strictBoundary = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Inline Math ($) Scan Range')
            .setDesc('인라인 수식($)의 띄어쓰기 오류를 교정하기 위해 스캔할 글자 수입니다. 정규식을 사용하므로 배터리/성능을 위해 500~1000 사이의 낮은 값을 권장합니다. (기본값: 800)')
            .addText(text => text
                .setPlaceholder('500')
                .setValue(String(this.plugin.settings.inlineScanRange))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num)) {
                        this.plugin.settings.inlineScanRange = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Math Block Scan Range')
            .setDesc('Characters to scan backward to detect $$ blocks. Higher values support longer equations but may slightly impact performance. (Default: 3500)')
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
            .setDesc('Virtual key code for IME toggle. Note: Windows now uses native imm32.dll API by default for zero-delay switching, making this fallback rarely used.')
            .addText(text => text
                .setPlaceholder('0x15')
                .setValue(this.plugin.settings.windowsKeyCode)
                .onChange(async (value) => {
                    this.plugin.settings.windowsKeyCode = value;
                    await this.plugin.saveSettings();
                }));
    }
}
