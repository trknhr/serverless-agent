export const customToolDefinitions = [
  {
    name: "load_skill",
    description:
      "Load the full instructions for one enabled skill listed in the system prompt. Use this before following a skill workflow. Do not invent skill IDs.",
    input_schema: {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          description: "The exact skill ID from the available skills list.",
          maxLength: 128,
        },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "read_attachment_image",
    description:
      "Analyze a short-lived archived image attachment by source_id and return a text description or transcription. Only use source IDs that were explicitly provided in the current conversation context. Use this when the user asks about an attached, recent, or referenced image; do not use it for unrelated requests.",
    input_schema: {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          description: "Archived image source ID from the current attachment manifest, such as src_abc123.",
        },
        question: {
          type: "string",
          description:
            "The specific user question to answer from the image. Include what to read, describe, compare, or extract.",
          maxLength: 2000,
        },
      },
      required: ["source_id"],
    },
  },
  {
    name: "normalize_date",
    description:
      "deterministic date normalization for user text, image OCR, PDFs, and document snippets. Use this before answering with, saving, or scheduling a date from extracted text. It keeps original date text separate from the resolved date, validates weekdays, and flags dates before the basis date.",
    input_schema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Original date text or short phrase to normalize, such as 7/13, 7月13日, tomorrow, or 今日.",
          maxLength: 200,
        },
        basis_date: {
          type: "string",
          description: "Current local date in YYYY-MM-DD used to infer missing years and past/today status.",
        },
        timezone: {
          type: "string",
          description: "IANA time zone such as Asia/Tokyo. Omit to use the assistant default.",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "propose_skill",
    description:
      "Create or update a proposed generated skill from a complete SKILL.md document only after explicit confirmation that the user wants a reusable skill draft. Do not call propose_skill based only on inferred intent. This does not enable the skill; ask for approval before calling approve_skill.",
    input_schema: {
      type: "object",
      properties: {
        skill_markdown: {
          type: "string",
          description:
            "Complete SKILL.md text with YAML frontmatter containing name and description, followed by concise Markdown workflow instructions.",
        },
        trigger_hints: {
          type: "array",
          items: { type: "string" },
          maxItems: 12,
          description: "Short phrases that should trigger this skill.",
        },
        tool_allowlist: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
          description: "Tool names the skill is expected to use.",
        },
        constraints: {
          type: "object",
          description: "Optional execution constraints such as maxToolCalls or requiresConfirmation.",
        },
        evaluation_notes: {
          type: "string",
          description: "Short notes about how this skill should be evaluated before approval.",
        },
        test_cases: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              prompt: { type: "string" },
              expected_behavior: { type: "string" },
            },
            required: ["name", "prompt", "expected_behavior"],
          },
          description: "Concrete examples used to validate the generated skill before approval.",
        },
        version: { type: "string", description: "Skill version. Defaults to 0.1.0." },
      },
      required: ["skill_markdown", "evaluation_notes", "test_cases"],
    },
  },
  {
    name: "approve_skill",
    description:
      "Approve a generated skill after the user explicitly approves the draft. This validates the draft but does not enable it.",
    input_schema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "enable_skill",
    description:
      "Enable an approved or disabled generated skill after the user explicitly asks to make it active.",
    input_schema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "reject_skill",
    description: "Reject a proposed generated skill after the user explicitly declines the draft.",
    input_schema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "archive_skill",
    description:
      "Archive a generated skill after explicit confirmation. Enabled skills must be disabled before archiving.",
    input_schema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "list_skills",
    description:
      "List built-in and generated skills for this workspace, including generated drafts and disabled skills.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["builtin", "generated", "all"] },
        statuses: {
          type: "array",
          items: { type: "string", enum: ["proposed", "approved", "enabled", "disabled", "rejected", "archived"] },
        },
      },
    },
  },
  {
    name: "disable_skill",
    description:
      "Disable a generated skill so it no longer appears in the available skill summaries. This does not delete the skill.",
    input_schema: {
      type: "object",
      properties: {
        skill_id: { type: "string" },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "search_context",
    description:
      "Unified read-only search for answering user questions before choosing a domain-specific tool. Use this first for definitions, short-term references, past-context questions, task keyword searches, current task lists, and general lookup requests. It searches saved memories and tracked tasks together by default, plus recurring task definitions when available. For current task lists, pass task_statuses or task_due_before and either omit query or set query=\"\". For uncertain private-context lookups, provide 2-5 agent-chosen alternate queries in queries or call search_context again before concluding the context is unknown; include translated terms, exact IDs, and short keyword-only variants for mixed-language or noisy prompts. Set include_web=true only when the answer likely depends on current or public web information. Use the returned task_id, recurring_task_id, or memory_id with specialized tools only when a follow-up update is needed.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          maxLength: 400,
          description: "The exact term, noun phrase, or question to search for.",
        },
        queries: {
          type: "array",
          items: { type: "string", maxLength: 400 },
          maxItems: 5,
          description:
            "Optional agent-chosen alternate private-context queries to run in the same tool call, such as translated terms, exact IDs, or short keyword-only variants. Do not rely on the tool to generate synonyms or spelling variants.",
        },
        task_statuses: {
          type: "array",
          items: { type: "string", enum: ["open", "in_progress", "done", "cancelled"] },
          description: "Optional task statuses for current task lists or filtered task search.",
        },
        task_due_before: {
          type: "string",
          description: "Optional RFC3339 timestamp upper bound for current task lists or filtered task search.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum saved-context results per source. Defaults to each source's normal limit.",
        },
        include_web: {
          type: "boolean",
          description:
            "Set true for current facts, public documentation, news, or external topics. Leave false for private Slack, memory, or task context.",
        },
        country: {
          type: "string",
          description: "Optional two-letter country code for public web results, such as JP or US.",
        },
        language: {
          type: "string",
          description: "Optional language code for public web results, such as ja or en.",
        },
        freshness: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Optional public web recency filter.",
        },
        domains: {
          type: "array",
          items: { type: "string" },
          maxItems: 5,
          description: "Optional public web domains to restrict with site: filters.",
        },
      },
    },
  },
  {
    name: "save_memory",
    description:
      "Create or update one durable memory after the user directly asks to remember it or approves saving it. For proactive inferred memory, explicitly set origin=inferred so it remains a candidate. Use scope=user_preference for personal preferences and scope=channel for channel-shared facts. Before correcting or enriching an existing fact, call search_context and pass its memory_id plus expected_updated_at=<returned updated_at> back here. For new channel facts, provide a stable one-fact dedupe_key such as person:hanako:birthday; retries with that key update the same memory. In Slack conversations, do not use scope=workspace. Save one memory per fact and do not save transient chatter or daily summaries. For date-bearing memories, save one date per memory with one attributes.date_validation object; for multiple dates, call save_memory separately for each date. When durable facts come from a user-supplied image, PDF, document, or attachment, call this only after the user asks to remember them or approves saving.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "One concise durable fact, preference, or rule. Do not combine unrelated facts.",
        },
        scope: {
          type: "string",
          enum: ["channel", "user_preference", "workspace"],
          description:
            "Where this memory should live. Prefer channel for channel-shared durable context, user_preference for personal preferences, and workspace only for legacy import or non-channel contexts.",
        },
        origin: {
          type: "string",
          enum: ["explicit", "inferred", "imported"],
          description:
            "Use explicit only when the user directly asked to remember or always apply the fact. Use inferred for facts derived from conversation. Use imported for document/import sources.",
        },
        memory_id: {
          type: "string",
          description:
            "Existing current-channel memory ID returned by search_context. Provide this when correcting or enriching a saved fact.",
        },
        dedupe_key: {
          type: "string",
          description:
            "Stable identity for one channel fact, such as person:hanako:birthday. Do not reuse one key for multiple facts.",
        },
        expected_updated_at: {
          type: "string",
          description:
            "The existing memory updated_at value returned by search_context, used to prevent overwriting a newer change.",
        },
        entity_key: {
          type: "string",
          description: "Stable key like person:hanako, project:renovation, place:home, or vendor:costco.",
        },
        preference_key: {
          type: "string",
          description:
            "Optional stable key for user_preference entries such as preferred_name, response_language, writing_style, or format_preference.",
        },
        attributes: {
          type: "object",
          description:
            "Structured details such as aliases, dates, constraints, confidence, or source snippets. For birthdays use date_kind=birthday. Set include_in_daily_reminder=true only for an actionable dated fact that should appear in scheduled summaries.",
        },
        tags: {
          type: "array",
          description: "Short category labels such as preference, family, schedule, project, shopping, or rule.",
          items: { type: "string" },
        },
        importance: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["text"],
    },
  },
  {
    name: "promote_memory_to_workspace",
    description:
      "Promote an existing current-channel memory to workspace memory after the user explicitly approves sharing it beyond the current channel. Use search_context first when you need the channel memory_id. This copies the memory to workspace scope and preserves provenance; it does not delete the channel memory.",
    input_schema: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "The channel memory_id to promote, usually returned by search_context.",
        },
        entity_key: {
          type: "string",
          description: "Optional replacement workspace entity key. Defaults to the channel memory entity_key.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional additional tags to add to the promoted workspace memory.",
        },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "Optional replacement importance. Defaults to the channel memory importance.",
        },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "web_extract",
    description:
      "Fetch and extract readable text from a public http or https URL. Use this to verify a search result or inspect a user-provided page. Do not use for private, localhost, intranet, or credentialed URLs.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Public http or https URL to fetch.",
        },
        max_chars: {
          type: "integer",
          minimum: 500,
          maximum: 20000,
          description: "Maximum extracted text characters to return. Defaults to 6000.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_start",
    description:
      "Start a short-lived browser session for public interactive web pages. Use only when fetch-based web_extract is insufficient for JavaScript-rendered or interactive content.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          maxLength: 120,
          description: "Optional human-readable session name.",
        },
        width: {
          type: "integer",
          minimum: 800,
          maximum: 1920,
          description: "Viewport width in pixels. Defaults to 1280.",
        },
        height: {
          type: "integer",
          minimum: 600,
          maximum: 1080,
          description: "Viewport height in pixels. Defaults to 720.",
        },
      },
    },
  },
  {
    name: "browser_open_url",
    description:
      "Open a public http or https URL in an active browser session. Do not use for private, localhost, intranet, credentialed, or user-authenticated URLs.",
    input_schema: {
      type: "object",
      properties: {
        browser_session_id: {
          type: "string",
          description: "Browser session ID returned by browser_start. Defaults to the latest active session.",
        },
        url: {
          type: "string",
          description: "Public http or https URL to open.",
        },
        wait_until: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle"],
          description: "Navigation readiness signal. Defaults to domcontentloaded.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 60000,
          description: "Navigation timeout in milliseconds. Defaults to 30000.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Return the current page URL, title, and visible text from an active browser session. Screenshots are not returned as raw image data.",
    input_schema: {
      type: "object",
      properties: {
        browser_session_id: {
          type: "string",
          description: "Browser session ID returned by browser_start. Defaults to the latest active session.",
        },
        max_chars: {
          type: "integer",
          minimum: 500,
          maximum: 12000,
          description: "Maximum visible text characters to return. Defaults to 4000.",
        },
      },
    },
  },
  {
    name: "browser_extract",
    description:
      "Extract visible text from the current browser page, optionally scoped to a CSS selector. Use for public JavaScript-rendered pages after browser_open_url.",
    input_schema: {
      type: "object",
      properties: {
        browser_session_id: {
          type: "string",
          description: "Browser session ID returned by browser_start. Defaults to the latest active session.",
        },
        selector: {
          type: "string",
          maxLength: 500,
          description: "Optional CSS selector to scope extraction.",
        },
        max_chars: {
          type: "integer",
          minimum: 500,
          maximum: 20000,
          description: "Maximum extracted text characters to return. Defaults to 6000.",
        },
      },
    },
  },
  {
    name: "browser_close",
    description: "Close an active browser session when browser work is complete.",
    input_schema: {
      type: "object",
      properties: {
        browser_session_id: {
          type: "string",
          description: "Browser session ID returned by browser_start. Defaults to the latest active session.",
        },
      },
    },
  },
  {
    name: "upsert_task",
    description:
      "Create or update a one-off task, dated event, or checklist item after reasoning about future work or calendar events. Use this, not create_scheduled_reminder, for content that should appear inside an existing daily reminder.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["open", "in_progress", "done", "cancelled"] },
        due_at: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        calendar_event_id: { type: "string" },
        source_type: { type: "string" },
        source_ref: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["title"],
    },
  },
  {
    name: "patch_task",
    description:
      "Safely apply a partial update to an existing tracked task while preserving fields that are not provided. Use search_context first when the user describes the task but does not provide a task_id. Pass expected_updated_at from search_context when available to avoid overwriting a task that changed after it was loaded.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        expected_updated_at: {
          type: "string",
          description: "Optional updated_at value returned by search_context for optimistic conflict checks.",
        },
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["open", "in_progress", "done", "cancelled"] },
        due_at: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        calendar_event_id: { type: "string" },
        source_type: { type: "string" },
        source_ref: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "mark_task_done",
    description: "Mark a task as done when the user says it is completed or the agent confirms completion.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        completed_at: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "list_recurring_tasks",
    description:
      "List recurring task definitions such as weekly chores, monthly reports, or repeating reminders. These are recurrence rules, not one-off task instances.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "upsert_recurring_task",
    description:
      "Create or update a recurring task definition. Supports daily, weekly, monthly, and yearly rules. For yearly rules, always provide month_of_year and either one days_of_month value or one days_of_week value with week_of_month; never approximate yearly with monthly interval=12. Use lead_time_days when the action is due before the event. If the user also wants a distinct action on the event day, provide day_of_task. Do not create one-off tasks for recurring rules unless the user asks for a specific occurrence.",
    input_schema: {
      type: "object",
      properties: {
        recurring_task_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        recurrence: {
          type: "object",
          properties: {
            frequency: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
            interval: { type: "integer", minimum: 1, maximum: 12 },
            month_of_year: {
              type: "integer",
              minimum: 1,
              maximum: 12,
              description: "Required for yearly recurrence; 1 is January and 12 is December.",
            },
            days_of_week: {
              type: "array",
              items: {
                type: "string",
                enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
              },
            },
            days_of_month: {
              type: "array",
              items: { type: "integer", minimum: 1, maximum: 31 },
            },
            week_of_month: {
              anyOf: [
                { type: "integer", minimum: 1, maximum: 5 },
                { type: "string", enum: ["last"] },
              ],
            },
          },
          required: ["frequency"],
        },
        lead_time_days: {
          type: "integer",
          minimum: 0,
          maximum: 366,
          description: "How many days before the recurrence event the primary task is due.",
        },
        day_of_task: {
          type: "object",
          description:
            "Optional second task due on the recurrence event day. Use only when lead_time_days is greater than zero.",
          properties: {
            enabled: { type: "boolean" },
            title: { type: "string" },
            description: { type: "string" },
            due_time: {
              type: "string",
              pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
              description: "Local due time in HH:mm.",
            },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["title"],
        },
        due_time: {
          type: "string",
          pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
          description: "Local due time in HH:mm, for example 21:00 or 23:59.",
        },
        timezone: { type: "string", description: "IANA time zone such as Asia/Tokyo." },
        enabled: { type: "boolean" },
        owner_user_id: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        source_type: { type: "string" },
        source_ref: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["title", "recurrence"],
    },
  },
  {
    name: "disable_recurring_task",
    description: "Disable a recurring task definition so future occurrences are no longer generated.",
    input_schema: {
      type: "object",
      properties: {
        recurring_task_id: { type: "string" },
      },
      required: ["recurring_task_id"],
    },
  },
  {
    name: "list_scheduled_reminders",
    description:
      "List assistant-generated scheduled reminders for this workspace. These control when the assistant posts recurring notifications, not which duties appear inside a reminder. Use this before deleting an accidental individual reminder when the user says it should be included in the daily reminder instead. Do not list these just to add ordinary event content to a daily reminder.",
    input_schema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "create_scheduled_reminder",
    description:
      "Create a recurring chat notification generated by the assistant, such as a daily morning task reminder. Use this only when the user explicitly asks for an individual reminder, a separate reminder, or a new notification schedule. By default, post back to the current Slack channel or LINE conversation. Do not use it for one-off events, packing lists, or details that should appear inside an existing daily reminder; use upsert_task, upsert_recurring_task, or save_memory for those contents.",
    input_schema: {
      type: "object",
      properties: {
        scheduled_task_id: { type: "string" },
        name: { type: "string", description: "Short user-facing name, for example Morning task reminder." },
        prompt: {
          type: "string",
          description: "Instruction for what the assistant should do when the reminder runs.",
        },
        recurrence: {
          type: "object",
          properties: {
            frequency: { type: "string", enum: ["daily", "weekly", "monthly"] },
            time: { type: "string", description: "Local delivery time in HH:mm format, for example 08:00." },
            days_of_week: {
              type: "array",
              items: {
                type: "string",
                enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
              },
            },
            days_of_month: {
              type: "array",
              items: { type: "integer", minimum: 1, maximum: 31 },
            },
          },
          required: ["frequency", "time"],
        },
        schedule_expression: {
          type: "string",
          description: "Optional raw EventBridge Scheduler expression such as cron(0 8 * * ? *).",
        },
        timezone: { type: "string", description: "IANA time zone such as Asia/Tokyo." },
        output_channel_id: { type: "string" },
        output_provider: { type: "string", enum: ["slack", "line"] },
        output_provider_account_id: {
          type: "string",
          description: "Optional provider-side account such as a Slack team ID or LINE bot destination.",
        },
        output_conversation_key: {
          type: "string",
          description: "Provider conversation key such as channel:C123 for Slack or group:G123, room:R123, user:U123 for LINE.",
        },
        enabled: { type: "boolean" },
      },
      required: ["name", "prompt"],
    },
  },
  {
    name: "update_scheduled_reminder",
    description:
      "Update a recurring chat notification generated by the assistant, including its name, prompt, output channel, enabled state, or delivery schedule. Use this only for explicit changes to a separate notification schedule. Do not use this to add one-off event details to a daily reminder; store those details with task, recurring task, or memory tools.",
    input_schema: {
      type: "object",
      properties: {
        scheduled_task_id: { type: "string" },
        name: { type: "string" },
        prompt: { type: "string" },
        recurrence: {
          type: "object",
          properties: {
            frequency: { type: "string", enum: ["daily", "weekly", "monthly"] },
            time: { type: "string", description: "Local delivery time in HH:mm format, for example 08:00." },
            days_of_week: {
              type: "array",
              items: {
                type: "string",
                enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
              },
            },
            days_of_month: {
              type: "array",
              items: { type: "integer", minimum: 1, maximum: 31 },
            },
          },
          required: ["frequency", "time"],
        },
        schedule_expression: { type: "string" },
        timezone: { type: "string", description: "IANA time zone such as Asia/Tokyo." },
        output_channel_id: { type: "string" },
        output_provider: { type: "string", enum: ["slack", "line"] },
        output_provider_account_id: {
          type: "string",
          description: "Optional provider-side account such as a Slack team ID or LINE bot destination.",
        },
        output_conversation_key: {
          type: "string",
          description: "Provider conversation key such as channel:C123 for Slack or group:G123, room:R123, user:U123 for LINE.",
        },
        enabled: { type: "boolean" },
      },
      required: ["scheduled_task_id"],
    },
  },
  {
    name: "delete_scheduled_reminder",
    description:
      "Delete a recurring Slack notification generated by the assistant and remove its scheduler trigger. Use this when the user corrects an accidental individual reminder and wants the item included in an existing daily reminder instead.",
    input_schema: {
      type: "object",
      properties: {
        scheduled_task_id: { type: "string" },
      },
      required: ["scheduled_task_id"],
    },
  },
  {
    name: "get_weather_forecast",
    description:
      "Get a daily weather forecast for a location and date. Use this when a reminder or user request asks for weather, rain, temperature, or umbrella guidance.",
    input_schema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City, ward, or place name such as Tokyo, Shibuya, or Yokohama.",
        },
        date: {
          type: "string",
          description: "Optional forecast date in YYYY-MM-DD. Omit for today in the requested time zone.",
        },
        timezone: {
          type: "string",
          description: "IANA time zone such as Asia/Tokyo. Omit to use the assistant default.",
        },
      },
      required: ["location"],
    },
  },
  {
    name: "start_google_calendar_authorization",
    description:
      "Start Google Calendar OAuth authorization for the current user. Only use this when the user explicitly asks to connect, authorize, link, or sign in to Google Calendar. Do not use this for ordinary reminders, recurring tasks, household chores, or schedule notes. This returns authorization guidance only; it does not read or write calendar data.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_google_calendars",
    description:
      "List Google calendars available to the connected user, including access roles. Use this before targeting a named non-primary calendar such as Family.",
    input_schema: {
      type: "object",
      properties: {
        min_access_role: {
          type: "string",
          enum: ["freeBusyReader", "reader", "writer", "owner"],
          description:
            "Minimum access role to return. Use reader to find readable calendars, writer to find calendars where events can be created.",
        },
        query: { type: "string", description: "Optional calendar name search, such as Family." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "list_calendar_events",
    description:
      "Inspect Google Calendar events before creating or changing anything. Use this to avoid duplicates and review what is already on the calendar. Use calendar_name when the user names a non-primary calendar such as Family.",
    input_schema: {
      type: "object",
      properties: {
        calendar_id: { type: "string" },
        calendar_name: {
          type: "string",
          description: "Human calendar name to resolve with reader access or higher, such as Family.",
        },
        time_min: { type: "string", description: "RFC3339 lower bound for the event search window." },
        time_max: { type: "string", description: "RFC3339 upper bound for the event search window." },
        time_zone: { type: "string", description: "IANA time zone for the response, such as Asia/Tokyo." },
        query: { type: "string", description: "Optional free-text search over summary, description, or location." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "find_free_busy",
    description: "Check Google Calendar busy blocks in a given time range before proposing or scheduling timed events.",
    input_schema: {
      type: "object",
      properties: {
        calendar_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional calendar IDs. Omit to query the default connected calendar.",
        },
        calendar_names: {
          type: "array",
          items: { type: "string" },
          description: "Optional calendar names to resolve with free/busy access or higher, such as Family.",
        },
        time_min: { type: "string", description: "RFC3339 lower bound." },
        time_max: { type: "string", description: "RFC3339 upper bound." },
        time_zone: { type: "string", description: "IANA time zone for the response, such as Asia/Tokyo." },
      },
      required: ["time_min", "time_max"],
    },
  },
  {
    name: "create_calendar_draft",
    description:
      "Save calendar event candidates for review before any Google Calendar write. Present the returned draft to the user and wait for explicit approval before applying it.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        notes: { type: "string" },
        source_id: { type: "string" },
        source_ref: { type: "string" },
        calendar_id: { type: "string" },
        calendar_name: {
          type: "string",
          description: "Human calendar name to resolve with writer access or higher, such as Family.",
        },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              candidate_id: { type: "string" },
              summary: { type: "string" },
              description: { type: "string" },
              location: { type: "string" },
              all_day: { type: "boolean" },
              start_date: {
                type: "string",
                description: "Date-only YYYY-MM-DD. For all-day events, end_date is inclusive if provided.",
              },
              end_date: { type: "string", description: "Inclusive final date for an all-day event." },
              start_at: { type: "string", description: "RFC3339 start time for a timed event." },
              end_at: { type: "string", description: "RFC3339 end time for a timed event." },
              time_zone: { type: "string" },
              source_text: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              dedupe_key: {
                type: "string",
                description: "Optional stable key used to update the same Google Calendar event on re-import.",
              },
            },
            required: ["summary"],
          },
          minItems: 1,
        },
      },
      required: ["candidates"],
    },
  },
  {
    name: "list_calendar_drafts",
    description: "List recent Google Calendar drafts and their candidate statuses so you can recover or continue a review flow.",
    input_schema: {
      type: "object",
      properties: {
        statuses: {
          type: "array",
          items: { type: "string", enum: ["pending", "approved", "applied", "rejected"] },
        },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: "apply_calendar_draft",
    description:
      "Create or update Google Calendar events from a previously previewed draft only after the user explicitly approves the selected candidates.",
    input_schema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        calendar_id: { type: "string" },
        calendar_name: {
          type: "string",
          description: "Human calendar name to resolve with writer access or higher, such as Family.",
        },
        candidate_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of candidate IDs to apply. Omit to apply all pending candidates.",
        },
      },
      required: ["draft_id"],
    },
  },
  {
    name: "discard_calendar_draft",
    description:
      "Reject some or all pending candidates from a previously previewed calendar draft when the user does not want them created.",
    input_schema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        candidate_ids: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of candidate IDs to reject. Omit to reject all pending candidates.",
        },
      },
      required: ["draft_id"],
    },
  },
] as const;
