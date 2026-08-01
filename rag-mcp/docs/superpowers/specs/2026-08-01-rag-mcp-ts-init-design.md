# rag-mcp TypeScript Initialization Design

Date: 2026-08-01
Status: Approved

## Objective

Initialize `D:\develop\navigate\rag-mcp` as a minimal TypeScript project.
The project must support direct TypeScript development and standard `tsc`
compilation without adding runtime or business dependencies.

## Scope

In scope:

- Update `package.json` to an ESM TypeScript project.
- Add `tsconfig.json`.
- Add a minimal `src/index.ts` entry point.
- Add a project-local `.gitignore`.
- Add `typescript` and `tsx` as development dependencies.
- Add `dev`, `build`, `typecheck`, and `start` scripts.

Out of scope:

- RAG engine implementation.
- MCP server implementation.
- Runtime dependencies such as `@modelcontextprotocol/sdk` or LangChain.
- Test framework setup.
- README or other documentation.

## Architecture

This is a minimal Node.js ESM TypeScript project:

- `src/index.ts` is the only source entry point.
- `tsx` runs TypeScript directly during development.
- `tsc` compiles `src/` to `dist/`.
- `node` runs the compiled entry point in production.

## Files

### package.json

- Keep the project name `rag-mcp`.
- Use `"type": "module"`.
- Use `"main": "dist/index.js"`.
- Add `"private": true` to prevent accidental publishing.
- Keep the existing `version`, `description`, and `license` values.
- Add these scripts:
  - `"dev": "tsx watch src/index.ts"`
  - `"build": "tsc"`
  - `"typecheck": "tsc --noEmit"`
  - `"start": "node dist/index.js"`
- Add only these development dependencies:
  - `typescript`
  - `tsx`

### tsconfig.json

- Target `ES2022`.
- Use `module` and `moduleResolution` set to `NodeNext`.
- Enable `strict`, `esModuleInterop`, `skipLibCheck`, and
  `forceConsistentCasingInFileNames`.
- Set `rootDir` to `src` and `outDir` to `dist`.
- Include `src/**/*`.

### src/index.ts

- Export nothing.
- Log a single startup message so `dev`, `build`, and `start` can be verified.

### .gitignore

- Ignore `node_modules/`.
- Ignore `dist/`.
- Ignore `.env`.
- Ignore `*.log`.

## Data Flow

There is no business data flow yet. The entry point logs a startup message.
The compiled entry point is `dist/index.js`.

## Error Handling

TypeScript strict mode is the compile-time gate. No runtime error paths are
needed for the empty scaffold.

## Testing

The project does not have a test framework yet. Verification uses
`npm run typecheck` and `npm run build`, followed by starting the compiled
output once.
