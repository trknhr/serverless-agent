package repo

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/trknhr/slack-ai-assistant/internal/idgen"
	"github.com/trknhr/slack-ai-assistant/internal/tasks"
)

type taskStateRecord struct {
	PK                string         `dynamodbav:"pk"`
	SK                string         `dynamodbav:"sk"`
	GSI1PK            string         `dynamodbav:"gsi1pk"`
	GSI1SK            string         `dynamodbav:"gsi1sk"`
	WorkspaceID       string         `dynamodbav:"workspaceId"`
	TaskID            string         `dynamodbav:"taskId"`
	Title             string         `dynamodbav:"title"`
	Description       string         `dynamodbav:"description,omitempty"`
	Status            tasks.Status   `dynamodbav:"status"`
	DueAt             string         `dynamodbav:"dueAt,omitempty"`
	Priority          string         `dynamodbav:"priority,omitempty"`
	OwnerUserID       string         `dynamodbav:"ownerUserId,omitempty"`
	CalendarEventID   string         `dynamodbav:"calendarEventId,omitempty"`
	SourceType        string         `dynamodbav:"sourceType,omitempty"`
	SourceRef         string         `dynamodbav:"sourceRef,omitempty"`
	Metadata          map[string]any `dynamodbav:"metadata,omitempty"`
	CompletedAt       string         `dynamodbav:"completedAt,omitempty"`
	CompletedByUserID string         `dynamodbav:"completedByUserId,omitempty"`
	CreatedAt         string         `dynamodbav:"createdAt"`
	UpdatedAt         string         `dynamodbav:"updatedAt"`
}

type TaskStateRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewTaskStateRepository(client *dynamodb.Client, tableName string) *TaskStateRepository {
	return &TaskStateRepository{client: client, tableName: tableName}
}

func (r *TaskStateRepository) Get(ctx context.Context, workspaceID string, taskID string) (*tasks.State, error) {
	key, err := attributevalue.MarshalMap(map[string]string{
		"pk": "WORKSPACE#" + workspaceID,
		"sk": "TASK#" + taskID,
	})
	if err != nil {
		return nil, err
	}
	output, err := r.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(r.tableName),
		Key:       key,
	})
	if err != nil {
		return nil, err
	}
	if len(output.Item) == 0 {
		return nil, nil
	}

	var record taskStateRecord
	if err := attributevalue.UnmarshalMap(output.Item, &record); err != nil {
		return nil, err
	}
	state := taskStateFromRecord(record)
	return &state, nil
}

func (r *TaskStateRepository) Upsert(ctx context.Context, task tasks.State) (*tasks.State, error) {
	existing, err := func() (*tasks.State, error) {
		if task.TaskID == "" || task.WorkspaceID == "" {
			return nil, nil
		}
		return r.Get(ctx, task.WorkspaceID, task.TaskID)
	}()
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	taskID := task.TaskID
	if taskID == "" {
		taskID = idgen.New("task_")
	}
	createdAt := now
	if existing != nil && existing.CreatedAt != "" {
		createdAt = existing.CreatedAt
	}

	record := taskStateRecord{
		PK:                "WORKSPACE#" + task.WorkspaceID,
		SK:                "TASK#" + taskID,
		GSI1PK:            "WORKSPACE#" + task.WorkspaceID + "#STATUS#" + string(task.Status),
		GSI1SK:            buildTaskStatusGSI1SK(task.DueAt, now, taskID),
		WorkspaceID:       task.WorkspaceID,
		TaskID:            taskID,
		Title:             task.Title,
		Description:       task.Description,
		Status:            task.Status,
		DueAt:             task.DueAt,
		Priority:          task.Priority,
		OwnerUserID:       task.OwnerUserID,
		CalendarEventID:   task.CalendarEventID,
		SourceType:        task.SourceType,
		SourceRef:         task.SourceRef,
		Metadata:          task.Metadata,
		CompletedAt:       task.CompletedAt,
		CompletedByUserID: task.CompletedByUserID,
		CreatedAt:         createdAt,
		UpdatedAt:         now,
	}

	itemMap, err := attributevalue.MarshalMap(record)
	if err != nil {
		return nil, err
	}
	_, err = r.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(r.tableName),
		Item:      itemMap,
	})
	if err != nil {
		return nil, err
	}
	state := taskStateFromRecord(record)
	return &state, nil
}

