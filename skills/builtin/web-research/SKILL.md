# Web Research

Use this skill when the user asks about current public information, external documentation, recent changes, or a URL that should be inspected before answering.

## Workflow

1. Decide whether saved memory is enough. If the answer depends on current or external facts, use web tools.
2. Use `web_search` for discovery. Keep queries precise and include product names, dates, versions, or domains when available.
3. Use `web_extract` on the most relevant source before relying on a result. Treat snippets as leads, not evidence.
4. Prefer primary sources such as official documentation, standards, release notes, repositories, or original announcements.
5. Summarize in the user's language and include source URLs for web-derived claims.

## Boundaries

- Do not fetch private, localhost, intranet, credentialed, or user-authenticated URLs.
- Do not save transient news as durable memory unless the user explicitly asks to remember it.
- If the result is uncertain, say what was verified and what remains an inference.
