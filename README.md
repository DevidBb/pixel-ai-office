# Pixel AI Office — Stage 1

A local-first Mac-friendly prototype: pixel-art office, three agent roles, task dispatch UI, status indicators, and an activity log.

## Important
Stage 1 uses a **demo timer** to simulate task completion. It does not call an AI model yet. Real model integration and safe tool execution are planned for Stage 2+.

## Requirements
- macOS
- Node.js 20 or newer
- npm

## Run locally
```bash
npm install
npm run dev
```
Open the local URL printed by Vite, usually `http://localhost:5173`.

## Build
```bash
npm run build
npm run preview
```

## Stage 1 architecture
- React + TypeScript: UI, team list, task form, activity log
- Phaser: pixel-art office scene
- Vite: development server and build
- No API keys, network calls, or file-system tools are used by the prototype

## Roadmap
1. Prototype UI and office scene
2. Real AI agent via a server-side API adapter; keep API keys out of browser code
3. Separate role prompts, task queue, retries, and result persistence
4. Permissioned tools with user approval for file writes and shell commands
5. Package as a native macOS app (Tauri or Electron, selected after validating the prototype)
