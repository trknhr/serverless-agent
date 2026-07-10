# serverless-agent

Serverless AI agent runtime for chat workspaces, built on AWS Lambda,
API Gateway, SQS, DynamoDB, S3, EventBridge Scheduler, and Amazon Bedrock
AgentCore.

The current `v0.2.0` implementation ships a Slack adapter, experimental LINE
text-message support, and a shared assistant core for memory, tasks, calendar
drafts, web tools, browser tools, and evaluation traces. The longer-term
direction is first-class Slack and LINE adapters, plus an optional Discord
adapter.

The assistant keeps model reasoning, tool execution, and runtime isolation inside
AgentCore while AWS handles webhooks, queues, state, scheduled jobs, document
ingestion, and chat-platform delivery.

## Naming

This repository was renamed from `slack-ai-assistant` to `serverless-agent`.
Some CDK identifiers, file names, and AgentCore runtime names still use the old
Slack-specific name to avoid unnecessary CloudFormation replacement. Public
defaults and examples use `serverless-agent`.

## Status

`v0.2.0` focuses on a working Slack-based assistant plus the first shared
multi-adapter assistant core:

- Slack app mentions, DMs, thread replies, and interactive actions
- AgentCore Runtime container for model calls and custom tool loops
- durable memory, user preferences, tasks, recurring tasks, and calendar drafts
- scheduled reminders through EventBridge Scheduler
- Slack attachment handling for PDFs, images, and text-like files
- local document and Markdown ingestion through IAM-protected APIs
- direct terminal chat through an IAM-protected API
- Google Calendar OAuth and draft-then-apply calendar tools
- optional public web search and URL extraction tools with pluggable search
  providers and Readability-based page extraction
- opt-in agent turn traces for offline evaluation: set
  `ENABLE_AGENT_TURN_TRACES=true` (or `-c enableAgentTurnTraces=true`) to
  record each turn's masked input, tool calls, model output, and per-surface
  displayed output to a DynamoDB table with a 90-day TTL

Planned adapter direction:

- Slack: implemented
- LINE: experimental text-message webhook adapter in progress
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

LINE text message
  -> API Gateway
  -> Lambda (line-events-ingress)
  -> SQS
  -> Lambda (line-events-worker)
  -> AgentCore Runtime (SlackAgent)
  -> LINE push message

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
- LINE webhook ingress Lambda
- LINE async worker Lambda
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
- `ProviderBindingsTable`: Slack/LINE provider account and conversation bindings
  to internal workspaces
- `MemoryItemsTable`: workspace-scoped durable memory
- `TasksTable`: current task state
- `TaskEventsTable`: task history
- `CalendarDraftsTable`: reviewable Google Calendar event drafts
- `SkillsTable`: workspace-scoped generated skills and built-in skill overrides
- `SourceDocumentsTable`: imported or archived source document metadata
- `GoogleOAuthConnectionsTable`: per-user Google Calendar OAuth connections

## Repository Layout

```text
bin/
lib/
agentcore/
app/
  SlackAgent/
skills/
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
  skills/
  tasks/
  tools/
tests/
```

## Prerequisites

1. Create these AWS Systems Manager Parameter Store `SecureString` parameters:
   - `/example/serverless-agent/slack-signing-secret`
   - `/example/serverless-agent/slack-bot-token`
   - `/example/serverless-agent/line-channel-secret`
   - `/example/serverless-agent/line-channel-access-token`
   - `/example/serverless-agent/google-calendar`
   - optional, for API-key-backed `web_search` providers:
     `/example/serverless-agent/web-search-api-key`

   Example:

   ```bash
   aws ssm put-parameter \
     --name /example/serverless-agent/line-channel-access-token \
     --type SecureString \
     --value 'YOUR_LINE_CHANNEL_ACCESS_TOKEN' \
     --overwrite
   ```

2. Ensure the target AWS account has access to Bedrock AgentCore and the
   configured Bedrock model IDs.
3. Install Docker for AgentCore container image builds.
4. Bootstrap CDK in the target AWS account and region.

## Local Development

For local agent development without Slack, API Gateway, or AgentCore Runtime,
use the offline chat CLI. It runs the same tool loop against Bedrock directly
and stores local memory, tasks, skills, calendar drafts, and session history in
a JSON state file.

