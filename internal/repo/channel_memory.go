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

type channelMemoryRecord struct {
	PK              string         `dynamodbav:"pk"`
	SK              string         `dynamodbav:"sk"`
	WorkspaceID     string         `dynamodbav:"workspaceId"`
	ChannelID       string         `dynamodbav:"channelId"`
	MemoryID        string         `dynamodbav:"memoryId"`
	Text            string         `dynamodbav:"text"`
	EntityKey       string         `dynamodbav:"entityKey,omitempty"`
	SearchText      string         `dynamodbav:"searchText,omitempty"`
	Attributes      map[string]any `dynamodbav:"attributes,omitempty"`
	Tags            []string       `dynamodbav:"tags,omitempty"`
	Importance      *float64       `dynamodbav:"importance,omitempty"`
	Status          string         `dynamodbav:"status"`
	Origin          string         `dynamodbav:"origin"`
	SourceType      string         `dynamodbav:"sourceType,omitempty"`
	SourceRef       string         `dynamodbav:"sourceRef,omitempty"`
	CreatedByUserID string         `dynamodbav:"createdByUserId,omitempty"`
	CreatedAt       string         `dynamodbav:"createdAt"`
	UpdatedAt       string         `dynamodbav:"updatedAt"`
}

type ChannelMemoryRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewChannelMemoryRepository(client *dynamodb.Client, tableName string) *ChannelMemoryRepository {
	return &ChannelMemoryRepository{client: client, tableName: tableName}
}

func (r *ChannelMemoryRepository) Save(ctx context.Context, item memory.ChannelItem) (*memory.ChannelItem, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	memoryID := fallbackID(item.MemoryID, "chanmem_")
	record := channelMemoryRecord{
		PK:              "CHANNEL#" + item.WorkspaceID + "#" + item.ChannelID,
		SK:              "MEMORY#" + memoryID,
		WorkspaceID:     item.WorkspaceID,
		ChannelID:       item.ChannelID,
		MemoryID:        memoryID,
		Text:            item.Text,
		EntityKey:       item.EntityKey,
		SearchText:      buildSearchText(item.Text, item.Attributes, item.Tags),
		Attributes:      item.Attributes,
		Tags:            item.Tags,
		Importance:      item.Importance,
		Status:          item.Status,
		Origin:          item.Origin,
		SourceType:      item.SourceType,
		SourceRef:       item.SourceRef,
		CreatedByUserID: item.CreatedByUserID,
		CreatedAt:       now,
		UpdatedAt:       now,
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

	return &memory.ChannelItem{
		WorkspaceID:     record.WorkspaceID,
		ChannelID:       record.ChannelID,
		MemoryID:        record.MemoryID,
		Text:            record.Text,
		EntityKey:       record.EntityKey,
		Attributes:      record.Attributes,
		Tags:            record.Tags,
		Importance:      record.Importance,
		Status:          record.Status,
		Origin:          record.Origin,
		SourceType:      record.SourceType,
		SourceRef:       record.SourceRef,
		CreatedByUserID: record.CreatedByUserID,
		CreatedAt:       record.CreatedAt,
		UpdatedAt:       record.UpdatedAt,
	}, nil
}

func (r *ChannelMemoryRepository) Search(ctx context.Context, workspaceID string, channelID string, query string, entityKey string, limit int, statuses []string) ([]memory.ChannelItem, error) {
	if limit <= 0 {
		limit = 8
	}
	if limit > 20 {
		limit = 20
	}
	if len(statuses) == 0 {
		statuses = []string{"active"}
	}

	values, err := attributevalue.MarshalMap(map[string]string{
		":pk": "CHANNEL#" + workspaceID + "#" + channelID,
	})
	if err != nil {
		return nil, err
	}
	output, err := r.client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(r.tableName),
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: values,
		ScanIndexForward:          aws.Bool(false),
		Limit:                     aws.Int32(100),
	})
	if err != nil {
		return nil, err
	}

	statusSet := map[string]struct{}{}
	for _, status := range statuses {
		statusSet[status] = struct{}{}
	}
	terms := strings.Fields(normalizeSearchValue(query))
	records := make([]channelMemoryRecord, 0, len(output.Items))
	for _, item := range output.Items {
		var record channelMemoryRecord
		if err := attributevalue.UnmarshalMap(item, &record); err != nil {
			return nil, err
		}
		if _, ok := statusSet[record.Status]; !ok {
			continue
		}
		if entityKey != "" && record.EntityKey != entityKey {
			continue
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

	results := make([]memory.ChannelItem, 0, len(records))
	for _, record := range records {
		results = append(results, memory.ChannelItem{
			WorkspaceID:     record.WorkspaceID,
			ChannelID:       record.ChannelID,
			MemoryID:        record.MemoryID,
			Text:            record.Text,
			EntityKey:       record.EntityKey,
			Attributes:      record.Attributes,
			Tags:            record.Tags,
			Importance:      record.Importance,
			Status:          record.Status,
			Origin:          record.Origin,
			SourceType:      record.SourceType,
			SourceRef:       record.SourceRef,
			CreatedByUserID: record.CreatedByUserID,
			CreatedAt:       record.CreatedAt,
			UpdatedAt:       record.UpdatedAt,
		})
	}
	return results, nil
}
