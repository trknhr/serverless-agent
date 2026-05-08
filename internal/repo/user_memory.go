package repo

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/trknhr/slack-ai-assistant/internal/contracts"
)

type userMemoryRecord struct {
	PK             string `dynamodbav:"pk"`
	MemoryStoreID  string `dynamodbav:"memory_store_id"`
	ProfileSummary string `dynamodbav:"profile_summary,omitempty"`
	CreatedAt      string `dynamodbav:"created_at"`
	UpdatedAt      string `dynamodbav:"updated_at"`
}

type UserMemoryRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewUserMemoryRepository(client *dynamodb.Client, tableName string) *UserMemoryRepository {
	return &UserMemoryRepository{client: client, tableName: tableName}
}

func (r *UserMemoryRepository) Find(ctx context.Context, workspaceID string, userID string) (*contracts.UserMemoryRecord, error) {
	key, err := attributevalue.MarshalMap(map[string]string{
		"pk": "WORKSPACE#" + workspaceID + "#USER#" + userID,
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
	var record userMemoryRecord
	if err := attributevalue.UnmarshalMap(output.Item, &record); err != nil {
		return nil, err
	}
	return &contracts.UserMemoryRecord{
		WorkspaceID:    workspaceID,
		UserID:         userID,
		MemoryStoreID:  record.MemoryStoreID,
		ProfileSummary: record.ProfileSummary,
		CreatedAt:      record.CreatedAt,
		UpdatedAt:      record.UpdatedAt,
	}, nil
}

func (r *UserMemoryRepository) Save(ctx context.Context, record contracts.UserMemoryRecord) error {
	itemMap, err := attributevalue.MarshalMap(userMemoryRecord{
		PK:             "WORKSPACE#" + record.WorkspaceID + "#USER#" + record.UserID,
		MemoryStoreID:  record.MemoryStoreID,
		ProfileSummary: record.ProfileSummary,
		CreatedAt:      record.CreatedAt,
		UpdatedAt:      record.UpdatedAt,
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
