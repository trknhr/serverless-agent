package repo

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

type EventDedupRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewEventDedupRepository(client *dynamodb.Client, tableName string) *EventDedupRepository {
	return &EventDedupRepository{client: client, tableName: tableName}
}

func (r *EventDedupRepository) MarkProcessed(ctx context.Context, eventID string, ttlSeconds int) (bool, error) {
	now := time.Now().UTC()
	item, err := attributevalue.MarshalMap(map[string]any{
		"pk":         fmt.Sprintf("EVENT#%s", eventID),
		"created_at": now.Format(time.RFC3339),
		"ttl":        now.Unix() + int64(ttlSeconds),
	})
	if err != nil {
		return false, err
	}

	_, err = r.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(r.tableName),
		Item:                item,
		ConditionExpression: aws.String("attribute_not_exists(pk)"),
	})
	if err == nil {
		return true, nil
	}

	var conditional *types.ConditionalCheckFailedException
	if ok := As(err, &conditional); ok {
		return false, nil
	}

	return false, err
}
