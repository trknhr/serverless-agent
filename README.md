# slack-ai-assistant

Serverless AI assistant infrastructure for chat workspaces, built on AWS Lambda,
API Gateway, SQS, DynamoDB, S3, EventBridge Scheduler, and Amazon Bedrock
AgentCore.

The current `v0.1.0` implementation ships a Slack adapter. The longer-term
direction is a shared serverless assistant core with first-class Slack and LINE
adapters, plus an optional Discord adapter.

The assistant keeps model reasoning, tool execution, and runtime isolation inside
AgentCore while AWS handles webhooks, queues, state, scheduled jobs, document
ingestion, and chat-platform delivery.

## Status

`v0.1.0` focuses on a working Slack-based assistant:

- Slack app mentions, DMs, thread replies, and interactive actions
- AgentCore Runtime container for model calls and custom tool loops
- durable memory, user preferences, tasks, recurring tasks, and calendar drafts
- scheduled reminders through EventBridge Scheduler
- Slack attachment handling for PDFs, images, and text-like files
- local document and Markdown ingestion through IAM-protected APIs
- direct terminal chat through an IAM-protected API
- Google Calendar OAuth and draft-then-apply calendar tools

Planned adapter direction:

- Slack: implemented in `v0.1.0`
- LINE: intended as a first-class adapter after the assistant core stabilizes
- Discord: optional adapter after Slack/LINE patterns are clear

## Architecture

```text
Slack mention / DM / thread reply
  -> API Gateway
  -> Lambda (slack-events-ingress)
  -> SQS
  -> Lambda (slack-events-worker)
  -> AgentCore Runtime (SlackAgent)
  -> Slack reply

Scheduled reminder
  -> EventBridge Scheduler
  -> Lambda (scheduled-agent-runner)
  -> AgentCore Runtime (SlackAgent)
  -> Slack post

Local document import
  -> CLI script
  -> API Gateway
  -> Lambda (document-import-api)
  -> S3 presigned upload
  -> SQS
  -> Lambda (document-import-worker)
  -> AgentCore Runtime (SlackAgent)
  -> DynamoDB memory/task/calendar state

Direct terminal chat
  -> CLI script
  -> API Gateway
  -> Lambda (chat-api)
  -> AgentCore Runtime (SlackAgent)

State
  -> DynamoDB

Raw attachment and import archive
  -> private S3
```

The adapter boundary is intentionally narrow: platform-specific code should
handle request verification, event parsing, message formatting, file download,
and reply delivery. The assistant core should stay centered on AgentCore
requests, tool resources, memory, tasks, documents, and calendar workflows.

## Included Components

- CDK stack in `lib/slack-ai-assistant-stack.ts`
- AgentCore Runtime project definition in `agentcore/agentcore.json`
- Node 22 AgentCore container build context in `app/SlackAgent/`
- Slack Events API ingress Lambda
- Slack async worker Lambda
- Slack interactions Lambda
- scheduled Agent runner Lambda
- document import API Lambda
- document import worker Lambda
- direct chat API Lambda
- Google OAuth Lambda
- API Gateway REST API
- SQS queues and DLQs
- DynamoDB tables for sessions, turns, memory, tasks, recurring tasks, calendar
  drafts, source documents, OAuth connections, and event deduplication
- private S3 bucket for Slack attachments and local document imports
- local CLI scripts for import, Markdown ingestion, PDF extraction, direct chat,
  and scheduled task setup

## Data Model

The stack creates these DynamoDB tables:

- `SlackThreadSessionsTable`: reusable runtime session IDs for scheduled tasks
- `ConversationSessionsTable`: Slack conversation to AgentCore session mapping
- `ConversationTurnsTable`: thread and top-level channel context
- `ProcessedEventsTable`: Slack event deduplication
- `ScheduledTasksTable`: scheduled Agent run definitions such as `daily-summary`
- `RecurringTasksTable`: recurring task rules materialized by the scheduler
- `UserMemoriesTable`: legacy table retained to avoid destructive stack changes
- `MemoryItemsTable`: workspace-scoped durable memory
- `TasksTable`: current task state
- `TaskEventsTable`: task history
- `CalendarDraftsTable`: reviewable Google Calendar event drafts
- `SourceDocumentsTable`: imported or archived source document metadata
- `GoogleOAuthConnectionsTable`: per-user Google Calendar OAuth connections

## Repository Layout

```text
bin/
lib/
agentcore/
app/
  SlackAgent/
scripts/
src/
  agentcore/
  calendar/
  conversations/
  documents/
  functions/
  imports/
  memory/
  repo/
  slack/
  tasks/
  tools/
tests/
```

## Prerequisites

1. Create these AWS Secrets Manager secrets:
   - `/slack-ai-assistant/slack-signing-secret`
   - `/slack-ai-assistant/slack-bot-token`
   - `/slack-ai-assistant/google-calendar`
2. Ensure the target AWS account has access to Bedrock AgentCore and the
   configured Bedrock model IDs.
3. Install Docker for AgentCore container image builds.
4. Bootstrap CDK in the target AWS account and region.

Google Calendar OAuth client secret JSON:

