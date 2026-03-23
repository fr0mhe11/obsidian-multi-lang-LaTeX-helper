# Obsidian Multi-Lang LaTeX Helper

A blazingly fast Obsidian plugin that automatically switches your Input Method Editor (IME) between English and your local language (Korean) when entering or exiting LaTeX math environments.

수식(LaTeX)을 작성할 때마다 한/영 키를 눌러야 하는 번거로움을 완벽하게 없애주는 Obsidian 플러그인입니다. 수식 블록(`$`, `$$`) 진입 시 자동으로 영어로, 빠져나오면 다시 한글로 전환됩니다.

## ✨ Key Features & Optimizations

- **Zero-Delay Switching**: Windows(native `imm32.dll`)와 Linux(`fcitx5`) 환경에서 지연 없는 즉각적인 입력기 전환을 지원합니다.
- 🚀 **Extreme V8 Engine Optimization**:
  - 메모리 누수 및 가비지 컬렉션(GC)을 유발하는 무거운 `state.doc.toString()` 호출을 완전히 제거했습니다.
  - 정규식 호이스팅(RegEx Hoisting)과 CodeMirror 6의 네이티브 `syntaxTree` 파싱을 활용하여, 대용량 노트에서도 타이핑 지연(Micro-stuttering)이 발생하지 않는 $O(1)$ ~ $O(\log N)$ 수준의 성능을 달성했습니다.
- **Smart Context Awareness**: 코드 블록(Code blocks)과 프론트매터(Frontmatter) 내부의 `$` 기호를 무시하여 오작동을 방지합니다.
- **Customizable Strictness**: 인라인 수식(`$ $`) 내부의 줄바꿈(Enter) 허용 여부를 옵션으로 제공하여 사용자 스타일에 맞는 완벽한 한/영 전환 타이밍을 설정할 수 있습니다.

## ⚙️ Settings

- **Auto-complete Dollar Sign**: `$` 입력 시 `$$`로 자동 완성하고 커서를 중앙으로 이동시킵니다.
- **Allow Line Breaks in Inline Math ($)**: 인라인 수식 내 줄바꿈 허용 여부를 설정합니다. 끄면 속도가 더 빨라지고 엔터를 치는 순간 즉시 한글로 전환됩니다.
- **Strict Boundary Detection**: 수식 블록 경계선에서의 한/영 전환 판정을 엄격하게 적용합니다.
- **Math Block Scan Range**: 수식 감지를 위한 스캔 범위를 세밀하게 조정할 수 있습니다.
- **OS-specific IME Commands**: Linux 유저를 위한 커스텀 `fcitx5` 전환 명령어를 지원합니다.

## 🛠️ Installation (Manual)

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`).
2. Extract the files into your Obsidian vault's plugin folder: `YourVault/.obsidian/plugins/obsidian-multi-lang-LaTeX-helper/`
3. Reload Obsidian and enable the plugin in Settings > Community Plugins.
