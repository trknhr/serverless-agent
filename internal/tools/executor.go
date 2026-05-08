package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/trknhr/slack-ai-assistant/internal/anthropic"
	"github.com/trknhr/slack-ai-assistant/internal/calendar"
	"github.com/trknhr/slack-ai-assistant/internal/idgen"
	"github.com/trknhr/slack-ai-assistant/internal/logger"
	"github.com/trknhr/slack-ai-assistant/internal/memory"
	"github.com/trknhr/slack-ai-assistant/internal/repo"
	"github.com/trknhr/slack-ai-assistant/internal/tasks"
)

const defaultCalendarTimeZone = "Asia/Tokyo"

var calendarPrivatePropertyKeys = map[string]string{
	"draftId":     "slackai_draft",
	"candidateId": "slackai_candidate",
	"dedupeKey":   "slackai_dedupe",
	"workspaceId": "slackai_workspace",
	"sourceId":    "slackai_source",
}

var calendarToolNames = map[string]struct{}{
	"list_google_calendars": {},
	"list_calendar_events":  {},
	"find_free_busy":        {},
	"create_calendar_draft": {},
	"apply_calendar_draft":  {},
}

type ToolExecutionContext struct {
	WorkspaceID       string
	UserID            string
	ChannelID         string
	Logger            *logger.Logger
	MemoryWritePolicy *MemoryWritePolicy
}

type MemoryWritePolicy struct {
	AllowWorkspaceMemory  bool
	ChannelInferredStatus string
	DefaultOrigin         string
}

type Repositories struct {
	MemoryItems     *repo.MemoryItemRepository
	ChannelMemories *repo.ChannelMemoryRepository
	UserPreferences *repo.UserPreferenceRepository
	Tasks           *repo.TaskStateRepository
	TaskEvents      *repo.TaskEventRepository
	CalendarDrafts  *repo.CalendarDraftRepository
}

type Integrations struct {
	GoogleCalendar          *calendar.GoogleCalendarClient
	GoogleCalendarProvider  func(context.Context) (*calendar.GoogleCalendarClient, error)
	DefaultCalendarTimeZone string
}

type ExecutionResult struct {
	Content []anthropic.InputBlock
	IsError bool
}

type ExecutionSummary struct {
	SavedMemoryIDs   []string
	TaskIDs          []string
	CalendarDraftIDs []string
}

type Executor struct {
	repositories Repositories
	context      ToolExecutionContext
	integrations Integrations

	savedMemoryIDs   map[string]struct{}
	taskIDs          map[string]struct{}
	calendarDraftIDs map[string]struct{}
}

func NewExecutor(repositories Repositories, context ToolExecutionContext, integrations Integrations) *Executor {
	if context.Logger == nil {
		context.Logger = logger.Default()
	}
	return &Executor{
		repositories:     repositories,
		context:          context,
		integrations:     integrations,
		savedMemoryIDs:   map[string]struct{}{},
		taskIDs:          map[string]struct{}{},
		calendarDraftIDs: map[string]struct{}{},
	}
}

func (e *Executor) Execute(ctx context.Context, toolUseEvent anthropic.SessionEvent) (*ExecutionResult, error) {
	toolName := toolUseEvent.Name
	input := toolUseEvent.Input
	if input == nil {
		input = map[string]any{}
	}

	e.context.Logger.Info("Executing custom tool", logger.Fields{
		"toolName":    toolName,
		"toolEventId": toolUseEvent.ID,
	})

	var (
		result *ExecutionResult
		err    error
	)
	switch toolName {
	case "search_memories":
		result, err = e.searchMemories(ctx, input)
	case "save_memory":
		result, err = e.saveMemory(ctx, input)
	case "list_tasks":
		result, err = e.listTasks(ctx, input)
	case "upsert_task":
		result, err = e.upsertTask(ctx, input)
	case "mark_task_done":
		result, err = e.markTaskDone(ctx, input)
	case "list_google_calendars":
		result, err = e.listGoogleCalendars(ctx, input)
	case "list_calendar_events":
		result, err = e.listCalendarEvents(ctx, input)
	case "find_free_busy":
		result, err = e.findFreeBusy(ctx, input)
	case "create_calendar_draft":
		result, err = e.createCalendarDraft(ctx, input)
	case "list_calendar_drafts":
		result, err = e.listCalendarDrafts(ctx, input)
	case "apply_calendar_draft":
		result, err = e.applyCalendarDraft(ctx, input)
	case "discard_calendar_draft":
		result, err = e.discardCalendarDraft(ctx, input)
	default:
		return errorResult(fmt.Sprintf("Unknown custom tool: %s", toolName)), nil
	}
	if err != nil {
		message := err.Error()
		e.context.Logger.Warn("Custom tool execution failed", logger.Fields{
			"toolName":    toolName,
			"toolEventId": toolUseEvent.ID,
			"error":       message,
		})
		if _, ok := calendarToolNames[toolName]; ok {
			return errorResult("Google Calendar is unavailable. Skip calendar-dependent work for this request and continue without calendar data. Details: " + message), nil
		}
		return errorResult(message), nil
	}
	return result, nil
}

func (e *Executor) Summary() ExecutionSummary {
	return ExecutionSummary{
		SavedMemoryIDs:   sortedKeys(e.savedMemoryIDs),
		TaskIDs:          sortedKeys(e.taskIDs),
		CalendarDraftIDs: sortedKeys(e.calendarDraftIDs),
	}
}