```bash
cp .env.local.example .env.local
# Set BEDROCK_MODEL_ID in .env.local.
npm install
npm run dev:chat -- "Remember that local development uses file-backed state."
npm run dev:chat -- --session-id local-default "What do you remember?"
```

Defaults:

- workspace: `local-workspace`
- user: `local-user`
- channel: `local-channel`
- session: `local-default`
- state file: `.serverless-agent/local-state/state.json`

Useful options:

```bash
npm run dev:chat -- --help
npm run dev:chat -- --json "List my open tasks."
npm run dev:chat -- --session-id local-1 --state-file /tmp/serverless-agent-state.json "Hello"
```

Local development intentionally does not start a local Slack or HTTP server yet.
Browser tools and live Google Calendar API tools remain disabled in the local
runner. Calendar draft storage, memory, tasks, recurring tasks, skills, weather,
`web_extract`, and optionally configured `web_search` are available.

Google Calendar OAuth client parameter JSON:

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

For public forks or reusable deployments, keep this repository free of
environment-specific configuration. Put real account IDs, channel IDs, API base
URLs, SSM parameter names, and GitHub Actions deployment workflows in a separate
private deployment repository. Keep raw secret values in AWS SSM Parameter Store
or AWS Secrets Manager rather than in GitHub.

```bash
npm install
npx cdk deploy \
  -c defaultScheduleChannel=<slack-channel-id> \
  -c bedrockModelId=<bedrock-model-id> \
  -c bedrockDocumentModelId=<bedrock-document-model-id> \
  -c customSystemPrompt="$(cat ../private-deploy/prompts/product-system-prompt.md)" \
  -c systemPromptMode=append \
  -c publicBaseUrl=https://your-api-id.execute-api.ap-northeast-1.amazonaws.com/prod
```

Context options:

- `defaultScheduleChannel`: Slack channel used when the scheduled runner creates
  the fallback `daily-summary` task
- `bedrockModelId`: required Bedrock model used by the AgentCore runtime
- `bedrockDocumentModelId`: optional Bedrock model used when requests include
  image, PDF, or other binary document input. Defaults to `bedrockModelId` when
  omitted.
- `customSystemPrompt`: optional deployment-specific system prompt text. Keep
  product-specific instructions in a private deploy repository and pass them in
  at deploy time.
- `systemPromptMode`: optional custom prompt mode. `append` keeps the OSS
  default instructions and appends `customSystemPrompt`; `replace` uses only the
  custom prompt before skill summaries. Defaults to `append`.
- `publicBaseUrl`: deployed API base URL used in Slack replies, especially for
  Google Calendar OAuth links
- `slackSigningParameterName`: optional override for the Slack signing secret
  `SecureString` parameter
- `slackBotTokenParameterName`: optional override for the Slack bot token
  `SecureString` parameter
- `lineChannelSecretParameterName`: optional override for the LINE channel
  secret `SecureString` parameter
- `lineChannelAccessTokenParameterName`: optional override for the LINE channel
  access token `SecureString` parameter
- `googleCalendarParameterName`: optional override for the Google Calendar
  `SecureString` parameter
- `googleCalendarTimeZone`: optional override for calendar defaults
- `defaultResponseLanguage`: optional default language for scheduled reminders
  and other non-user-triggered runs, such as `ja` or `en`
- `schedulerScheduleNamePrefix`: optional override for EventBridge Scheduler
  schedule names. Defaults to `serverless-agent`.
- `schedulerScheduleGroupName`: optional EventBridge Scheduler group override.
  Defaults to `default`.
- `webSearchProvider`: optional search provider. Supported values are `brave`
  and `searxng`.
- `webSearchApiKeyParameterName`: optional `SecureString` parameter containing
  the provider API key. Required for `brave`; not required for `searxng`.
- `webSearchBaseUrl`: optional search provider base URL. Required for `searxng`.
  When no search provider is configured, `web_extract` still works for public
  URLs but `web_search` returns a configuration error.

After deploy, configure Slack with these CDK outputs:

- `SlackEventsUrl`: Slack Events API request URL
- `SlackInteractionsUrl`: Slack interactivity request URL
- `GoogleOAuthCallbackUrl`: Google OAuth redirect URI

Configure LINE with this CDK output:

- `LineWebhookUrl`: LINE Messaging API webhook URL

## AgentCore Runtime

