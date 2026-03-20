import { App, Plugin, PluginSettingTab, Setting, MarkdownView } from 'obsidian';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { exec, spawn, ChildProcess } from 'child_process';

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

interface Fcitx5LatexSettings {
    autoCompleteDollar: boolean;
    strictBoundary: boolean;
    regexRange: number;
   inlineScanRange: number;
    linuxEngCmd: string;
    linuxKorCmd: string;
    windowsKeyCode: string;
}

const DEFAULT_SETTINGS: Fcitx5LatexSettings = {
    autoCompleteDollar: true,
    strictBoundary: true,
    regexRange: 3500,
    inlineScanRange: 800,
    linuxEngCmd: 'fcitx5-remote -s keyboard-us',
    linuxKorCmd: 'fcitx5-remote -s hangul',
    windowsKeyCode: '0x15'
}

const singleJamoMap: Record<string, string> = {
    'ㄱ': 'r', 'ㄲ': 'R', 'ㄳ': 'rt', 'ㄴ': 's', 'ㄵ': 'sw', 'ㄶ': 'sg', 'ㄷ': 'e', 'ㄸ': 'E', 'ㄹ': 'f',
    'ㄺ': 'fr', 'ㄻ': 'fa', 'ㄼ': 'fq', 'ㄽ': 'ft', 'ㄾ': 'fx', 'ㄿ': 'fv', 'ㅀ': 'fg', 'ㅁ': 'a', 'ㅂ': 'q',
    'ㅃ': 'Q', 'ㅄ': 'qt', 'ㅅ': 't', 'ㅆ': 'T', 'ㅇ': 'd', 'ㅈ': 'w', 'ㅉ': 'W', 'ㅊ': 'c', 'ㅋ': 'z',
    'ㅌ': 'x', 'ㅍ': 'v', 'ㅎ': 'g', 'ㅏ': 'k', 'ㅐ': 'o', 'ㅑ': 'i', 'ㅒ': 'O', 'ㅓ': 'j', 'ㅔ': 'p',
    'ㅕ': 'u', 'ㅖ': 'P', 'ㅗ': 'h', 'ㅘ': 'hk', 'ㅙ': 'ho', 'ㅚ': 'hl', 'ㅛ': 'y', 'ㅜ': 'n', 'ㅝ': 'nj',
    'ㅞ': 'np', 'ㅟ': 'nl', 'ㅠ': 'b', 'ㅡ': 'm', 'ㅢ': 'ml', 'ㅣ': 'l'
};

export default class Fcitx5LatexPlugin extends Plugin {
    settings: Fcitx5LatexSettings;
    private isCurrentlyMath = false;
    private lastMathEnterTime = 0;
    private psProcess: ChildProcess | null = null;