func (e *Executor) searchMemories(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	query, err := requiredString(input, "query")
	if err != nil {
		return nil, err
	}
	entityKey := normalizeEntityKey(optionalString(input, "entity_key"))
	scope := optionalString(input, "scope")
	if scope == "" {
		scope = inferSearchScope(e.context)
	}
	limit := optionalInt(input, "limit", 20, 1, 20)

	results := make([]map[string]any, 0)

	if (scope == "all" || scope == "channel") && e.context.ChannelID != "" && e.repositories.ChannelMemories != nil {
		memories, err := e.repositories.ChannelMemories.Search(ctx, e.context.WorkspaceID, e.context.ChannelID, query, entityKey, limit, nil)
		if err != nil {
			return nil, err
		}
		for _, item := range memories {
			results = append(results, map[string]any{
				"scope":      "channel",
				"memory_id":  item.MemoryID,
				"entity_key": item.EntityKey,
				"text":       item.Text,
				"attributes": defaultMap(item.Attributes),
				"tags":       defaultStrings(item.Tags),
				"importance": derefFloat(item.Importance),
				"updated_at": item.UpdatedAt,
				"status":     item.Status,
			})
		}
	}

	if (scope == "all" || scope == "user_preference") && e.context.UserID != "" && e.repositories.UserPreferences != nil {
		preferences, err := e.repositories.UserPreferences.Search(ctx, e.context.WorkspaceID, e.context.UserID, query, entityKey, limit)
		if err != nil {
			return nil, err
		}
		for _, item := range preferences {
			results = append(results, map[string]any{
				"scope":          "user_preference",
				"memory_id":      item.PreferenceID,
				"preference_key": item.PreferenceKey,
				"entity_key":     item.EntityKey,
				"text":           item.Text,
				"attributes":     defaultMap(item.Attributes),
				"tags":           defaultStrings(item.Tags),
				"importance":     derefFloat(item.Importance),
				"updated_at":     item.UpdatedAt,
			})
		}
	}

	if scope == "workspace" || (scope == "all" && len(results) == 0) {
		memories, err := e.repositories.MemoryItems.Search(ctx, e.context.WorkspaceID, query, entityKey, limit)
		if err != nil {
			return nil, err
		}
		for _, item := range memories {
			results = append(results, map[string]any{
				"scope":      "workspace",
				"memory_id":  item.MemoryID,
				"entity_key": item.EntityKey,
				"text":       item.Text,
				"attributes": defaultMap(item.Attributes),
				"tags":       defaultStrings(item.Tags),
				"importance": derefFloat(item.Importance),
				"updated_at": item.UpdatedAt,
			})
		}
	}

	if len(results) > limit {
		results = results[:limit]
	}
	return jsonResult(map[string]any{
		"count":    len(results),
		"memories": results,
	}), nil
}

func (e *Executor) saveMemory(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	textValue, err := requiredString(input, "text")
	if err != nil {
		return nil, err
	}
	scope := optionalString(input, "scope")
	if scope == "" {
		scope = inferSaveScope(e.context)
	}
	origin := optionalString(input, "origin")
	if origin == "" {
		if e.context.MemoryWritePolicy != nil && e.context.MemoryWritePolicy.DefaultOrigin != "" {
			origin = e.context.MemoryWritePolicy.DefaultOrigin
		} else {
			origin = "explicit"
		}
	}
	entityKey := normalizeEntityKey(optionalString(input, "entity_key"))
	tags, err := optionalStringSlice(input, "tags")
	if err != nil {
		return nil, err
	}
	tags = normalizeTags(tags)
	attributes, err := optionalMap(input, "attributes")
	if err != nil {
		return nil, err
	}
	importance, err := optionalFloatPtr(input, "importance", 0, 1)
	if err != nil {
		return nil, err
	}

	switch scope {
	case "channel":
		if e.context.ChannelID == "" || e.repositories.ChannelMemories == nil {
			return errorResult("Channel-scoped memory is unavailable in this context."), nil
		}
		status := "active"
		if origin != "explicit" && e.context.MemoryWritePolicy != nil && e.context.MemoryWritePolicy.ChannelInferredStatus != "" {
			status = e.context.MemoryWritePolicy.ChannelInferredStatus
		}
		record, err := e.repositories.ChannelMemories.Save(ctx, memory.ChannelItem{
			WorkspaceID:     e.context.WorkspaceID,
			ChannelID:       e.context.ChannelID,
			EntityKey:       entityKey,
			Text:            textValue,
			Attributes:      attributes,
			Tags:            tags,
			Importance:      importance,
			Status:          status,
			Origin:          origin,
			SourceType:      "agent",
			CreatedByUserID: e.context.UserID,
		})
		if err != nil {
			return nil, err
		}
		e.savedMemoryIDs[record.MemoryID] = struct{}{}
		return jsonResult(map[string]any{
			"saved":             true,
			"scope":             "channel",
			"memory_id":         record.MemoryID,
			"entity_key":        record.EntityKey,
			"text":              record.Text,
			"tags":              defaultStrings(record.Tags),
			"status":            record.Status,
			"origin":            record.Origin,
			"approval_required": record.Status == "candidate",
			"updated_at":        record.UpdatedAt,
		}), nil
	case "user_preference":
		if e.context.UserID == "" || e.repositories.UserPreferences == nil {
			return errorResult("User preference memory is unavailable in this context."), nil
		}
		preferenceKey := optionalString(input, "preference_key")
		if origin == "imported" {
			origin = "inferred"
		}
		record, err := e.repositories.UserPreferences.Save(ctx, memory.UserPreferenceItem{
			WorkspaceID:     e.context.WorkspaceID,
			UserID:          e.context.UserID,
			PreferenceKey:   preferenceKey,
			EntityKey:       entityKey,
			Text:            textValue,
			Attributes:      attributes,
			Tags:            tags,
			Importance:      importance,
			Origin:          origin,
			SourceType:      "agent",
			CreatedByUserID: e.context.UserID,
		})
		if err != nil {
			return nil, err
		}
		e.savedMemoryIDs[record.PreferenceID] = struct{}{}
		return jsonResult(map[string]any{
			"saved":          true,
			"scope":          "user_preference",
			"memory_id":      record.PreferenceID,
			"preference_key": record.PreferenceKey,
			"entity_key":     record.EntityKey,
			"text":           record.Text,
			"tags":           defaultStrings(record.Tags),
			"updated_at":     record.UpdatedAt,
		}), nil
	default:
		if e.context.MemoryWritePolicy != nil && !e.context.MemoryWritePolicy.AllowWorkspaceMemory {
			return errorResult("Workspace-scoped memory cannot be saved from this context. Use channel or user_preference memory instead."), nil
		}
		record, err := e.repositories.MemoryItems.Save(ctx, memory.Item{
			WorkspaceID:     e.context.WorkspaceID,
			EntityKey:       entityKey,
			Text:            textValue,
			Attributes:      attributes,
			Tags:            tags,
			Importance:      importance,
			SourceType:      "agent",
			CreatedByUserID: e.context.UserID,
		})
		if err != nil {
			return nil, err
		}
		e.savedMemoryIDs[record.MemoryID] = struct{}{}
		return jsonResult(map[string]any{
			"saved":      true,
			"scope":      "workspace",
			"memory_id":  record.MemoryID,
			"entity_key": record.EntityKey,
			"text":       record.Text,
			"tags":       defaultStrings(record.Tags),
			"updated_at": record.UpdatedAt,
		}), nil
	}
}