func (r *TaskStateRepository) List(ctx context.Context, workspaceID string, statuses []tasks.Status, limit int, dueBefore string, ownerUserID string) ([]tasks.State, error) {
	if len(statuses) == 0 {
		statuses = []tasks.Status{tasks.StatusOpen, tasks.StatusInProgress}
	}
	if limit <= 0 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}

	results := make([]tasks.State, 0)
	for _, status := range statuses {
		values, err := attributevalue.MarshalMap(map[string]string{
			":gsi1pk": "WORKSPACE#" + workspaceID + "#STATUS#" + string(status),
		})
		if err != nil {
			return nil, err
		}
		output, err := r.client.Query(ctx, &dynamodb.QueryInput{
			TableName:                 aws.String(r.tableName),
			IndexName:                 aws.String("StatusIndex"),
			KeyConditionExpression:    aws.String("gsi1pk = :gsi1pk"),
			ExpressionAttributeValues: values,
			ScanIndexForward:          aws.Bool(true),
			Limit:                     aws.Int32(50),
		})
		if err != nil {
			return nil, err
		}
		for _, item := range output.Items {
			var record taskStateRecord
			if err := attributevalue.UnmarshalMap(item, &record); err != nil {
				return nil, err
			}
			task := taskStateFromRecord(record)
			if ownerUserID != "" && task.OwnerUserID != "" && task.OwnerUserID != ownerUserID {
				continue
			}
			if dueBefore != "" && task.DueAt != "" && task.DueAt > dueBefore {
				continue
			}
			results = append(results, task)
		}
	}

	sort.Slice(results, func(i int, j int) bool {
		leftDue := results[i].DueAt
		if leftDue == "" {
			leftDue = "9999-12-31T23:59:59.999Z"
		}
		rightDue := results[j].DueAt
		if rightDue == "" {
			rightDue = "9999-12-31T23:59:59.999Z"
		}
		if leftDue != rightDue {
			return leftDue < rightDue
		}
		return results[i].UpdatedAt > results[j].UpdatedAt
	})
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func (r *TaskStateRepository) MarkDone(ctx context.Context, workspaceID string, taskID string, completedByUserID string, completedAt string) (*tasks.State, error) {
	existing, err := r.Get(ctx, workspaceID, taskID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, errors.New("task was not found")
	}
	if completedAt == "" {
		completedAt = time.Now().UTC().Format(time.RFC3339)
	}
	state := *existing
	state.Status = tasks.StatusDone
	state.CompletedAt = completedAt
	state.CompletedByUserID = completedByUserID
	return r.Upsert(ctx, state)
}

func buildTaskStatusGSI1SK(dueAt string, updatedAt string, taskID string) string {
	if dueAt == "" {
		dueAt = "9999-12-31T23:59:59.999Z"
	}
	return "DUE#" + dueAt + "#UPDATED#" + updatedAt + "#TASK#" + taskID
}

func taskStateFromRecord(record taskStateRecord) tasks.State {
	return tasks.State{
		WorkspaceID:       record.WorkspaceID,
		TaskID:            record.TaskID,
		Title:             record.Title,
		Description:       record.Description,
		Status:            record.Status,
		DueAt:             record.DueAt,
		Priority:          record.Priority,
		OwnerUserID:       record.OwnerUserID,
		CalendarEventID:   record.CalendarEventID,
		SourceType:        record.SourceType,
		SourceRef:         record.SourceRef,
		Metadata:          record.Metadata,
		CompletedAt:       record.CompletedAt,
		CompletedByUserID: record.CompletedByUserID,
		CreatedAt:         record.CreatedAt,
		UpdatedAt:         record.UpdatedAt,
	}
}
