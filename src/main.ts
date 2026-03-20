import { App, Plugin, PluginSettingTab, Setting, MarkdownView } from 'obsidian';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { exec, spawn, ChildProcess } from 'child_process';

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

interface Fcitx5LatexSettings {
    engine: 'regex' | 'syntaxTree';
    autoCompleteDollar: boolean;
    strictBoundary: boolean;
    regexRange: number;
    linuxEngCmd: string;
    linuxKorCmd: string;
    windowsKeyCode: string;
}

const DEFAULT_SETTINGS: Fcitx5LatexSettings = {
    engine: 'syntaxTree',
    autoCompleteDollar: true,
    strictBoundary: true,
    regexRange: 3500,
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
        console.log(`🚀 LaTeX 플러그인 로드됨 (엔진: ${this.settings.engine})`);

        this.addSettingTab(new Fcitx5LatexSettingTab(this.app, this));

        this.registerEvent(this.app.workspace.on('file-open', () => this.checkActiveLeaf()));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.checkActiveLeaf()));

        const updateListener = EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet || update.focusChanged) {
                this.checkAndUpdateImeState(update.state);
            }
        });

        const koreanFilter = EditorState.transactionFilter.of((tr) => {
            if (!tr.docChanged || (this.lastMathEnterTime > 0 && Date.now() - this.lastMathEnterTime > 1000)) return tr;
            
            let hasKorean = false;
            tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                if (/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(inserted.toString())) hasKorean = true;
            });
            if (!hasKorean) return tr;

            let isMath = false;
            let inMathTextCmd = false;

            tr.changes.iterChanges((fromA) => {
                const mathInfo = this.checkMathEnvironment(tr.startState, fromA);
                if (mathInfo.isMath) {
                    isMath = true;
                    inMathTextCmd = mathInfo.inTextCmd;
                }
            });

            if (!isMath || inMathTextCmd) return tr;

            const newChanges: any[] = [];
            tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                const insertedStr = inserted.toString();
                let engResult = "";

                for (let i = 0; i < insertedStr.length; i++) {
                    const char = insertedStr.charAt(i);
                    let code = char.charCodeAt(0);

                    if (code >= 0xAC00 && code <= 0xD7A3) { 
                        code -= 0xAC00;
                        const jong = code % 28;
                        const jung = Math.floor((code - jong) / 28) % 21;
                        const cho = Math.floor(Math.floor((code - jong) / 28) / 21);

                        const choMap = ["r", "R", "s", "e", "E", "f", "a", "q", "Q", "t", "T", "d", "w", "W", "c", "z", "x", "v", "g"];
                        const jungMap = ["k", "o", "i", "O", "j", "p", "u", "P", "h", "hk", "ho", "hl", "y", "n", "nj", "np", "nl", "b", "m", "ml", "l"];
                        const jongMap = ["", "r", "R", "rt", "s", "sw", "sg", "e", "f", "fr", "fa", "fq", "ft", "fx", "fv", "fg", "a", "q", "qt", "t", "T", "d", "w", "c", "z", "x", "v", "g"];
                        
                        engResult += (choMap[cho] || "") + (jungMap[jung] || "") + (jongMap[jong] || "");
                    } else {
                        engResult += singleJamoMap[char] || char;
                    }
                }
                newChanges.push({ from: fromA, to: toA, insert: engResult });
            });

            return { changes: newChanges, selection: tr.newSelection, effects: tr.effects };
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

                    // 백슬래시 다음의 $는 무시합니다.
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

                        if (prevChar === "$" && nextChar === "$") {
                            view.dispatch({
                                changes: { from: from - 1, to: from + 1, insert: "" },
                                selection: { anchor: from - 1 } 
                            });
                            this.setMathModeActive();
                            return true;
                        }
                    }
                    return false;
                }
            }
        ]);

        this.registerEditorExtension([updateListener, koreanFilter, customKeymap]);

        // 🚀 플러그인 켜질 때 윈도우 파워쉘 백그라운드 세팅
        if (isWin) {
            this.initPowerShell();
        }
    }

    onunload() {
        console.log("LaTeX 플러그인 종료됨.");
        // 🚀 플러그인 꺼질 때 파워쉘 프로세스 정리
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

// 🚀 백그라운드 파워쉘 실행 함수 (.exe 방식의 강제 상태 고정 API 적용)
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
                    // 0x0283 = WM_IME_CONTROL, 0x0002 = IMC_SETCONVERSIONMODE, 0 = 영문
                    SendMessage(hIme, 0x0283, (IntPtr)0x0002, (IntPtr)0); 
                }

                public static void SetKorean() {
                    IntPtr hwnd = GetForegroundWindow();
                    IntPtr hIme = ImmGetDefaultIMEWnd(hwnd);
                    // 1 = 한글
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
        if (this.settings.engine === 'syntaxTree') {
            return this.checkWithSyntaxTree(state, pos);
        } else {
            return this.checkWithRegex(state, pos);
        }
    }

    // 1. 구문 트리 (Syntax Tree) 엔진 - 거짓말 탐지기 탑재
    private checkWithSyntaxTree(state: EditorState, pos: number): { isMath: boolean, inTextCmd: boolean } {
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
            if (isLeftMath && !isRightMath && leftName.includes("formatting-math-end")) {
                return { isMath: false, inTextCmd: false };
            }
            if (!isLeftMath && isRightMath && rightName.includes("formatting-math-begin")) {
                return { isMath: false, inTextCmd: false };
            }
            const prevChar = state.doc.sliceString(pos - 1, pos);
            const nextChar = state.doc.sliceString(pos, pos + 1);
            if (prevChar === '$' && nextChar === '$') {
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

            // 🚀 핵심 픽스 1: 옵시디안 파서의 거짓말 탐지기
            // 파서가 \$ 를 수식이라고 거짓말 쳐도, 원시 텍스트를 검증해서 쳐냅니다.
            const nodeText = state.doc.sliceString(topMathNode.from, topMathNode.to);
            
            if (nodeText.startsWith('$')) {
                const charBefore = state.doc.sliceString(topMathNode.from - 1, topMathNode.from);
                const charBefore2 = state.doc.sliceString(topMathNode.from - 2, topMathNode.from - 1);
                // 바로 앞이 \ 이고, 그 앞이 \ 가 아니라면 (단순 \$) -> 가짜 수식!
                if (charBefore === '\\' && charBefore2 !== '\\') {
                    return { isMath: false, inTextCmd: false };
                }
            } else if (nodeText.startsWith('\\$')) {
                const charBefore = state.doc.sliceString(topMathNode.from - 1, topMathNode.from);
                // 파서가 \ 까지 포함해서 덩어리를 잡았을 경우 검증
                if (charBefore !== '\\') {
                    return { isMath: false, inTextCmd: false };
                }
            }

            const mathTextBeforeCursor = state.doc.sliceString(topMathNode.from, pos);
            const inTextCmd = !!mathTextBeforeCursor.match(/\\(text|mathrm|textkr)\{([^}]*)$/);
            return { isMath: true, inTextCmd };
        }

        return { isMath: false, inTextCmd: false };
    }

    // 2. 정규식 (Regex) 엔진 - 홀짝 백슬래시 계산 마스킹 탑재
    private checkWithRegex(state: EditorState, pos: number): { isMath: boolean, inTextCmd: boolean } {
        const docText = state.doc.toString();
        const range = this.settings.regexRange; 
        const start = Math.max(0, pos - range);
        const end = Math.min(docText.length, pos + range);
        const snippet = docText.substring(start, end);
        const relativePos = pos - start;

        // 🚀 핵심 픽스 2: 진화된 정규식 마스킹 기법
        // 단순히 \\$를 공백으로 치환하는게 아니라, 홀수 개의 \가 붙었을 때만(진짜 이스케이프 상태) $를 공백으로 지웁니다.
        // \\$ 처럼 짝수 개(백슬래시 자체가 이스케이프 된 상황)일 때는 $를 그대로 살려둡니다.
        const maskedSnippet = snippet.replace(/\\+\$/g, (match) => {
            const backslashCount = match.length - 1;
            if (backslashCount % 2 === 1) {
                // $ 기호를 공백(" ")으로 지워서 투명 취급함 (인덱스 길이 유지)
                return match.slice(0, -1) + " ";
            }
            return match;
        });

        const regex = /(\$\$[\s\S]*?\$\$|\$[^$\n]*\$)/g;
        let match;

        while ((match = regex.exec(maskedSnippet)) !== null) {
            const index = match.index;
            const fullMatch = match[0];
            const matchEnd = index + fullMatch.length;

            let startOffset = 1, endOffset = 1;
            if (fullMatch.startsWith("$$") && fullMatch.length >= 4) {
                startOffset = 2;
                endOffset = 2;
            }

            if (this.settings.strictBoundary) {
                if (relativePos > index && relativePos < matchEnd) {
                    const inTextCmd = !!docText.slice(0, pos).match(/\\(text|mathrm|textkr)\{([^}]*)$/);
                    return { isMath: true, inTextCmd };
                }
            } else {
                if (relativePos >= index + startOffset && relativePos <= matchEnd - endOffset) {
                    const inTextCmd = !!docText.slice(0, pos).match(/\\(text|mathrm|textkr)\{([^}]*)$/);
                    return { isMath: true, inTextCmd };
                }
            }
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

   // 🚀 꼬임(Desync)이 절대 발생하지 않는 윈도우 강제 한영 전환
    private forceWindowsIme(isKorean: boolean) {
        if (this.psProcess && this.psProcess.stdin) {
            // 파워쉘 파이프라인에 강제 전환 명령 전송 (0.01초 컷)
            const cmd = isKorean ? '[IME]::SetKorean();\n' : '[IME]::SetEnglish();\n';
            this.psProcess.stdin.write(cmd);
        } else {
            // 프로세스가 죽었을 때를 대비한 Fallback
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
        else if (isWin) this.forceWindowsIme(false); // 무조건 영어로 꽂기
    }

  private switchToKorean() {
        if (isLinux) exec(this.settings.linuxKorCmd, () => {});
        else if (isWin) this.forceWindowsIme(true);  // 무조건 한글로 꽂기
    }
}

// ==========================================
// 설정 UI 탭 클래스
// ==========================================
class Fcitx5LatexSettingTab extends PluginSettingTab {
    plugin: Fcitx5LatexPlugin;

    constructor(app: App, plugin: Fcitx5LatexPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'LaTeX 자동 한영 전환 설정' });

        new Setting(containerEl)
            .setName('수식 인식 엔진 (Engine)')
            .setDesc('수식을 판별하는 방식을 선택합니다. (Syntax Tree 권장)')
            .addDropdown(dropdown => dropdown
                .addOption('syntaxTree', '구문 트리 (Syntax Tree - 정확함)')
                .addOption('regex', '정규식 (Regex - 빠름)')
                .setValue(this.plugin.settings.engine)
                .onChange(async (value: 'regex' | 'syntaxTree') => {
                    this.plugin.settings.engine = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('$ 기호 자동 완성')
            .setDesc('$ 입력 시 $$로 자동 완성하고 커서를 옮깁니다.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoCompleteDollar)
                .onChange(async (value) => {
                    this.plugin.settings.autoCompleteDollar = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('엄격한 경계선 판별 (Strict Boundary)')
            .setDesc('옵시디안 파서가 $$를 인라인 수식으로 헷갈려서 발생하는 경계선 팽창 버그를 방지합니다. 수식 바로 밖에서 한글이 잘 안 쳐진다면 켜주세요.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.strictBoundary)
                .onChange(async (value) => {
                    this.plugin.settings.strictBoundary = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('정규식 탐색 범위 (Regex Range)')
            .setDesc('정규식 엔진 사용 시 커서 앞뒤로 몇 글자까지 읽어와서 수식을 찾을지 설정합니다. (기본값: 3500)')
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

        containerEl.createEl('h3', { text: '운영체제별 전환 명령어 설정' });

        new Setting(containerEl)
            .setName('리눅스 영문 전환 명령어')
            .setDesc('수식 진입 시 실행될 명령어입니다. fcitx4 사용자는 fcitx-remote -c 등을 입력하세요.')
            .addText(text => text
                .setPlaceholder('fcitx5-remote -s keyboard-us')
                .setValue(this.plugin.settings.linuxEngCmd)
                .onChange(async (value) => {
                    this.plugin.settings.linuxEngCmd = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('리눅스 한글 전환 명령어')
            .setDesc('수식 탈출 시 실행될 명령어입니다. fcitx4 사용자는 fcitx-remote -o 등을 입력하세요.')
            .addText(text => text
                .setPlaceholder('fcitx5-remote -s hangul')
                .setValue(this.plugin.settings.linuxKorCmd)
                .onChange(async (value) => {
                    this.plugin.settings.linuxKorCmd = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('윈도우 한/영 전환 키 코드 (Hex)')
            .setDesc('Windows에서 한/영 토글에 사용할 가상 키보드 코드입니다. 기본 우측 Alt(한/영)는 0x15 입니다.')
            .addText(text => text
                .setPlaceholder('0x15')
                .setValue(this.plugin.settings.windowsKeyCode)
                .onChange(async (value) => {
                    this.plugin.settings.windowsKeyCode = value;
                    await this.plugin.saveSettings();
                }));
    }
}