func (e *Executor) listTasks(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	statuses, err := optionalStatuses(input, "statuses")
	if err != nil {
		return nil, err
	}
	dueBefore := optionalString(input, "due_before")
	limit := optionalInt(input, "limit", 10, 1, 50)
	items, err := e.repositories.Tasks.List(ctx, e.context.WorkspaceID, statuses, limit, dueBefore, e.context.UserID)
	if err != nil {
		return nil, err
	}
	taskList := make([]map[string]any, 0, len(items))
	for _, item := range items {
		taskList = append(taskList, map[string]any{
			"task_id":           item.TaskID,
			"title":             item.Title,
			"description":       item.Description,
			"status":            item.Status,
			"due_at":            item.DueAt,
			"priority":          item.Priority,
			"calendar_event_id": item.CalendarEventID,
			"updated_at":        item.UpdatedAt,
			"completed_at":      item.CompletedAt,
		})
	}
	return jsonResult(map[string]any{"count": len(taskList), "tasks": taskList}), nil
}

func (e *Executor) upsertTask(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	title, err := requiredString(input, "title")
	if err != nil {
		return nil, err
	}
	taskID := optionalString(input, "task_id")
	existing, err := func() (*tasks.State, error) {
		if taskID == "" {
			return nil, nil
		}
		return e.repositories.Tasks.Get(ctx, e.context.WorkspaceID, taskID)
	}()
	if err != nil {
		return nil, err
	}

	statusValue := optionalString(input, "status")
	var status tasks.Status
	if statusValue == "" {
		if existing != nil {
			status = existing.Status
		} else {
			status = tasks.StatusOpen
		}
	} else {
		status, err = parseStatus(statusValue)
		if err != nil {
			return nil, err
		}
	}
	description := optionalString(input, "description")
	dueAt := optionalString(input, "due_at")
	priority := optionalString(input, "priority")
	if priority != "" && priority != "low" && priority != "medium" && priority != "high" {
		return nil, fmt.Errorf("priority must be one of low, medium, high")
	}
	calendarEventID := optionalString(input, "calendar_event_id")
	sourceType := optionalString(input, "source_type")
	if sourceType == "" {
		sourceType = "agent"
	}
	sourceRef := optionalString(input, "source_ref")
	metadata, err := optionalMap(input, "metadata")
	if err != nil {
		return nil, err
	}
	completedAt := ""
	completedByUserID := ""
	if status == tasks.StatusDone {
		if existing != nil && existing.CompletedAt != "" {
			completedAt = existing.CompletedAt
		} else {
			completedAt = time.Now().UTC().Format(time.RFC3339)
		}
		completedByUserID = e.context.UserID
	}

	record, err := e.repositories.Tasks.Upsert(ctx, tasks.State{
		WorkspaceID:       e.context.WorkspaceID,
		TaskID:            taskID,
		Title:             title,
		Description:       description,
		Status:            status,
		DueAt:             dueAt,
		Priority:          priority,
		OwnerUserID:       chooseString(existingValue(existing, func(t *tasks.State) string { return t.OwnerUserID }), e.context.UserID),
		CalendarEventID:   calendarEventID,
		SourceType:        sourceType,
		SourceRef:         sourceRef,
		Metadata:          metadata,
		CompletedAt:       completedAt,
		CompletedByUserID: completedByUserID,
	})
	if err != nil {
		return nil, err
	}
	e.taskIDs[record.TaskID] = struct{}{}

	eventType := "created"
	if existing != nil {
		eventType = "updated"
	}
	if _, err := e.repositories.TaskEvents.Save(ctx, tasks.EventRecord{
		TaskID: record.TaskID,
		Type:   eventType,
		Payload: map[string]any{
			"title":  record.Title,
			"status": record.Status,
			"due_at": record.DueAt,
		},
	}); err != nil {
		return nil, err
	}

	return jsonResult(map[string]any{
		"saved":             true,
		"task_id":           record.TaskID,
		"title":             record.Title,
		"status":            record.Status,
		"due_at":            record.DueAt,
		"calendar_event_id": record.CalendarEventID,
		"updated_at":        record.UpdatedAt,
	}), nil
}

func (e *Executor) markTaskDone(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	taskID, err := requiredString(input, "task_id")
	if err != nil {
		return nil, err
	}
	completedAt := optionalString(input, "completed_at")
	record, err := e.repositories.Tasks.MarkDone(ctx, e.context.WorkspaceID, taskID, e.context.UserID, completedAt)
	if err != nil {
		return nil, err
	}
	e.taskIDs[record.TaskID] = struct{}{}
	if _, err := e.repositories.TaskEvents.Save(ctx, tasks.EventRecord{
		TaskID: record.TaskID,
		Type:   "marked_done",
		Payload: map[string]any{
			"completed_at":         record.CompletedAt,
			"completed_by_user_id": record.CompletedByUserID,
		},
	}); err != nil {
		return nil, err
	}
	return jsonResult(map[string]any{
		"saved":        true,
		"task_id":      record.TaskID,
		"status":       record.Status,
		"completed_at": record.CompletedAt,
	}), nil
}

func (e *Executor) listGoogleCalendars(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	minAccessRole := optionalString(input, "min_access_role")
	if minAccessRole != "" && !isAllowedAccessRole(minAccessRole) {
		return nil, fmt.Errorf("min_access_role must be one of freeBusyReader, reader, writer, owner")
	}
	query := normalizeSearchText(optionalString(input, "query"))
	limit := optionalInt(input, "limit", 100, 1, 100)
	client, err := e.requireGoogleCalendar(ctx)
	if err != nil {
		return nil, err
	}
	calendars, err := client.ListCalendars(ctx, minAccessRole, limit)
	if err != nil {
		return nil, err
	}
	filtered := make([]calendar.GoogleCalendarListEntry, 0, len(calendars))
	for _, entry := range calendars {
		if query == "" || calendarMatchesQuery(entry, query) {
			filtered = append(filtered, entry)
		}
	}
	items := make([]map[string]any, 0, len(filtered))
	for _, entry := range filtered {
		items = append(items, serializeGoogleCalendarListEntry(entry))
	}
	return jsonResult(map[string]any{"count": len(items), "calendars": items}), nil
}

func (e *Executor) listCalendarEvents(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	calendarID := optionalString(input, "calendar_id")
	calendarName := optionalString(input, "calendar_name")
	timeMin := optionalString(input, "time_min")
	if timeMin == "" {
		timeMin = time.Now().UTC().Format(time.RFC3339)
	}
	timeMax := optionalString(input, "time_max")
	if timeMax == "" {
		timeMax = time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339)
	}
	timeZone := optionalString(input, "time_zone")
	query := optionalString(input, "query")
	limit := optionalInt(input, "limit", 10, 1, 50)
	client, err := e.requireGoogleCalendar(ctx)
	if err != nil {
		return nil, err
	}
	resolvedCalendarID, err := e.resolveCalendarID(ctx, client, calendarID, calendarName, "reader")
	if err != nil {
		return nil, err
	}
	resolvedTimeZone := chooseString(timeZone, e.defaultCalendarTimeZone())
	calendarResultID, returnedTimeZone, events, err := client.ListEvents(ctx, resolvedCalendarID, timeMin, timeMax, query, limit, resolvedTimeZone, nil)
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0, len(events))
	for _, event := range events {
		items = append(items, map[string]any{
			"event_id":           event.ID,
			"status":             event.Status,
			"summary":            event.Summary,
			"description":        event.Description,
			"location":           event.Location,
			"start":              serializeGoogleEventTime(event.Start),
			"end":                serializeGoogleEventTime(event.End),
			"private_properties": event.ExtendedProperties.Private,
			"html_link":          event.HTMLLink,
			"updated_at":         event.Updated,
		})
	}
	return jsonResult(map[string]any{
		"count":       len(items),
		"calendar_id": calendarResultID,
		"time_zone":   returnedTimeZone,
		"events":      items,
	}), nil
}

