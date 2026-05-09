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

type userPreferenceRecord struct {
	PK              string         `dynamodbav:"pk"`
	SK              string         `dynamodbav:"sk"`
	WorkspaceID     string         `dynamodbav:"workspaceId"`
	UserID          string         `dynamodbav:"userId"`
	PreferenceID    string         `dynamodbav:"preferenceId"`
	PreferenceKey   string         `dynamodbav:"preferenceKey,omitempty"`
	EntityKey       string         `dynamodbav:"entityKey,omitempty"`
	Text            string         `dynamodbav:"text"`
	SearchText      string         `dynamodbav:"searchText,omitempty"`
	Attributes      map[string]any `dynamodbav:"attributes,omitempty"`
	Tags            []string       `dynamodbav:"tags,omitempty"`
	Importance      *float64       `dynamodbav:"importance,omitempty"`
	Origin          string         `dynamodbav:"origin"`
	SourceType      string         `dynamodbav:"sourceType,omitempty"`
	SourceRef       string         `dynamodbav:"sourceRef,omitempty"`
	CreatedByUserID string         `dynamodbav:"createdByUserId,omitempty"`
	CreatedAt       string         `dynamodbav:"createdAt"`
	UpdatedAt       string         `dynamodbav:"updatedAt"`
}

type UserPreferenceRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewUserPreferenceRepository(client *dynamodb.Client, tableName string) *UserPreferenceRepository {
	return &UserPreferenceRepository{client: client, tableName: tableName}
}

func (r *UserPreferenceRepository) Save(ctx context.Context, item memory.UserPreferenceItem) (*memory.UserPreferenceItem, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	preferenceID := fallbackID(item.PreferenceID, "pref_")
	record := userPreferenceRecord{
		PK:              "USER#" + item.WorkspaceID + "#" + item.UserID,
		SK:              "PREFERENCE#" + preferenceID,
		WorkspaceID:     item.WorkspaceID,
		UserID:          item.UserID,
		PreferenceID:    preferenceID,
		PreferenceKey:   item.PreferenceKey,
		EntityKey:       item.EntityKey,
		Text:            item.Text,
		SearchText:      buildSearchText(item.Text, item.Attributes, item.Tags),
		Attributes:      item.Attributes,
		Tags:            item.Tags,
		Importance:      item.Importance,
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

	return &memory.UserPreferenceItem{
		WorkspaceID:     record.WorkspaceID,
		UserID:          record.UserID,
		PreferenceID:    record.PreferenceID,
		Text:            record.Text,
		PreferenceKey:   record.PreferenceKey,
		EntityKey:       record.EntityKey,
		Attributes:      record.Attributes,
		Tags:            record.Tags,
		Importance:      record.Importance,
		Origin:          record.Origin,
		SourceType:      record.SourceType,
		SourceRef:       record.SourceRef,
		CreatedByUserID: record.CreatedByUserID,
		CreatedAt:       record.CreatedAt,
		UpdatedAt:       record.UpdatedAt,
	}, nil
}

func (r *UserPreferenceRepository) Search(ctx context.Context, workspaceID string, userID string, query string, entityKey string, limit int) ([]memory.UserPreferenceItem, error) {
	if limit <= 0 {
		limit = 8
	}
	if limit > 20 {
		limit = 20
	}
	values, err := attributevalue.MarshalMap(map[string]string{
		":pk": "USER#" + workspaceID + "#" + userID,
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

	terms := strings.Fields(normalizeSearchValue(query))
	records := make([]userPreferenceRecord, 0, len(output.Items))
	for _, item := range output.Items {
		var record userPreferenceRecord
		if err := attributevalue.UnmarshalMap(item, &record); err != nil {
			return nil, err
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

	results := make([]memory.UserPreferenceItem, 0, len(records))
	for _, record := range records {
		results = append(results, memory.UserPreferenceItem{
			WorkspaceID:     record.WorkspaceID,
			UserID:          record.UserID,
			PreferenceID:    record.PreferenceID,
			Text:            record.Text,
			PreferenceKey:   record.PreferenceKey,
			EntityKey:       record.EntityKey,
			Attributes:      record.Attributes,
			Tags:            record.Tags,
			Importance:      record.Importance,
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