The `SlackAgent` runtime is defined in `agentcore/agentcore.json` and implemented
by `src/agentcore/runtime.ts`.

The container build context lives under `app/SlackAgent/`. That directory points
back to the root TypeScript source and package metadata so the Lambda functions
and AgentCore runtime share the same domain logic and tool definitions.

Tool groups available inside AgentCore:

- skills: `load_skill`, `propose_skill`, `approve_skill`, `list_skills`,
  `disable_skill`
- durable memory: `search_memories`, `save_memory`,
  `promote_memory_to_workspace`
- web research: `web_search`, `web_extract`
- one-off tasks: `search_context`, `upsert_task`, `mark_task_done`
- recurring tasks: `list_recurring_tasks`, `upsert_recurring_task`,
  `disable_recurring_task`
- Google Calendar drafts: `list_google_calendars`, `list_calendar_events`,
  `find_free_busy`, `create_calendar_draft`, `list_calendar_drafts`,
  `apply_calendar_draft`, `discard_calendar_draft`

## Skills

Skills use Progressive Disclosure. The runtime injects only enabled skill
summaries into the system prompt. When a skill is relevant, the model calls
`load_skill` to load the full `SKILL.md` instructions.

Built-in skills live under `skills/builtin/*` with a `manifest.json` and
`SKILL.md`. `npm run generate-skills` compiles them into
`src/skills/builtinCatalog.generated.ts`, which is included in the AgentCore
container.

Generated skills are stored in `SkillsTable` under the current `workspaceId`,
which is the current tenant boundary. Generated skills are drafted from a
complete `SKILL.md` document with `name` and `description` frontmatter, then
enabled only after explicit approval. Built-in skill enablement can also be
overridden per `workspaceId`.

## Memory And Permissions

Current memory scopes:

- channel memory: shared context for the current Slack channel
- user preferences: cross-channel personal preferences for the current user
- workspace memory: workspace-level memory used by imports, direct chat fallback,
  and scheduled reminders

Provider bindings separate external chat IDs from internal workspaces:

- `workspaceId`: internal tenant or contract workspace
- `channelId`: provider conversation key such as `line:group:{groupId}` or a
  Slack channel ID
- `userId`: provider user key used for user preferences and OAuth ownership
- `providerAccountId`: provider-side account such as a Slack team ID or LINE
  webhook destination

Ingress functions resolve `workspaceId` through `ProviderBindingsTable` using
provider account and conversation keys. If no binding exists, Slack falls back
to the Slack team ID and LINE falls back to the LINE chat key, preserving local
OSS behavior while allowing deployments to map provider conversations into
internal workspaces.

Create or update a provider binding locally:

```bash
npm run put-provider-binding -- \
  --table-name YOUR_PROVIDER_BINDINGS_TABLE \
  --region ap-northeast-1 \
  --provider line \
  --provider-account-id <line-bot-user-id> \
  --binding-kind conversation \
  --provider-conversation-key group:<line-group-id> \
  --workspace-id <workspace-id> \
  --conversation-id line:group:<line-group-id>
```

Provider conversation key examples:

- LINE group: `group:{groupId}`
- LINE room: `room:{roomId}`
- LINE user: `user:{userId}`
- Slack channel: `channel:{channelId}`

Slack conversations prevent direct `save_memory` writes to workspace scope.
Inferred channel memory is saved as a candidate. Scheduled turns also default
proactive channel-memory writes to inferred candidates. After explicit user approval, the assistant can copy a
current-channel memory into workspace memory with `promote_memory_to_workspace`;
the promoted item keeps provenance for the original channel and memory ID.

Future work should add an admin surface for channel-level knowledge sharing
policies, approval queues, audit logs, and per-channel opt-in controls.

## Scheduled Reminders

EventBridge Scheduler invokes `scheduled-agent-runner` with a `taskId`.
Scheduled task definitions live in `ScheduledTasksTable`, while EventBridge
Scheduler owns the actual trigger. The assistant can create, list, edit,
disable, and delete scheduled reminders by using its scheduled reminder tools.
CDK does not create a fixed default reminder; create reminders from Slack, LINE,
or by writing a scheduled task definition and matching EventBridge schedule.

The runner also materializes enabled recurring task definitions for the next 7
days before building the reminder prompt. Scheduled reminders control when the
assistant posts; recurring task definitions control which repeated duties are
included in the reminder.