func (e *Executor) findFreeBusy(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	timeMin, err := requiredString(input, "time_min")
	if err != nil {
		return nil, err
	}
	timeMax, err := requiredString(input, "time_max")
	if err != nil {
		return nil, err
	}
	timeZone := optionalString(input, "time_zone")
	calendarIDs, err := optionalStringSlice(input, "calendar_ids")
	if err != nil {
		return nil, err
	}
	calendarNames, err := optionalStringSlice(input, "calendar_names")
	if err != nil {
		return nil, err
	}
	client, err := e.requireGoogleCalendar(ctx)
	if err != nil {
		return nil, err
	}
	resolvedCalendarIDs, err := e.resolveCalendarIDs(ctx, client, calendarIDs, calendarNames, "freeBusyReader")
	if err != nil {
		return nil, err
	}
	timeMinResult, timeMaxResult, timeZoneResult, calendars, err := client.QueryFreeBusy(ctx, resolvedCalendarIDs, timeMin, timeMax, chooseString(timeZone, e.defaultCalendarTimeZone()))
	if err != nil {
		return nil, err
	}
	return jsonResult(map[string]any{
		"time_min":  timeMinResult,
		"time_max":  timeMaxResult,
		"time_zone": timeZoneResult,
		"calendars": calendars,
	}), nil
}

