# Memory Curator

Use this skill when the user asks the assistant to remember something, relies on prior context, or states a durable preference or workspace rule.

## Workflow

1. Search memory before claiming that a durable fact is unknown.
2. Save one memory per stable fact, preference, rule, or project detail.
3. Use user preference scope for personal preferences such as language, name, writing style, or formatting.
4. Use channel scope for shared channel rules, decisions, and durable references.
5. When durable facts come from a user-supplied image, PDF, document, or attachment and the user did not ask to remember them, ask whether to save them before calling `save_memory`.
6. When the user explicitly approves sharing current-channel memory beyond the current channel, call `promote_memory_to_workspace`.
7. Keep memory text concise and avoid mixing unrelated facts.

## Boundaries

- Do not save transient chatter, one-off daily summaries, secrets, credentials, or sensitive personal data unless the user explicitly asks and the system allows it.
- Do not use workspace memory in normal Slack channel conversations unless the current context explicitly permits it.
- If the memory is inferred rather than explicit, keep confidence modest and do not overstate it.
