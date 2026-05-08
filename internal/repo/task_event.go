package repo

import (
	"context"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/trknhr/slack-ai-assistant/internal/idgen"
	"github.com/trknhr/slack-ai-assistant/internal/tasks"
)

type taskEventRepository struct {
	client    *dynamodb.Client
	tableName string
}

type taskEventRecord struct {
	PK        string         `dynamodbav:"pk"`
	SK        string         `dynamodbav:"sk"`
	TaskID    string         `dynamodbav:"taskId"`
	EventID   string         `dynamodbav:"eventId"`
	Type      string         `dynamodbav:"type"`
	Payload   map[string]any `dynamodbav:"payload,omitempty"`
	CreatedAt string         `dynamodbav:"createdAt"`
}

type TaskEventRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewTaskEventRepository(client *dynamodb.Client, tableName string) *TaskEventRepository {
	return &TaskEventRepository{client: client, tableName: tableName}
}

func (r *TaskEventRepository) Save(ctx context.Context, event tasks.EventRecord) (*tasks.EventRecord, error) {
	eventID := event.EventID
	if eventID == "" {
		eventID = idgen.New("tevt_")
	}
	createdAt := event.CreatedAt
	if createdAt == "" {
		createdAt = time.Now().UTC().Format(time.RFC3339)
	}
	record := taskEventRecord{
		PK:        "TASK#" + event.TaskID,
		SK:        "EVENT#" + createdAt + "#" + eventID,
		TaskID:    event.TaskID,
		EventID:   eventID,
		Type:      event.Type,
		Payload:   event.Payload,
		CreatedAt: createdAt,
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

	return &tasks.EventRecord{
		TaskID:    record.TaskID,
		EventID:   record.EventID,
		Type:      record.Type,
		Payload:   record.Payload,
		CreatedAt: record.CreatedAt,
	}, nil
}