    async onload() {
        await this.loadSettings();
        console.log("🚀 LaTeX 플러그인 로드됨 (하이브리드 파서 적용)");

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

                    if (from === to) {
                        const prevChar = state.sliceDoc(from - 1, from);
                        const nextChar = state.sliceDoc(from, from + 1);

                        // 커서 양옆에 $ $ 가 있어서 동시에 지워지는 상황
                        if (prevChar === "$" && nextChar === "$") {
                            view.dispatch({
                                changes: { from: from - 1, to: from + 1, insert: "" },
                                selection: { anchor: from - 1 } 
                            });
                            
                            // 🚀 수정된 부분: 수식이 완전히 지워졌으므로 영어 고정이 아니라 한글로 풀어주어야 합니다!
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

    private checkMathEnvironment(state: EditorState, pos: number): { isMath: boolean, inTextCmd: boolean } {
        const docText = state.doc.toString();
        const prevChar = docText.charAt(pos - 1);
        const nextChar = docText.charAt(pos);

        // 1. 타이핑 엇박자 완벽 방어 (\ 칠 때 튕기는 현상 즉시 차단)
        if (this.isCurrentlyMath && prevChar === '\\' && nextChar === '$') {
            return { isMath: true, inTextCmd: false };
        }

        // 🚀 2. 스캔 범위 설정 (메쓰블록과 인라인 정규식이 공유하는 레인지)
        const scanRange = this.settings.regexRange || 3500; 
        const startPos = Math.max(0, pos - scanRange);
        
        // 인라인 정규식은 닫는 기호도 찾아야 하므로 커서 뒤쪽으로도 동일하게 범위를 잡습니다.
        const endPos = Math.min(state.doc.length, pos + scanRange);

        // --- 메쓰블록($$) 홀짝 카운터 (기존 로직 완벽 유지) ---
const blockScanRange = this.settings.regexRange || 10000; 
        const blockStartPos = Math.max(0, pos - blockScanRange);        

const textToCursor = state.doc.sliceString(startPos, pos);
        const textWithoutCode = textToCursor.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]*?`/g, '');
        
        let blockMathCount = 0;
        let lastDollarIdx = -1;
        let i = 0;
        while (i < textWithoutCode.length) {
            if (textWithoutCode[i] === '\\') { i += 2; continue; }
            if (textWithoutCode[i] === '$' && textWithoutCode[i+1] === '$') {
                blockMathCount++;
                lastDollarIdx = i;
                i += 2;
                continue;
            }
            i++;
        }

        if (blockMathCount % 2 === 1) {
            const textAfterLastDollar = textWithoutCode.slice(lastDollarIdx);
            const inTextCmd = !!textAfterLastDollar.match(/\\(text|mathrm|textkr)\{([^}]*)$/);
            return { isMath: true, inTextCmd };
        }

        // --- 3. Syntax Tree 판별 (옵시디안 코어 파서) ---
        const tree = syntaxTree(state);
        const leftNode = tree.resolveInner(pos, -1);
        const rightNode = tree.resolveInner(pos, 1);
        
        const leftName = leftNode.name.toLowerCase();
        const rightName = rightNode.name.toLowerCase();

        const isLeftMath = leftName.includes("math");
        const isRightMath = rightName.includes("math");

        let isMath = false;
        let referenceNode = null;

        if (this.settings.strictBoundary) {
            if (isLeftMath && !isRightMath && leftName.includes("formatting-math-end")) return { isMath: false, inTextCmd: false };
            if (!isLeftMath && isRightMath && rightName.includes("formatting-math-begin")) return { isMath: false, inTextCmd: false };
            
            const pChar = state.doc.sliceString(pos - 1, pos);
            const nChar = state.doc.sliceString(pos, pos + 1);
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

            const nodeText = state.doc.sliceString(topMathNode.from, topMathNode.to);
            if (nodeText.startsWith('$')) {
                const charBefore = state.doc.sliceString(topMathNode.from - 1, topMathNode.from);
                const charBefore2 = state.doc.sliceString(topMathNode.from - 2, topMathNode.from - 1);
                if (charBefore === '\\' && charBefore2 !== '\\') return { isMath: false, inTextCmd: false };
            } else if (nodeText.startsWith('\\$')) {
                const charBefore = state.doc.sliceString(topMathNode.from - 1, topMathNode.from);
                if (charBefore !== '\\') return { isMath: false, inTextCmd: false };
            }

            const mathTextBeforeCursor = state.doc.sliceString(topMathNode.from, pos);
            const inTextCmd = !!mathTextBeforeCursor.match(/\\(text|mathrm|textkr)\{([^}]*)$/);
            return { isMath: true, inTextCmd };
        }

        // --- 🚀 4. 정규식을 이용한 인라인 수식 힐러 (Regex Inline Healer) ---
        // Syntax Tree가 $a $ 띄어쓰기 위반으로 포기한 수식을 동일한 scanRange 내에서 정규식으로 구출합니다.
// --- 🚀 4. 정규식을 이용한 인라인 수식 힐러 (Regex Inline Healer) ---
        const inlineScanRange = this.settings.inlineScanRange || 500;
        const inlineStartPos = Math.max(0, pos - inlineScanRange);
        const inlineEndPos = Math.min(state.doc.length, pos + inlineScanRange);

        const textAround = state.doc.sliceString(inlineStartPos, inlineEndPos);
        const localPos = pos - inlineStartPos;
        
        const cleanText = textAround
            .replace(/```[\s\S]*?(```|$)/g, match => ' '.repeat(match.length))
            .replace(/`[^`\n]*?`/g, match => ' '.repeat(match.length))
            .replace(/\$\$/g, '  '); 

        // 🚀 수정됨 1: 화폐 단위 방어(?!\s*[0-9]) 완전 삭제!
        // 숫자로 시작하는 수식($1 + 2$ 등)을 완벽하게 보호합니다.
        const inlineMathRegex = /(?<!\\)\$((?:(?!\n\n)[^$])+?)(?<!\\)\$/g;
        
        let match;
        while ((match = inlineMathRegex.exec(cleanText)) !== null) {
            if (localPos > match.index && localPos < match.index + match[0].length) {
                const mathTextBeforeCursor = cleanText.slice(match.index, localPos);
                const inTextCmd = !!mathTextBeforeCursor.match(/\\(text|mathrm|textkr)\{([^}]*)$/);
                return { isMath: true, inTextCmd };
            }
        }

        // 🚀 수정됨 2: 타이핑 중인(닫히지 않은) 수식 검사기
        const textUpToCursor = cleanText.slice(0, localPos);
        const textWithoutClosedMath = textUpToCursor.replace(inlineMathRegex, match => ' '.repeat(match.length));
        
        const unclosedMathRegex = /(?<!\\)\$(?:(?!\n\n)[^$])*$/;
        const unclosedMatch = unclosedMathRegex.exec(textWithoutClosedMath);
        
        if (unclosedMatch) {
            // 🚀 보너스 수정: 수식을 닫기 전에 \text{} 를 쓸 때도 한글 전환이 되도록 보강
            const mathTextBeforeCursor = textWithoutClosedMath.slice(unclosedMatch.index, localPos);
            const inTextCmd = !!mathTextBeforeCursor.match(/\\(text|mathrm|textkr)\{([^}]*)$/);
            return { isMath: true, inTextCmd };
        }

        return { isMath: false, inTextCmd: false };
    }


    private checkAndUpdateImeState(state: EditorState) {
        const pos = state.selection.main.head;
        const { isMath, inTextCmd } = this.checkMathEnvironment(state, pos);

        if (isMath && !this.isCurrentlyMath) {
            if (!inTextCmd) {
                this.switchToEnglish();
                this.lastMathEnterTime = Date.now();
                this.isCurrentlyMath = true;
            }
        } else if (!isMath && this.isCurrentlyMath) {
            this.switchToKorean();
            this.isCurrentlyMath = false;
        } else if (isMath && this.isCurrentlyMath) {
            this.isCurrentlyMath = true;
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
            .setName('Strict Boundary Detection')
            .setDesc('Enable if Korean input fails just outside math blocks.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.strictBoundary)
                .onChange(async (value) => {
                    this.plugin.settings.strictBoundary = value;
                    await this.plugin.saveSettings();
                }));


// 🚀 (신규 인라인 Range 옵션 추가)
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
