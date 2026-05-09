package repo

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/trknhr/slack-ai-assistant/internal/tasks"
)

type TaskRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewTaskRepository(client *dynamodb.Client, tableName string) *TaskRepository {
	return &TaskRepository{client: client, tableName: tableName}
}

func (r *TaskRepository) Get(ctx context.Context, taskID string) (*tasks.ScheduledTask, error) {
	key, err := attributevalue.MarshalMap(map[string]string{
		"pk": tasks.BuildScheduledTaskPK(taskID),
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

	var task tasks.ScheduledTask
	if err := attributevalue.UnmarshalMap(output.Item, &task); err != nil {
		return nil, err
	}
	return &task, nil
}

func (r *TaskRepository) Save(ctx context.Context, task tasks.ScheduledTask) error {
	payload := map[string]any{
		"pk":                    tasks.BuildScheduledTaskPK(task.TaskID),
		"taskId":                task.TaskID,
		"name":                  task.Name,
		"prompt":                task.Prompt,
		"workspaceId":           task.WorkspaceID,
		"outputChannelId":       task.OutputChannelID,
		"enabled":               task.Enabled,
		"reuseSession":          task.ReuseSession,
		"memoryStoreId":         task.MemoryStoreID,
		"vaultIds":              task.VaultIDs,
		"agentIdOverride":       task.AgentIDOverride,
		"environmentIdOverride": task.EnvironmentIDOverride,
		"createdAt":             task.CreatedAt,
		"updatedAt":             task.UpdatedAt,
	}
	itemMap, err := attributevalue.MarshalMap(payload)
	if err != nil {
		return err
	}
	_, err = r.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(r.tableName),
		Item:      itemMap,
	})
	return err
}
