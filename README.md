# DEVSHOW C++

IDE desktop moderna, leve, rápida e **C-first** construída em **Tauri v2 (Rust + WebView2 + TypeScript + Vite + CodeMirror 6)**, projetada a partir da engenharia reversa e reformulação da UI do Dev-C++ 5.11.

## Recursos Principais

- **Editor CodeMirror 6 C/C++**: syntax highlighting sincronizado aos temas **Obsidian Slate (Dark)** e **Daylight Paper (Light)**, calha clicável de breakpoints (`F4`), Find & Replace inline (`Ctrl+F`), Autocomplete C (`Ctrl+Space`) e Split View (`Ctrl+\`).
- **Roteiro C Integrado + 6 Templates C-First**: inicializa um workspace real com os 7 exercícios cronológicos em C (`01_funcoes.c` … `07_desafio_integrado.c`) e permite criar novos `.c`/`.h` a partir de templates prontos (`Ctrl+Shift+N`).
- **Compilação & Execução Real (MinGW64 / TDM-GCC)**: `F9` (Compile), `F10` (Run), `F11` (Compile & Run) sem piscar janelas CMD (`CREATE_NO_WINDOW`), parser de diagnósticos do GCC com **tradutor pedagógico em português** para erros clássicos em C, console integrado com `stdin`/`stdout` interativo (`scanf`/`fgets`), botão **Parar (`F6`)** e suporte opcional a `ConsolePauser.exe`.
- **Formatação Real com AStyle (`Ctrl+Shift+A`)**: invoca o `AStyle.exe` local via pipe `stdin`/`stdout` preservando `Ctrl+Z` no editor.
- **Depurador Real (`gdb.exe --interpreter=mi2`)**: `F5` (Iniciar/Continuar), `F7` (Step Into), `F8` (Step Over), `Shift+F8` (Step Out), `F6` (Parar), avaliador de expressões C, Call Stack clicável, **Visualizador de Memória & Ponteiros em SVG ao vivo** (endereços reais `&x` e setas `*p`) e tabela automática **Teste de Mesa (Trace)**.
- **Preferências Persistentes**: tema, fonte, tamanho, tabulação, estilo AStyle, perfil de compilador, caminho do toolchain e último workspace salvos em `%APPDATA%\DEVSHOW-CPP\settings.json`.

## Desenvolvimento e Build (Windows x64)

```powershell
# Instalar dependências do frontend
npm install

# Executar o aplicativo desktop em modo desenvolvimento
npm run tauri dev

# Validar frontend e backend
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml

# Gerar executável e instalador otimizados de produção
npm run tauri build
```

## Documentação de Engenharia Reversa e Design

- [docs/relatorio-engenharia-reversa-redesign.md](docs/relatorio-engenharia-reversa-redesign.md)
- [docs/devcpp-modern-prototype.html](docs/devcpp-modern-prototype.html)
- [docs/quickwin-devcpp-modern-dark.ini](docs/quickwin-devcpp-modern-dark.ini)
