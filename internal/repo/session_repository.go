package repo

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/trknhr/slack-ai-assistant/internal/contracts"
)

type SessionRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewSessionRepository(client *dynamodb.Client, tableName string) *SessionRepository {
	return &SessionRepository{client: client, tableName: tableName}
}

func (r *SessionRepository) FindByThread(ctx context.Context, workspaceID string, channelID string, threadTS string) (*contracts.ThreadSessionRecord, error) {
	key, err := attributevalue.MarshalMap(map[string]string{
		"pk": "WORKSPACE#" + workspaceID + "#CHANNEL#" + channelID,
		"sk": "THREAD#" + threadTS,
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
	var record struct {
		SessionID     string `dynamodbav:"session_id"`
		MemoryStoreID string `dynamodbav:"memory_store_id,omitempty"`
		CreatedAt     string `dynamodbav:"created_at"`
		LastUsedAt    string `dynamodbav:"last_used_at"`
	}
	if err := attributevalue.UnmarshalMap(output.Item, &record); err != nil {
		return nil, err
	}
	return &contracts.ThreadSessionRecord{
		WorkspaceID:   workspaceID,
		ChannelID:     channelID,
		ThreadTS:      threadTS,
		SessionID:     record.SessionID,
		MemoryStoreID: record.MemoryStoreID,
		CreatedAt:     record.CreatedAt,
		LastUsedAt:    record.LastUsedAt,
	}, nil
}

func (r *SessionRepository) Save(ctx context.Context, record contracts.ThreadSessionRecord) error {
	itemMap, err := attributevalue.MarshalMap(map[string]any{
		"pk":              "WORKSPACE#" + record.WorkspaceID + "#CHANNEL#" + record.ChannelID,
		"sk":              "THREAD#" + record.ThreadTS,
		"session_id":      record.SessionID,
		"memory_store_id": record.MemoryStoreID,
		"created_at":      record.CreatedAt,
		"last_used_at":    record.LastUsedAt,
	})
	if err != nil {
		return err
	}
	_, err = r.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(r.tableName),
		Item:      itemMap,
	})
	return err
}
