# DEV_SETUP.md — PyWR Canvas development setup

## Prerequisites

| Tool    | Required version | Install                          | Check command     |
|---------|------------------|----------------------------------|-------------------|
| Node.js | 18.x or 20.x     | https://nodejs.org/en/download   | `node --version`  |
| Rust    | stable (latest)  | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | `rustc --version` |
| Git     | any recent       | —                                | `git --version`   |

On macOS, also run:
```bash
xcode-select --install
```

No Python required.

---

## One-time setup

```bash
git clone https://github.com/ShaliniBalaram/pywr-canvas.git
cd pywr-canvas
npm install
```

---

## Running in development

```bash
npm run dev
```

This runs `tauri dev`, which starts the Vite dev server and launches the Tauri window.
Hot module reload is active for React changes. Rust changes trigger a recompile.

---

## Building a distributable

```bash
npm run build
```

This runs `tauri build`. Output is in `src-tauri/target/release/bundle/`:
- Mac: `macos/PyWR Canvas.app` and `dmg/PyWR Canvas-<version>.dmg`
- Windows: `nsis/PyWR Canvas Setup <version>.exe`

Users double-click the installer — no Node.js, no Rust, no terminal needed.

---

## Type checking (TypeScript only)

```bash
npm run typecheck
```

---

## Troubleshooting

**`npm run dev` fails with a Cargo/Rust error**
Check Rust is installed: `rustc --version`. If not, run the rustup install command above.
On macOS, also check `xcode-select --install` has been run.

**`npm install` fails**
Check Node.js version: `node --version` — must be v18.x or v20.x.

**Tauri window is blank**
The Vite dev server (port 3000) may not have started yet. Wait a few seconds.

---

## Architecture overview

See `docs/ARCHITECTURE.md` for how the app is structured internally.