```json
{
  "client_id": "YOUR_GOOGLE_OAUTH_CLIENT_ID",
  "client_secret": "YOUR_GOOGLE_OAUTH_CLIENT_SECRET",
  "calendar_id": "primary",
  "time_zone": "Asia/Tokyo"
}
```

Each Slack user connects their own Google Calendar through:

- `GET /oauth/google/start`
- `GET /oauth/google/callback`

Add the deployed `GoogleOAuthCallbackUrl` output as an authorized redirect URI
in the Google Cloud OAuth client. Calendar tools run with the Google account
connected to the Slack user who requested the action.

## Deploy

```bash
npm install
npx cdk deploy \
  -c defaultScheduleChannel=C0123456789 \
  -c bedrockModelId=moonshotai.kimi-k2.5 \
  -c bedrockDocumentModelId=apac.anthropic.claude-sonnet-4-20250514-v1:0 \
  -c publicBaseUrl=https://your-api-id.execute-api.ap-northeast-1.amazonaws.com/prod
```

Context options:

- `defaultScheduleChannel`: Slack channel used when the scheduled runner creates
  the fallback `daily-summary` task
- `bedrockModelId`: default Bedrock model used by the AgentCore runtime
- `bedrockDocumentModelId`: Bedrock model used when requests include PDF or
  other document input
- `publicBaseUrl`: deployed API base URL used in Slack replies, especially for
  Google Calendar OAuth links
- `googleCalendarSecretName`: optional override for the Google Calendar secret
- `googleCalendarTimeZone`: optional override for calendar defaults

After deploy, configure Slack with these CDK outputs:

- `SlackEventsUrl`: Slack Events API request URL
- `SlackInteractionsUrl`: Slack interactivity request URL
- `GoogleOAuthCallbackUrl`: Google OAuth redirect URI

## AgentCore Runtime

The `SlackAgent` runtime is defined in `agentcore/agentcore.json` and implemented
by `src/agentcore/runtime.ts`.

The container build context lives under `app/SlackAgent/`. That directory points
back to the root TypeScript source and package metadata so the Lambda functions
and AgentCore runtime share the same domain logic and tool definitions.

Tool groups available inside AgentCore:

- durable memory: `search_memories`, `save_memory`
- one-off tasks: `list_tasks`, `upsert_task`, `mark_task_done`
- recurring tasks: `list_recurring_tasks`, `upsert_recurring_task`,
  `disable_recurring_task`
- Google Calendar drafts: `list_google_calendars`, `list_calendar_events`,
  `find_free_busy`, `create_calendar_draft`, `list_calendar_drafts`,
  `apply_calendar_draft`, `discard_calendar_draft`

## Memory And Permissions

Current memory scopes:

- channel memory: shared context for the current Slack channel
- user preferences: cross-channel personal preferences for the current user
- workspace memory: workspace-level memory used by imports, direct chat fallback,
  and scheduled reminders

Slack conversations currently prevent direct workspace memory writes. Inferred
channel memory is saved as a candidate, while scheduled reminders run with
workspace scope.

Future work should add an admin surface for channel-level knowledge sharing
policies, such as explicit promotion to workspace memory, approval queues,
provenance, audit logs, and per-channel opt-in controls.

## Scheduled Reminders

EventBridge Scheduler invokes `scheduled-agent-runner` with `taskId:
daily-summary` by default.

Scheduled task definitions live in `ScheduledTasksTable`. The runner also
materializes enabled recurring task definitions for the next 7 days before
building the reminder prompt.

Example scheduled task:

```json
{
  "pk": "TASK#daily-summary",
  "taskId": "daily-summary",
  "name": "Daily Summary",
  "prompt": "Summarize yesterday's activity and post a concise update.",
  "workspaceId": "T0123456789",
  "outputChannelId": "C0123456789",
  "enabled": true,
  "reuseSession": false,
  "createdAt": "2026-04-13T00:00:00.000Z",
  "updatedAt": "2026-04-13T00:00:00.000Z"
}
```

Create or update a scheduled task locally:

```bash
npx ts-node scripts/put-scheduled-task.ts \
  --table-name YOUR_SCHEDULED_TASKS_TABLE \
  --region ap-northeast-1 \
  --workspace-id T0123456789 \
  --output-channel-id C0123456789 \
  --prompt "Summarize open tasks and upcoming deadlines."
```

Example recurring task:

```json
{
  "pk": "WORKSPACE#T0123456789",
  "sk": "RECURRING_TASK#rt_cfc324a11246c10f",
  "recurringTaskId": "rt_cfc324a11246c10f",
  "workspaceId": "T0123456789",
  "title": "Submit weekly report",
  "recurrence": {
    "frequency": "weekly",
    "interval": 1,
    "daysOfWeek": ["friday"]
  },
  "dueTime": "17:00",
  "timezone": "Asia/Tokyo",
  "enabled": true,
  "ownerUserId": "U0123456789",
  "priority": "medium",
  "sourceType": "agent",
  "createdAt": "2026-05-11T00:00:00.000Z",
  "updatedAt": "2026-05-11T00:00:00.000Z"
}
```

