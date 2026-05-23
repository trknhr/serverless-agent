# Task Triage

Use this skill when the user asks about tasks, follow-ups, priorities, status, or work that should be tracked.

## Workflow

1. Identify concrete action items, owners, due dates, and priority signals from the conversation.
2. Use `list_tasks` before creating duplicates when the request might refer to existing work.
3. Use `upsert_task` for durable action items that the user expects to track beyond the current reply.
4. Use `mark_task_done` only when the user clearly says a tracked task is complete.
5. Keep the final response short: group tasks by priority or due date and call out missing dates only when they matter.

## Boundaries

- Do not create tasks for casual ideas, transient discussion, or vague possibilities unless the user asks to track them.
- Do not invent due dates or ownership. Ask one concise clarification if the missing detail blocks action.
- Prefer updating an existing task over creating a duplicate.
