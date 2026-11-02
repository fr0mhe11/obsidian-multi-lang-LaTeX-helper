# Obsidian Multi-Lang LaTeX Helper

A blazingly fast Obsidian plugin that automatically switches your Input Method Editor (IME) between English and your local language (Korean) when entering or exiting LaTeX math environments.

수식(LaTeX)을 작성할 때마다 한/영 키를 눌러야 하는 번거로움을 완벽하게 없애주는 Obsidian 플러그인입니다. 수식 블록(`$`, `$$`) 진입 시 자동으로 영어로, 빠져나오면 다시 한글로 전환됩니다.

## ✨ Key Features & Optimizations

- **Zero-Delay Switching**: Windows(native `imm32.dll`)와 Linux(`fcitx5`) 환경에서 지연 없는 즉각적인 입력기 전환을 지원합니다.
- 🚀 **Extreme V8 Engine Optimization**:
  - 메모리 누수 및 가비지 컬렉션(GC)을 유발하는 무거운 `state.doc.toString()` 호출을 완전히 제거했습니다.
  - 정규식 호이스팅(RegEx Hoisting)과 CodeMirror 6의 네이티브 `syntaxTree` 파싱을 활용하여, 대용량 노트에서도 타이핑 지연(Micro-stuttering)이 발생하지 않는 $O(1)$ ~ $O(\log N)$ 수준의 성능을 달성했습니다.
- **Smart Context Awareness**: 코드 블록(Code blocks)과 프론트매터(Frontmatter) 내부의 `$` 기호를 무시하여 오작동을 방지합니다.
- **Dual-Engine Math Detection**: CodeMirror AST O(1) 검사와 함께, 인라인 수식 단일 행 O(1) 스캔 및 블록 수식(`$$`) 징검다리 점프 스캔을 결합하여 대용량 문서에서도 성능 저하 없이 즉시 반응합니다.

## ⚙️ Settings

- **Auto-complete Dollar Sign**: `$` 입력 시 `$$`로 자동 완성하고 커서를 중앙으로 이동시킵니다.
- **Strict Boundary Detection**: 수식 블록 경계선에서의 한/영 전환 판정을 엄격하게 적용하여 경계 바로 바깥에서 한글이 씹히는 현상을 방지합니다.
- **Math Context Scan Range**: 단일 블록 수식(`$$...$$`)의 최대 허용 글자 수입니다. (기본값: 3500)
- **OS-specific IME Commands**: Linux(`fcitx5`) 및 Windows 환경을 위한 입력기 전환 설정을 지원합니다. Linux에서는 `execFile` 직접 실행 캐싱으로 타이핑 렉이 전혀 없습니다.


## fcitx5 사용자를 위한 알림
**전역 옵션** 에서 **첫번째 입력기와 현재 입력기의 임시 전환** 이 "왼쪽 쉬프트" 로 되어있는 경우가 있습니다. 이경우 수식 안에서 쉬프트 키를 누르면 입력언어가 바뀌는 문제가 있으니 해당 설정을 다른 키로 바꾸거나 비워주세요!
## 🛠️ Installation (Manual)

아직 공식 스토어 심사 중이라, BRAT 플러그인을 통해 미리 만나보실 수 있습니다.

1.Obsidian 설정 -> 커뮤니티 플러그인 -> BRAT 설치 및 활성화

2.BRAT 설정에서 'Add Beta plugin' 클릭

3.아래 주소 복사해서 붙여넣기:

  https://github.com/fr0mhe11/obsidian-multi-lang-LaTeX-helper