## Google Calendar Drafts

The assistant creates reviewable Google Calendar drafts before applying events.

Recommended flow:

1. Extract event candidates from Slack or imported documents.
2. Save them with `create_calendar_draft`.
3. Show the returned draft preview to the user.
4. Apply the event only after explicit approval.

Notes:

- Slack users authorize their own Google Calendar accounts through OAuth.
- All-day events use date-only values and Google Calendar's exclusive end-date
  semantics.
- Draft application is idempotent across re-imports by storing app-specific
  private extended properties on events.

## Attachments

Slack file support currently covers:

- PDFs
- images
- text-like files

Requirements and limits:

- the Slack app must include `files:read`
- the default max file size is `10MB` per file
- supported Slack attachments are archived to private S3 before being sent to
  AgentCore Runtime
- unsupported or oversized files are recorded as skipped metadata and degraded
  into text notes instead of breaking the conversation

## Local Document Import

Bulk import uses the private S3 archive bucket plus `SourceDocumentsTable`.

Supported formats:

- `.pdf`
- `.jpg`
- `.jpeg`
- `.png`

Recommended local input directory:

- `private-docs/`

Example:

```bash
npm run import-local-docs -- \
  --api-base-url https://YOUR_API_ID.execute-api.ap-northeast-1.amazonaws.com/prod \
  --workspace-id T0123456789 \
  --user-id U0123456789 \
  --region ap-northeast-1 \
  --wait \
  private-docs
```

Flow:

1. The script requests a presigned upload URL from `/imports/uploads`.
2. It uploads the original file to private S3.
3. It queues processing through `/imports/documents`.
4. The import worker sends the file to AgentCore Runtime.
5. AgentCore persists memories, tasks, recurring tasks, and calendar drafts
   through custom tools.
6. The script can poll `/imports/workspaces/{workspaceId}/sources/{sourceId}`
   until completion.

## PDF To Markdown Extraction

For OCR and layout evaluation, queue a Markdown extraction pass for uploaded
PDFs without ingesting them into memories or tasks.

Routes:

- `POST /imports/extractions/markdown`
- `GET /imports/workspaces/{workspaceId}/sources/{sourceId}`
- `GET /imports/workspaces/{workspaceId}/sources/{sourceId}/markdown`

Example:

```bash
npm run extract-pdf-markdown -- \
  --api-base-url https://YOUR_API_ID.execute-api.ap-northeast-1.amazonaws.com/prod \
  --workspace-id T0123456789 \
  --user-id U0123456789 \
  --region ap-northeast-1 \
  --wait \
  private-docs
```

## Markdown Ingestion

Markdown ingestion uses the same `SourceDocumentsTable`, private S3 archive
bucket, and import worker. Repeating rules such as weekly or monthly duties
should be captured as recurring task definitions, not one-off task instances.

Supported formats:

- `.md`
- `.markdown`

Recommended local input directory:

- `private-notes/`

Example:

```bash
npm run ingest-markdown -- \
  --api-base-url https://YOUR_API_ID.execute-api.ap-northeast-1.amazonaws.com/prod \
  --workspace-id T0123456789 \
  --user-id U0123456789 \
  --region ap-northeast-1 \
  --wait \
  private-notes
```

## Direct Chat From Terminal

For quick questions outside Slack, call the AgentCore-backed assistant through
the IAM-protected `POST /chat/messages` route.

```bash
npm run ask-agent -- \
  --api-base-url https://YOUR_API_ID.execute-api.ap-northeast-1.amazonaws.com/prod \
  --workspace-id T0123456789 \
  --user-id local-importer-teru \
  --region ap-northeast-1 \
  "今日のやることは？"
```

To continue the same conversation, pass the returned `session_id` back:

```bash
npm run ask-agent -- \
  --api-base-url https://YOUR_API_ID.execute-api.ap-northeast-1.amazonaws.com/prod \
  --workspace-id T0123456789 \
  --user-id local-importer-teru \
  --region ap-northeast-1 \
  --session-id sess_... \
  "今夜中のものだけ教えて"
```

## Local Development

```bash
npm install
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run synth
```

Current coverage thresholds are set to 90% for statements, branches, functions,
and lines.

## Security

- Do not commit real tokens, secret values, account IDs, runtime ARNs, or
  environment IDs.
- Do not commit `cdk.out/` artifacts or other generated deployment outputs.
- Keep Slack signing secrets, bot tokens, and Google OAuth client secrets in
  Secrets Manager only.
- `imports/*` and `/chat/messages` routes use `AWS_IAM` authorization.
- Local scripts sign requests with SigV4 using the current AWS credentials.
- IAM principals running local scripts need `execute-api:Invoke` permission for
  the relevant API routes.

## Roadmap

Near-term post-`v0.1.0` work:

- LINE adapter as a first-class messaging integration
- admin page for channel-level workspace memory promotion policies
- explicit approval flow for promoting channel memory to workspace memory
- source provenance and audit logs for workspace-visible knowledge
- platform adapter interface that can support Slack, LINE, and optional Discord
- Discord adapter after the Slack/LINE boundaries are stable

## License

MIT
