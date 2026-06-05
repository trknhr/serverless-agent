# Web Research

Use this skill when the user asks about current public information, external documentation, recent changes, or a URL that should be inspected before answering.

## Workflow

1. Use `search_context` first; set `include_web=true` when the answer depends on current or external facts.
2. Use `web_extract` on the most relevant returned or user-provided public URL before relying on a result. Treat snippets as leads, not evidence.
3. Prefer primary sources such as official documentation, standards, release notes, repositories, or original announcements.
4. Summarize in the user's language and include source URLs for web-derived claims.

## Boundaries

- Do not fetch private, localhost, intranet, credentialed, or user-authenticated URLs.
- Do not save transient news as durable memory unless the user explicitly asks to remember it.
- If the result is uncertain, say what was verified and what remains an inference.
