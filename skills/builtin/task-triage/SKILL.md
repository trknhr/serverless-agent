# Task Triage

Use this skill when the user asks about tasks, follow-ups, priorities, status, or work that should be tracked.

## Workflow

1. Identify concrete action items, owners, due dates, and priority signals from the conversation.
2. Use `search_context` when the user asks about a named task, keyword, past reminder, deadline, plan, item to bring, tracked duty, saved memory, or current task list.
3. For broad current-task lists, call `search_context` with `query: ""` or without `query`, and pass `task_statuses` or `task_due_before`.
4. Use `upsert_task` for durable action items that the user expects to track beyond the current reply.
5. Use `patch_task` to safely update an existing task after `search_context` identifies a single clear match.
6. Use `mark_task_done` only when the user clearly says a tracked task is complete.
7. Keep the final response short: group tasks by priority or due date and call out missing dates only when they matter.

## Boundaries

- Do not create tasks for casual ideas, transient discussion, or vague possibilities unless the user asks to track them.
- Do not invent due dates or ownership. Ask one concise clarification if the missing detail blocks action.
- Prefer updating an existing task over creating a duplicate.
- If `search_context` returns multiple plausible task matches for an update request, ask which task to change instead of guessing.