func (e *Executor) createCalendarDraft(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	if e.repositories.CalendarDrafts == nil {
		return nil, fmt.Errorf("calendar draft storage is not configured")
	}
	candidateValues, ok := input["candidates"].([]any)
	if !ok || len(candidateValues) == 0 {
		return nil, fmt.Errorf("candidates must be a non-empty array")
	}
	if len(candidateValues) > 50 {
		return nil, fmt.Errorf("candidates must have at most 50 items")
	}

	title := optionalString(input, "title")
	notes := optionalString(input, "notes")
	sourceID := optionalString(input, "source_id")
	sourceRef := optionalString(input, "source_ref")
	calendarID := optionalString(input, "calendar_id")
	calendarName := optionalString(input, "calendar_name")
	var client *calendar.GoogleCalendarClient
	var err error
	if calendarName != "" {
		client, err = e.requireGoogleCalendar(ctx)
		if err != nil {
			return nil, err
		}
		calendarID, err = e.resolveCalendarID(ctx, client, calendarID, calendarName, "writer")
		if err != nil {
			return nil, err
		}
	}

	candidates := make([]calendar.DraftCandidate, 0, len(candidateValues))
	for _, value := range candidateValues {
		entry, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("calendar candidate must be an object")
		}
		candidate, err := normalizeCalendarDraftCandidate(entry, e.defaultCalendarTimeZone(), sourceID, sourceRef)
		if err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	draftID := idgen.New("caldraft_")
	if title == "" {
		title = chooseString(sourceRef, sourceID, "Calendar draft")
	}
	draft := calendar.Draft{
		DraftID:     draftID,
		WorkspaceID: e.context.WorkspaceID,
		UserID:      e.context.UserID,
		Title:       title,
		Notes:       notes,
		SourceID:    sourceID,
		SourceRef:   sourceRef,
		CalendarID:  calendarID,
		Status:      "pending",
		Candidates:  candidates,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if _, err := e.repositories.CalendarDrafts.Save(ctx, draft); err != nil {
		return nil, err
	}
	e.calendarDraftIDs[draft.DraftID] = struct{}{}

	serializedCandidates := make([]map[string]any, 0, len(draft.Candidates))
	for _, candidate := range draft.Candidates {
		serializedCandidates = append(serializedCandidates, serializeCalendarDraftCandidate(candidate))
	}
	return jsonResult(map[string]any{
		"saved":           true,
		"draft_id":        draft.DraftID,
		"title":           draft.Title,
		"status":          draft.Status,
		"calendar_id":     draft.CalendarID,
		"candidate_count": len(draft.Candidates),
		"candidates":      serializedCandidates,
		"next_step":       "Show this draft to the user and wait for explicit approval before apply_calendar_draft.",
	}), nil
}

func (e *Executor) listCalendarDrafts(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	if e.repositories.CalendarDrafts == nil {
		return nil, fmt.Errorf("calendar draft storage is not configured")
	}
	statuses, err := optionalStringSlice(input, "statuses")
	if err != nil {
		return nil, err
	}
	for _, status := range statuses {
		if status != "pending" && status != "approved" && status != "applied" && status != "rejected" {
			return nil, fmt.Errorf("statuses contains invalid value %q", status)
		}
	}
	limit := optionalInt(input, "limit", 10, 1, 20)
	drafts, err := e.repositories.CalendarDrafts.List(ctx, e.context.WorkspaceID, e.context.UserID, statuses, limit)
	if err != nil {
		return nil, err
	}

	items := make([]map[string]any, 0, len(drafts))
	for _, draft := range drafts {
		candidates := make([]map[string]any, 0, len(draft.Candidates))
		for _, candidate := range draft.Candidates {
			candidates = append(candidates, serializeCalendarDraftCandidate(candidate))
		}
		items = append(items, map[string]any{
			"draft_id":        draft.DraftID,
			"title":           draft.Title,
			"status":          draft.Status,
			"calendar_id":     draft.CalendarID,
			"source_id":       draft.SourceID,
			"source_ref":      draft.SourceRef,
			"created_at":      draft.CreatedAt,
			"updated_at":      draft.UpdatedAt,
			"candidate_count": len(draft.Candidates),
			"candidates":      candidates,
		})
	}
	return jsonResult(map[string]any{"count": len(items), "drafts": items}), nil
}

func (e *Executor) applyCalendarDraft(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	if e.repositories.CalendarDrafts == nil {
		return nil, fmt.Errorf("calendar draft storage is not configured")
	}
	draftID, err := requiredString(input, "draft_id")
	if err != nil {
		return nil, err
	}
	candidateIDs, err := optionalStringSlice(input, "candidate_ids")
	if err != nil {
		return nil, err
	}
	requested := stringSet(candidateIDs)
	client, err := e.requireGoogleCalendar(ctx)
	if err != nil {
		return nil, err
	}
	draft, err := e.repositories.CalendarDrafts.Get(ctx, e.context.WorkspaceID, e.context.UserID, draftID)
	if err != nil {
		return nil, err
	}
	if draft == nil {
		return nil, fmt.Errorf("Calendar draft %s was not found", draftID)
	}

	selected := make([]calendar.DraftCandidate, 0)
	for _, candidate := range draft.Candidates {
		if len(requested) > 0 {
			if _, ok := requested[candidate.CandidateID]; ok {
				selected = append(selected, candidate)
			}
			continue
		}
		if candidate.Status == "pending" {
			selected = append(selected, candidate)
		}
	}
	if len(requested) > 0 && len(selected) != len(requested) {
		return nil, fmt.Errorf("Some candidate_ids were not found in draft %s", draft.DraftID)
	}
	if len(selected) == 0 {
		return nil, fmt.Errorf("No calendar draft candidates are ready to apply")
	}
	for _, candidate := range selected {
		if candidate.Status == "rejected" {
			return nil, fmt.Errorf("Rejected calendar draft candidates cannot be applied")
		}
	}

	calendarID := optionalString(input, "calendar_id")
	calendarName := optionalString(input, "calendar_name")
	calendarID, err = e.resolveCalendarID(ctx, client, chooseString(calendarID, draft.CalendarID), calendarName, "writer")
	if err != nil {
		return nil, err
	}

	appliedAt := time.Now().UTC().Format(time.RFC3339)
	results := make([]map[string]any, 0)
	selectedSet := stringSet(candidateIDs)
	if len(selectedSet) == 0 {
		for _, candidate := range selected {
			selectedSet[candidate.CandidateID] = struct{}{}
		}
	}
	updatedCandidates := make([]calendar.DraftCandidate, 0, len(draft.Candidates))
	for _, candidate := range draft.Candidates {
		if _, ok := selectedSet[candidate.CandidateID]; !ok {
			updatedCandidates = append(updatedCandidates, candidate)
			continue
		}
		privateProperties := buildCalendarPrivateProperties(e.context.WorkspaceID, *draft, candidate)
		existingEvent, err := client.FindEventByPrivateProperties(ctx, calendarID, map[string]string{
			calendarPrivatePropertyKeys["dedupeKey"]:   privateProperties[calendarPrivatePropertyKeys["dedupeKey"]],
			calendarPrivatePropertyKeys["candidateId"]: privateProperties[calendarPrivatePropertyKeys["candidateId"]],
		})
		if err != nil {
			return nil, err
		}
		body := buildGoogleCalendarEventBody(candidate, privateProperties, e.defaultCalendarTimeZone())
		var appliedEvent *calendar.GoogleCalendarEventRecord
		operation := "created"
		if existingEvent != nil && existingEvent.ID != "" {
			appliedEvent, err = client.PatchEvent(ctx, calendarID, existingEvent.ID, body)
			operation = "updated"
		} else {
			appliedEvent, err = client.CreateEvent(ctx, calendarID, body)
		}
		if err != nil {
			return nil, err
		}
		candidate.Status = "applied"
		candidate.CalendarEventID = appliedEvent.ID
		candidate.CalendarEventHTMLLink = appliedEvent.HTMLLink
		candidate.AppliedAt = appliedAt
		updatedCandidates = append(updatedCandidates, candidate)
		results = append(results, map[string]any{
			"candidate_id": candidate.CandidateID,
			"operation":    operation,
			"event_id":     appliedEvent.ID,
			"html_link":    appliedEvent.HTMLLink,
			"summary":      chooseString(appliedEvent.Summary, candidate.Summary),
		})
	}

	draft.CalendarID = calendarID
	draft.Candidates = updatedCandidates
	draft.Status = resolveCalendarDraftStatus(updatedCandidates)
	if draft.ApprovedAt == "" {
		draft.ApprovedAt = appliedAt
	}
	draft.LastAppliedAt = appliedAt
	draft.UpdatedAt = appliedAt
	if allCandidatesHaveStatus(updatedCandidates, "rejected") && draft.RejectedAt == "" {
		draft.RejectedAt = appliedAt
	}
	if _, err := e.repositories.CalendarDrafts.Save(ctx, *draft); err != nil {
		return nil, err
	}

	remaining := make([]string, 0)
	for _, candidate := range draft.Candidates {
		if candidate.Status == "pending" {
			remaining = append(remaining, candidate.CandidateID)
		}
	}
	return jsonResult(map[string]any{
		"applied":                         true,
		"draft_id":                        draft.DraftID,
		"status":                          draft.Status,
		"calendar_id":                     draft.CalendarID,
		"event_count":                     len(results),
		"events":                          results,
		"remaining_pending_candidate_ids": remaining,
	}), nil
}

func (e *Executor) discardCalendarDraft(ctx context.Context, input map[string]any) (*ExecutionResult, error) {
	if e.repositories.CalendarDrafts == nil {
		return nil, fmt.Errorf("calendar draft storage is not configured")
	}
	draftID, err := requiredString(input, "draft_id")
	if err != nil {
		return nil, err
	}
	candidateIDs, err := optionalStringSlice(input, "candidate_ids")
	if err != nil {
		return nil, err
	}
	requested := stringSet(candidateIDs)
	draft, err := e.repositories.CalendarDrafts.Get(ctx, e.context.WorkspaceID, e.context.UserID, draftID)
	if err != nil {
		return nil, err
	}
	if draft == nil {
		return nil, fmt.Errorf("Calendar draft %s was not found", draftID)
	}

	targetIDs := map[string]struct{}{}
	for _, candidate := range draft.Candidates {
		if len(requested) > 0 {
			if _, ok := requested[candidate.CandidateID]; ok {
				targetIDs[candidate.CandidateID] = struct{}{}
			}
		} else if candidate.Status == "pending" {
			targetIDs[candidate.CandidateID] = struct{}{}
		}
	}
	if len(requested) > 0 && len(targetIDs) != len(requested) {
		return nil, fmt.Errorf("Some candidate_ids were not found in draft %s", draft.DraftID)
	}
	if len(targetIDs) == 0 {
		return nil, fmt.Errorf("No calendar draft candidates are ready to discard")
	}

	rejectedAt := time.Now().UTC().Format(time.RFC3339)
	rejectedCandidateIDs := make([]string, 0)
	skippedCandidateIDs := make([]string, 0)
	updatedCandidates := make([]calendar.DraftCandidate, 0, len(draft.Candidates))
	for _, candidate := range draft.Candidates {
		if _, ok := targetIDs[candidate.CandidateID]; !ok {
			updatedCandidates = append(updatedCandidates, candidate)
			continue
		}
		if candidate.Status == "applied" {
			skippedCandidateIDs = append(skippedCandidateIDs, candidate.CandidateID)
			updatedCandidates = append(updatedCandidates, candidate)
			continue
		}
		candidate.Status = "rejected"
		candidate.RejectedAt = rejectedAt
		rejectedCandidateIDs = append(rejectedCandidateIDs, candidate.CandidateID)
		updatedCandidates = append(updatedCandidates, candidate)
	}

	draft.Candidates = updatedCandidates
	draft.Status = resolveCalendarDraftStatus(updatedCandidates)
	if (allCandidatesHaveStatus(updatedCandidates, "rejected") || len(rejectedCandidateIDs) > 0) && draft.RejectedAt == "" {
		draft.RejectedAt = rejectedAt
	}
	draft.UpdatedAt = rejectedAt
	if _, err := e.repositories.CalendarDrafts.Save(ctx, *draft); err != nil {
		return nil, err
	}

	remaining := make([]string, 0)
	for _, candidate := range draft.Candidates {
		if candidate.Status == "pending" {
			remaining = append(remaining, candidate.CandidateID)
		}
	}
	return jsonResult(map[string]any{
		"discarded":                       true,
		"draft_id":                        draft.DraftID,
		"status":                          draft.Status,
		"rejected_candidate_ids":          rejectedCandidateIDs,
		"skipped_candidate_ids":           skippedCandidateIDs,
		"remaining_pending_candidate_ids": remaining,
	}), nil
}

func (e *Executor) requireGoogleCalendar(ctx context.Context) (*calendar.GoogleCalendarClient, error) {
	if e.integrations.GoogleCalendarProvider != nil {
		return e.integrations.GoogleCalendarProvider(ctx)
	}
	if e.integrations.GoogleCalendar == nil {
		return nil, fmt.Errorf("Google Calendar integration is not configured")
	}
	return e.integrations.GoogleCalendar, nil
}

func (e *Executor) defaultCalendarTimeZone() string {
	if e.integrations.DefaultCalendarTimeZone != "" {
		return e.integrations.DefaultCalendarTimeZone
	}
	return defaultCalendarTimeZone
}

func (e *Executor) resolveCalendarIDs(ctx context.Context, client *calendar.GoogleCalendarClient, calendarIDs []string, calendarNames []string, minAccessRole string) ([]string, error) {
	resolved := append([]string{}, calendarIDs...)
	for _, calendarName := range calendarNames {
		calendarID, err := e.resolveCalendarID(ctx, client, "", calendarName, minAccessRole)
		if err != nil {
			return nil, err
		}
		if calendarID != "" {
			resolved = append(resolved, calendarID)
		}
	}
	if len(resolved) == 0 {
		return nil, nil
	}
	return uniqueStrings(resolved), nil
}

func (e *Executor) resolveCalendarID(ctx context.Context, client *calendar.GoogleCalendarClient, calendarID string, calendarName string, minAccessRole string) (string, error) {
	if calendarID != "" {
		return calendarID, nil
	}
	if calendarName == "" {
		return "", nil
	}
	if client == nil {
		return "", fmt.Errorf("Google Calendar is required to resolve a calendar name")
	}
	calendars, err := client.ListCalendars(ctx, minAccessRole, 250)
	if err != nil {
		return "", err
	}
	matched, err := findCalendarByName(calendars, calendarName)
	if err != nil {
		return "", err
	}
	if matched == nil {
		return "", fmt.Errorf("Google Calendar named '%s' was not found with %s access or higher.", calendarName, minAccessRole)
	}
	return matched.ID, nil
}

func jsonResult(payload any) *ExecutionResult {
	body, _ := json.MarshalIndent(payload, "", "  ")
	return &ExecutionResult{
		Content: []anthropic.InputBlock{
			{
				"type": "text",
				"text": string(body),
			},
		},
	}
}

func errorResult(message string) *ExecutionResult {
	return &ExecutionResult{
		IsError: true,
		Content: []anthropic.InputBlock{
			{
				"type": "text",
				"text": message,
			},
		},
	}
}

func normalizeEntityKey(value string) string {
	if value == "" {
		return ""
	}
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.ReplaceAll(normalized, " ", "-")
	return normalized
}

func normalizeTags(tags []string) []string {
	if len(tags) == 0 {
		return nil
	}
	set := map[string]struct{}{}
	values := make([]string, 0, len(tags))
	for _, tag := range tags {
		normalized := strings.ToLower(strings.TrimSpace(tag))
		normalized = strings.ReplaceAll(normalized, " ", "_")
		if normalized == "" {
			continue
		}
		if _, ok := set[normalized]; ok {
			continue
		}
		set[normalized] = struct{}{}
		values = append(values, normalized)
	}
	if len(values) == 0 {
		return nil
	}
	return values
}

func inferSearchScope(context ToolExecutionContext) string {
	if context.ChannelID != "" || context.UserID != "" {
		return "all"
	}
	return "workspace"
}

func inferSaveScope(context ToolExecutionContext) string {
	if context.ChannelID != "" {
		return "channel"
	}
	if context.UserID != "" {
		return "user_preference"
	}
	return "workspace"
}

func serializeGoogleCalendarListEntry(entry calendar.GoogleCalendarListEntry) map[string]any {
	return map[string]any{
		"calendar_id":      entry.ID,
		"summary":          entry.Summary,
		"summary_override": entry.SummaryOverride,
		"description":      entry.Description,
		"time_zone":        entry.TimeZone,
		"access_role":      entry.AccessRole,
		"primary":          entry.Primary,
		"selected":         entry.Selected,
		"hidden":           entry.Hidden,
	}
}

func findCalendarByName(calendars []calendar.GoogleCalendarListEntry, calendarName string) (*calendar.GoogleCalendarListEntry, error) {
	query := normalizeSearchText(calendarName)
	exactMatches := make([]calendar.GoogleCalendarListEntry, 0)
	for _, entry := range calendars {
		for _, candidate := range calendarNameCandidates(entry) {
			if candidate == query {
				exactMatches = append(exactMatches, entry)
				break
			}
		}
	}
	if len(exactMatches) == 1 {
		return &exactMatches[0], nil
	}
	if len(exactMatches) > 1 {
		names := make([]string, 0, len(exactMatches))
		for _, entry := range exactMatches {
			names = append(names, chooseString(entry.Summary, entry.ID))
		}
		return nil, fmt.Errorf("Google Calendar name '%s' matched multiple calendars: %s", calendarName, strings.Join(names, ", "))
	}

	partialMatches := make([]calendar.GoogleCalendarListEntry, 0)
	for _, entry := range calendars {
		if calendarMatchesQuery(entry, query) {
			partialMatches = append(partialMatches, entry)
		}
	}
	if len(partialMatches) == 1 {
		return &partialMatches[0], nil
	}
	if len(partialMatches) > 1 {
		names := make([]string, 0, len(partialMatches))
		for _, entry := range partialMatches {
			names = append(names, chooseString(entry.Summary, entry.ID))
		}
		return nil, fmt.Errorf("Google Calendar name '%s' matched multiple calendars: %s", calendarName, strings.Join(names, ", "))
	}
	return nil, nil
}

func calendarMatchesQuery(entry calendar.GoogleCalendarListEntry, query string) bool {
	for _, candidate := range calendarNameCandidates(entry) {
		if strings.Contains(candidate, query) {
			return true
		}
	}
	return false
}

func calendarNameCandidates(entry calendar.GoogleCalendarListEntry) []string {
	values := []string{entry.ID, entry.Summary, entry.SummaryOverride}
	candidates := make([]string, 0, len(values))
	for _, value := range values {
		normalized := normalizeSearchText(value)
		if normalized != "" {
			candidates = append(candidates, normalized)
		}
	}
	return candidates
}

func normalizeSearchText(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeCalendarDraftCandidate(input map[string]any, defaultTimeZone string, sourceID string, sourceRef string) (calendar.DraftCandidate, error) {
	summary, err := requiredString(input, "summary")
	if err != nil {
		return calendar.DraftCandidate{}, err
	}
	candidateID := chooseString(optionalString(input, "candidate_id"), idgen.New("calcand_"))
	description := optionalString(input, "description")
	location := optionalString(input, "location")
	sourceText := optionalString(input, "source_text")
	timeZone := chooseString(optionalString(input, "time_zone"), defaultTimeZone)
	allDayFlag, _ := optionalBool(input, "all_day")
	startDate := optionalString(input, "start_date")
	endDate := optionalString(input, "end_date")
	startAt := optionalString(input, "start_at")
	endAt := optionalString(input, "end_at")
	confidence, err := optionalFloatPtr(input, "confidence", 0, 1)
	if err != nil {
		return calendar.DraftCandidate{}, err
	}
	dedupeKey := optionalString(input, "dedupe_key")
	allDay := allDayFlag || startDate != "" || endDate != ""
	if allDay && (startAt != "" || endAt != "") {
		return calendar.DraftCandidate{}, fmt.Errorf("Use either start_date/end_date for an all-day event or start_at/end_at for a timed event, not both.")
	}
	if allDay {
		if !isDateOnly(startDate) {
			return calendar.DraftCandidate{}, fmt.Errorf("All-day events require start_date in YYYY-MM-DD format.")
		}
		if endDate != "" && !isDateOnly(endDate) {
			return calendar.DraftCandidate{}, fmt.Errorf("end_date must be in YYYY-MM-DD format.")
		}
		if endDate != "" && endDate < startDate {
			return calendar.DraftCandidate{}, fmt.Errorf("end_date must be on or after start_date.")
		}
		if endDate == "" {
			endDate = startDate
		}
		if dedupeKey == "" {
			dedupeKey = buildCalendarCandidateDedupeKey(map[string]any{
				"summary":   strings.TrimSpace(summary),
				"location":  location,
				"allDay":    true,
				"startDate": startDate,
				"endDate":   endDate,
				"sourceId":  sourceID,
				"sourceRef": sourceRef,
			})
		}
		return calendar.DraftCandidate{
			CandidateID: candidateID,
			Summary:     strings.TrimSpace(summary),
			Description: description,
			Location:    location,
			AllDay:      true,
			StartDate:   startDate,
			EndDate:     endDate,
			TimeZone:    timeZone,
			SourceText:  sourceText,
			Confidence:  confidence,
			DedupeKey:   dedupeKey,
			Status:      "pending",
		}, nil
	}

	if !isRFC3339(startAt) {
		return calendar.DraftCandidate{}, fmt.Errorf("Timed events require start_at as an RFC3339 timestamp.")
	}
	if !isRFC3339(endAt) {
		return calendar.DraftCandidate{}, fmt.Errorf("Timed events require end_at as an RFC3339 timestamp.")
	}
	startParsed, _ := time.Parse(time.RFC3339, startAt)
	endParsed, _ := time.Parse(time.RFC3339, endAt)
	if !endParsed.After(startParsed) {
		return calendar.DraftCandidate{}, fmt.Errorf("end_at must be after start_at.")
	}
	if dedupeKey == "" {
		dedupeKey = buildCalendarCandidateDedupeKey(map[string]any{
			"summary":   strings.TrimSpace(summary),
			"location":  location,
			"allDay":    false,
			"startAt":   startAt,
			"endAt":     endAt,
			"timeZone":  timeZone,
			"sourceId":  sourceID,
			"sourceRef": sourceRef,
		})
	}
	return calendar.DraftCandidate{
		CandidateID: candidateID,
		Summary:     strings.TrimSpace(summary),
		Description: description,
		Location:    location,
		AllDay:      false,
		StartAt:     startAt,
		EndAt:       endAt,
		TimeZone:    timeZone,
		SourceText:  sourceText,
		Confidence:  confidence,
		DedupeKey:   dedupeKey,
		Status:      "pending",
	}, nil
}

func buildCalendarCandidateDedupeKey(input map[string]any) string {
	payload, _ := json.Marshal(input)
	hash := sha256.Sum256(payload)
	return "dedupe_" + hex.EncodeToString(hash[:])[:24]
}

func buildCalendarPrivateProperties(workspaceID string, draft calendar.Draft, candidate calendar.DraftCandidate) map[string]string {
	properties := map[string]string{
		calendarPrivatePropertyKeys["draftId"]:     draft.DraftID,
		calendarPrivatePropertyKeys["candidateId"]: candidate.CandidateID,
		calendarPrivatePropertyKeys["dedupeKey"]:   chooseString(candidate.DedupeKey, candidate.CandidateID),
		calendarPrivatePropertyKeys["workspaceId"]: workspaceID,
	}
	if draft.SourceID != "" {
		properties[calendarPrivatePropertyKeys["sourceId"]] = draft.SourceID
	}
	return properties
}

func buildGoogleCalendarEventBody(candidate calendar.DraftCandidate, privateProperties map[string]string, defaultTimeZone string) map[string]any {
	body := map[string]any{
		"summary":     candidate.Summary,
		"description": candidate.Description,
		"location":    candidate.Location,
		"extendedProperties": map[string]any{
			"private": privateProperties,
		},
	}
	if candidate.AllDay {
		body["start"] = map[string]any{"date": candidate.StartDate}
		body["end"] = map[string]any{"date": buildExclusiveEndDate(candidate.StartDate, candidate.EndDate)}
	} else {
		body["start"] = map[string]any{"dateTime": candidate.StartAt, "timeZone": chooseString(candidate.TimeZone, defaultTimeZone)}
		body["end"] = map[string]any{"dateTime": candidate.EndAt, "timeZone": chooseString(candidate.TimeZone, defaultTimeZone)}
	}
	return body
}

func buildExclusiveEndDate(startDate string, endDate string) string {
	inclusiveEnd := chooseString(endDate, startDate)
	parsed, _ := time.Parse("2006-01-02", inclusiveEnd)
	return parsed.Add(24 * time.Hour).Format("2006-01-02")
}

func resolveCalendarDraftStatus(candidates []calendar.DraftCandidate) string {
	if allCandidatesHaveStatus(candidates, "rejected") {
		return "rejected"
	}
	for _, candidate := range candidates {
		if candidate.Status == "pending" {
			for _, other := range candidates {
				if other.Status == "applied" {
					return "approved"
				}
			}
			return "pending"
		}
	}
	return "applied"
}

func serializeCalendarDraftCandidate(candidate calendar.DraftCandidate) map[string]any {
	return map[string]any{
		"candidate_id":             candidate.CandidateID,
		"summary":                  candidate.Summary,
		"description":              candidate.Description,
		"location":                 candidate.Location,
		"all_day":                  candidate.AllDay,
		"start_date":               candidate.StartDate,
		"end_date":                 candidate.EndDate,
		"start_at":                 candidate.StartAt,
		"end_at":                   candidate.EndAt,
		"time_zone":                candidate.TimeZone,
		"source_text":              candidate.SourceText,
		"confidence":               candidate.Confidence,
		"dedupe_key":               candidate.DedupeKey,
		"status":                   candidate.Status,
		"calendar_event_id":        candidate.CalendarEventID,
		"calendar_event_html_link": candidate.CalendarEventHTMLLink,
		"applied_at":               candidate.AppliedAt,
		"rejected_at":              candidate.RejectedAt,
	}
}

func serializeGoogleEventTime(value *calendar.GoogleCalendarEventTime) map[string]any {
	if value == nil {
		return nil
	}
	return map[string]any{
		"date":      value.Date,
		"date_time": value.DateTime,
		"time_zone": value.TimeZone,
	}
}

func isDateOnly(value string) bool {
	if value == "" {
		return false
	}
	_, err := time.Parse("2006-01-02", value)
	return err == nil
}

func isRFC3339(value string) bool {
	if value == "" {
		return false
	}
	_, err := time.Parse(time.RFC3339, value)
	return err == nil
}

func requiredString(input map[string]any, key string) (string, error) {
	value := optionalString(input, key)
	if value == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return value, nil
}

func optionalString(input map[string]any, key string) string {
	value, ok := input[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	default:
		return ""
	}
}

func optionalStringSlice(input map[string]any, key string) ([]string, error) {
	value, ok := input[key]
	if !ok || value == nil {
		return nil, nil
	}
	items, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array of strings", key)
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return nil, fmt.Errorf("%s must be an array of non-empty strings", key)
		}
		result = append(result, strings.TrimSpace(text))
	}
	return result, nil
}

