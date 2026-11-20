# DEVSHOW C++

IDE desktop moderna, leve e **C-first** construída com **Tauri v2 (Rust + WebView2)** e **TypeScript**, nascida a partir da engenharia reversa e reformulação da UI do **Dev-C++ 5.11**.

## Objetivos
- Manter a leveza, rapidez de inicialização e simplicidade do Dev-C++.
- Reaproveitar diretamente o toolchain local do Windows (`MinGW64\bin\gcc.exe`, `g++.exe`, `gdb.exe`, `AStyle.exe` e `ConsolePauser.exe`).
- Oferecer experiência moderna de edição, temas **Dark** e **Daylight Paper**, diagnósticos pedagógicos do GCC em português, **Visualizador de Memória & Ponteiros (SVG)** e **Teste de Mesa (Trace)** integrado ao GDB/MI.

## Estrutura do Repositório

```text
.
├── src/                  # Frontend TypeScript + Vite (UI da IDE)
├── src-tauri/            # Backend Rust (Tauri v2: IPC, toolchain, compilação e GDB/MI)
└── docs/
    ├── relatorio-engenharia-reversa-redesign.md  # Relatório completo da análise REA + redesign
    ├── devcpp-modern-prototype.html              # Protótipo interativo aprovado
    └── quickwin-devcpp-modern-dark.ini           # Tema rápido para o Dev-C++ 5.11 original
```

## Pré-requisitos
- Windows 10/11 com **Microsoft Edge WebView2 Runtime**
- **Node.js** + **npm**
- **Rust (`rustup` / `cargo`)** + **Visual Studio C++ Build Tools**
- **MinGW64** (ex.: instalação local do Dev-C++ em `C:\Program Files (x86)\Dev-Cpp\MinGW64`)

## Como executar em desenvolvimento

```powershell
npm install
npm run tauri dev
```

## Build otimizado de produção

```powershell
npm run tauri build
```

## Roadmap
- [x] Engenharia reversa do Dev-C++ 5.11 e especificação do redesign (`docs/`)
- [x] Protótipo interativo C-first validado (`docs/devcpp-modern-prototype.html`)
- [x] Scaffold base **Tauri v2** + detecção do toolchain local em Rust
- [ ] MVP: editor real (CodeMirror 6 / Monaco), gerenciamento de arquivos `.c`/`.h`, compilação (`gcc.exe`), execução no console integrado e formatação (`AStyle.exe`)
- [ ] Tradutor pedagógico de diagnósticos reais do GCC
- [ ] Depurador real via `gdb.exe --interpreter=mi2` + Visualizador de Memória SVG e Teste de Mesa ao vivo
- [ ] Empacotamento e instalador Windows (`.exe` / `.msi`)
