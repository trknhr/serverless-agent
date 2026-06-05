export const MEMORY_RESOURCE_PROMPT = [
  "Durable channel memory and user preference memory.",
  "Before answering questions that may depend on past context, call search_context.",
  "If the first search is weak, retry with 2-3 alternate queries using synonyms, related entities, and broader or narrower phrasing.",
  "Channel memory is for stable channel-shared rules, decisions, references, and definitions.",
  "User preference memory is for personal preferences like preferred name, response language, writing style, or formatting preferences.",
  "Do not store private personal facts in channel memory.",
  "Only save durable high-value facts, preferences, and reusable rules.",
  "Save one memory per fact.",
  "Use save_memory scope=channel for current-channel durable context.",
  "Use save_memory scope=user_preference for cross-channel personal preferences.",
  "In Slack conversations, do not use save_memory scope=workspace. Use promote_memory_to_workspace after explicit approval to share a channel memory beyond the current channel.",
  "Set save_memory origin=explicit only when the user directly asks you to remember or always apply something; otherwise set origin=inferred.",
  "Use stable entity_key values such as person:hanako, project:renovation, place:home, or vendor:costco when possible.",
  "Use short category tags such as preference, family, schedule, rule, project, or shopping.",
  "Do not save transient chatter, one-off daily summaries, or low-value noise.",
].join(" ");

export const SCHEDULED_MEMORY_RESOURCE_PROMPT = [
  "Shared durable memory for this scheduled task.",
  "Search it before answering when prior context may matter.",
  "If the first search is weak, retry with alternate queries before concluding the memory is missing.",
  "Save only durable task-scoped facts and rules, with one memory per fact.",
  "Do not save transient daily status unless it will remain useful later.",
].join(" ");

export const DOCUMENT_IMPORT_MEMORY_INSTRUCTIONS = [
  "Save durable facts with save_memory when they are useful long-term.",
  "When saving memories, split them into atomic facts instead of one long summary.",
  "Use stable entity_key values such as person:..., project:..., place:..., or vendor:... when possible.",
  "Use short category tags such as preference, family, schedule, project, shopping, or rule.",
  "Use upsert_recurring_task for repeating duties or reminders such as daily, weekly, or monthly tasks.",
  "Save actionable items with upsert_task when the document contains deadlines, events, or follow-up actions.",
  "Do not turn a recurring rule into a one-off task unless the document names a specific dated occurrence.",
  "Do not save low-value noise.",
  "Reply with a concise summary of what you captured.",
].join(" ");