func optionalMap(input map[string]any, key string) (map[string]any, error) {
	value, ok := input[key]
	if !ok || value == nil {
		return nil, nil
	}
	result, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an object", key)
	}
	return result, nil
}

func optionalFloatPtr(input map[string]any, key string, min float64, max float64) (*float64, error) {
	value, ok := input[key]
	if !ok || value == nil {
		return nil, nil
	}
	number, ok := value.(float64)
	if !ok {
		return nil, fmt.Errorf("%s must be a number", key)
	}
	if number < min || number > max {
		return nil, fmt.Errorf("%s must be between %v and %v", key, min, max)
	}
	return &number, nil
}

func optionalInt(input map[string]any, key string, fallback int, min int, max int) int {
	value, ok := input[key]
	if !ok || value == nil {
		return fallback
	}
	if number, ok := value.(float64); ok {
		intValue := int(number)
		if intValue < min {
			return min
		}
		if intValue > max {
			return max
		}
		return intValue
	}
	return fallback
}

func optionalBool(input map[string]any, key string) (bool, bool) {
	value, ok := input[key]
	if !ok || value == nil {
		return false, false
	}
	boolean, ok := value.(bool)
	return boolean, ok
}

func optionalStatuses(input map[string]any, key string) ([]tasks.Status, error) {
	values, err := optionalStringSlice(input, key)
	if err != nil {
		return nil, err
	}
	result := make([]tasks.Status, 0, len(values))
	for _, value := range values {
		status, err := parseStatus(value)
		if err != nil {
			return nil, err
		}
		result = append(result, status)
	}
	return result, nil
}

