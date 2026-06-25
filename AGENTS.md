# Agent Instructions

## Package Manager
- Use `npm`: `npm install`, `npm test`, `npm run typecheck`

## Project Shape
- AWS CDK serverless assistant with Bedrock AgentCore, DynamoDB, S3, SQS, EventBridge Scheduler, Slack, and LINE adapters.
- AgentCore runtime lives in `src/agentcore`; custom tool execution and tool schemas live in `src/tools`.
- Slack, LINE, scheduled runner, Google OAuth, and document import entrypoints live under `src/functions`.
- Memory, task, recurring task, calendar, document, web, browser, and weather behavior is exposed through custom tools.

## Generated Files
- `scripts/generate-builtin-skills.ts` runs before build, test, and typecheck.
- Keep generated skill artifacts in sync by using the npm scripts instead of invoking `tsc` or `vitest` directly when validating.

## Testing
- Use `npm run typecheck` for TypeScript validation.
- Use `npm test` for the full Vitest suite.
- Use `npm test -- path/to/file.test.ts` for focused test runs.

## CDK
- Use `npm run synth` to synthesize.
- Use `npm run diff` to inspect infrastructure changes.
- Use `npm run deploy` only when deployment is explicitly approved.