Recurring tasks support daily, weekly, monthly, and yearly rules. A yearly rule
uses `monthOfYear` with either a fixed `daysOfMonth` value or an nth weekday.
`leadTimeDays` moves the primary deadline before the event, and `dayOfTask` can
materialize a separate action on the event date. Existing open instances are
refreshed when those definition fields change.

Example scheduled task:

```json
{
  "pk": "TASK#daily-summary",
  "taskId": "daily-summary",
  "name": "Daily Summary",
  "prompt": "Summarize yesterday's activity and post a concise update.",
  "workspaceId": "workspace_demo",
  "outputChannelId": "slack_channel_demo",
  "outputProvider": "slack",
  "outputConversationKey": "channel:slack_channel_demo",
  "enabled": true,
  "scheduleName": "serverless-agent-daily-summary-dc0570d6ff",
  "scheduleGroupName": "default",
  "scheduleExpression": "cron(0 8 * * ? *)",
  "scheduleExpressionTimezone": "Asia/Tokyo",
  "reuseSession": false,
  "createdAt": "2026-04-13T00:00:00.000Z",
  "updatedAt": "2026-04-13T00:00:00.000Z"
}
```

Example Slack requests:

```text
@AI Post a task reminder every morning at 8.
@AI Move the morning task reminder to 9.
@AI List scheduled reminders.
@AI Delete the morning task reminder.
```

When a reminder is created from LINE without an explicit output target, the
assistant posts it back to the same LINE user, group, or room. LINE scheduled
task targets use `outputProvider: "line"`, `outputChannelId:
"line:group:{groupId}"`, and `outputConversationKey: "group:{groupId}"`.

Create or update a scheduled task definition locally:

```bash
npx ts-node scripts/put-scheduled-task.ts \
  --table-name YOUR_SCHEDULED_TASKS_TABLE \
  --region ap-northeast-1 \
  --workspace-id <workspace-id> \
  --output-channel-id <slack-channel-id> \
  --output-provider slack \
  --prompt "Summarize open tasks and upcoming deadlines."
```

Example recurring task:

```json
{
  "pk": "WORKSPACE#workspace_demo",
  "sk": "RECURRING_TASK#rt_example_weekly_report",
  "recurringTaskId": "rt_example_weekly_report",
  "workspaceId": "workspace_demo",
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
  --workspace-id <workspace-id> \
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
  --workspace-id <workspace-id> \
  --user-id U0123456789 \
  --region ap-northeast-1 \
  --wait \
  private-docs
```

## Markdown Ingestion

Markdown ingestion uses the same `SourceDocumentsTable`, private S3 archive
bucket, and import worker. Repeating rules such as weekly, monthly, or yearly duties
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
  --workspace-id <workspace-id> \
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
  --workspace-id <workspace-id> \
  --user-id local-user \
  --region ap-northeast-1 \
  "What should I do today?"
```

To continue the same conversation, pass the returned `session_id` back:

```bash
npm run ask-agent -- \
  --api-base-url https://YOUR_API_ID.execute-api.ap-northeast-1.amazonaws.com/prod \
  --workspace-id <workspace-id> \
  --user-id local-user \
  --region ap-northeast-1 \
  --session-id sess_... \
  "Show only the items due tonight."
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
- Keep Slack signing secrets, bot tokens, LINE tokens, and Google OAuth client
  secrets in SSM Parameter Store `SecureString` parameters only.
- Keep optional web search provider API keys in SSM Parameter Store as
  `SecureString` values; `web_extract` blocks localhost, private IPs, and
  credentialed URLs before fetching.
- `imports/*` and `/chat/messages` routes use `AWS_IAM` authorization.
- Local scripts sign requests with SigV4 using the current AWS credentials.
- IAM principals running local scripts need `execute-api:Invoke` permission for
  the relevant API routes.

## Roadmap

Near-term post-`v0.2.0` work:

- LINE adapter hardening beyond basic text webhook support
- admin page for channel-level workspace memory promotion policies
- explicit approval flow for promoting channel memory to workspace memory
- source provenance and audit logs for workspace-visible knowledge
- platform adapter interface that can support Slack, LINE, and optional Discord
- Discord adapter after the Slack/LINE boundaries are stable

## License

MIT
