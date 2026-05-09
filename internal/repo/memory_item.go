package repo

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/trknhr/slack-ai-assistant/internal/memory"
)

type memoryItemRecord struct {
	PK              string         `dynamodbav:"pk"`
	SK              string         `dynamodbav:"sk"`
	GSI1PK          string         `dynamodbav:"gsi1pk,omitempty"`
	GSI1SK          string         `dynamodbav:"gsi1sk,omitempty"`
	MemoryID        string         `dynamodbav:"memoryId"`
	WorkspaceID     string         `dynamodbav:"workspaceId"`
	EntityKey       string         `dynamodbav:"entityKey,omitempty"`
	Text            string         `dynamodbav:"text"`
	SearchText      string         `dynamodbav:"searchText,omitempty"`
	Attributes      map[string]any `dynamodbav:"attributes,omitempty"`
	Tags            []string       `dynamodbav:"tags,omitempty"`
	Importance      *float64       `dynamodbav:"importance,omitempty"`
	SourceType      string         `dynamodbav:"sourceType,omitempty"`
	SourceRef       string         `dynamodbav:"sourceRef,omitempty"`
	CreatedByUserID string         `dynamodbav:"createdByUserId,omitempty"`
	CreatedAt       string         `dynamodbav:"createdAt"`
	UpdatedAt       string         `dynamodbav:"updatedAt"`
}

type MemoryItemRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewMemoryItemRepository(client *dynamodb.Client, tableName string) *MemoryItemRepository {
	return &MemoryItemRepository{client: client, tableName: tableName}
}

func (r *MemoryItemRepository) Save(ctx context.Context, item memory.Item) (*memory.Item, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	record := memoryItemRecord{
		PK:              "WORKSPACE#" + item.WorkspaceID,
		SK:              "MEMORY#" + fallbackID(item.MemoryID, "mem_"),
		MemoryID:        fallbackID(item.MemoryID, "mem_"),
		WorkspaceID:     item.WorkspaceID,
		EntityKey:       item.EntityKey,
		Text:            item.Text,
		SearchText:      buildSearchText(item.Text, item.Attributes, item.Tags),
		Attributes:      item.Attributes,
		Tags:            item.Tags,
		Importance:      item.Importance,
		SourceType:      item.SourceType,
		SourceRef:       item.SourceRef,
		CreatedByUserID: item.CreatedByUserID,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if record.EntityKey != "" {
		record.GSI1PK = "WORKSPACE#" + item.WorkspaceID + "#ENTITY#" + record.EntityKey
		record.GSI1SK = "UPDATED#" + record.UpdatedAt + "#MEMORY#" + record.MemoryID
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

	return &memory.Item{
		WorkspaceID:     record.WorkspaceID,
		MemoryID:        record.MemoryID,
		EntityKey:       record.EntityKey,
		Text:            record.Text,
		Attributes:      record.Attributes,
		Tags:            record.Tags,
		Importance:      record.Importance,
		SourceType:      record.SourceType,
		SourceRef:       record.SourceRef,
		CreatedByUserID: record.CreatedByUserID,
		CreatedAt:       record.CreatedAt,
		UpdatedAt:       record.UpdatedAt,
	}, nil
}

func (r *MemoryItemRepository) Search(ctx context.Context, workspaceID string, query string, entityKey string, limit int) ([]memory.Item, error) {
	if limit <= 0 {
		limit = 8
	}
	if limit > 20 {
		limit = 20
	}

	input := &dynamodb.QueryInput{
		TableName:        aws.String(r.tableName),
		ScanIndexForward: aws.Bool(false),
		Limit:            aws.Int32(100),
	}
	if entityKey != "" {
		input.IndexName = aws.String("EntityIndex")
		input.KeyConditionExpression = aws.String("gsi1pk = :gsi1pk")
	}

	terms := strings.Fields(normalizeSearchValue(query))
	values := map[string]any{}
	if entityKey != "" {
		values[":gsi1pk"] = "WORKSPACE#" + workspaceID + "#ENTITY#" + entityKey
	} else {
		input.KeyConditionExpression = aws.String("pk = :pk")
		values[":pk"] = "WORKSPACE#" + workspaceID
	}
	attrs, err := attributevalue.MarshalMap(values)
	if err != nil {
		return nil, err
	}
	input.ExpressionAttributeValues = attrs

	output, err := r.client.Query(ctx, input)
	if err != nil {
		return nil, err
	}

	records := make([]memoryItemRecord, 0, len(output.Items))
	for _, item := range output.Items {
		var record memoryItemRecord
		if err := attributevalue.UnmarshalMap(item, &record); err != nil {
			return nil, err
		}
		if matchesSearch(record.SearchText, terms) {
			records = append(records, record)
		}
	}

	sort.Slice(records, func(i int, j int) bool {
		left := derefFloat(records[i].Importance)
		right := derefFloat(records[j].Importance)
		if left != right {
			return left > right
		}
		return records[i].UpdatedAt > records[j].UpdatedAt
	})
	if len(records) > limit {
		records = records[:limit]
	}

	results := make([]memory.Item, 0, len(records))
	for _, record := range records {
		results = append(results, memory.Item{
			WorkspaceID:     record.WorkspaceID,
			MemoryID:        record.MemoryID,
			EntityKey:       record.EntityKey,
			Text:            record.Text,
			Attributes:      record.Attributes,
			Tags:            record.Tags,
			Importance:      record.Importance,
			SourceType:      record.SourceType,
			SourceRef:       record.SourceRef,
			CreatedByUserID: record.CreatedByUserID,
			CreatedAt:       record.CreatedAt,
			UpdatedAt:       record.UpdatedAt,
		})
	}
	return results, nil
}