func parseStatus(value string) (tasks.Status, error) {
	switch value {
	case string(tasks.StatusOpen):
		return tasks.StatusOpen, nil
	case string(tasks.StatusInProgress):
		return tasks.StatusInProgress, nil
	case string(tasks.StatusDone):
		return tasks.StatusDone, nil
	case string(tasks.StatusCancelled):
		return tasks.StatusCancelled, nil
	default:
		return "", fmt.Errorf("status must be one of open, in_progress, done, cancelled")
	}
}

func isAllowedAccessRole(value string) bool {
	return value == "freeBusyReader" || value == "reader" || value == "writer" || value == "owner"
}

func chooseString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func defaultMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func defaultStrings(value []string) []string {
	if value == nil {
		return []string{}
	}
	return value
}

func derefFloat(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

func sortedKeys(set map[string]struct{}) []string {
	values := make([]string, 0, len(set))
	for key := range set {
		values = append(values, key)
	}
	sort.Strings(values)
	return values
}

func uniqueStrings(values []string) []string {
	set := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := set[value]; ok {
			continue
		}
		set[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func stringSet(values []string) map[string]struct{} {
	set := map[string]struct{}{}
	for _, value := range values {
		set[value] = struct{}{}
	}
	return set
}

func allCandidatesHaveStatus(candidates []calendar.DraftCandidate, status string) bool {
	if len(candidates) == 0 {
		return false
	}
	for _, candidate := range candidates {
		if candidate.Status != status {
			return false
		}
	}
	return true
}

func existingValue(existing *tasks.State, selector func(*tasks.State) string) string {
	if existing == nil {
		return ""
	}
	return selector(existing)
}
