package repo

import (
	"context"
	"sort"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/trknhr/slack-ai-assistant/internal/contracts"
	"github.com/trknhr/slack-ai-assistant/internal/idgen"
)

type conversationTurnRecord struct {
	PK             string `dynamodbav:"pk"`
	SK             string `dynamodbav:"sk"`
	GSI1PK         string `dynamodbav:"gsi1pk,omitempty"`
	GSI1SK         string `dynamodbav:"gsi1sk,omitempty"`
	TurnID         string `dynamodbav:"turn_id"`
	WorkspaceID    string `dynamodbav:"workspace_id"`
	ChannelID      string `dynamodbav:"channel_id"`
	ConversationTS string `dynamodbav:"conversation_ts"`
	ContextScope   string `dynamodbav:"context_scope"`
	Role           string `dynamodbav:"role"`
	Source         string `dynamodbav:"source"`
	SourceEvent    string `dynamodbav:"source_event"`
	ThreadTS       string `dynamodbav:"thread_ts,omitempty"`
	MessageTS      string `dynamodbav:"message_ts"`
	TurnTS         string `dynamodbav:"turn_ts"`
	UserID         string `dynamodbav:"user_id,omitempty"`
	Text           string `dynamodbav:"text"`
	CreatedAt      string `dynamodbav:"created_at"`
}

type ConversationTurnRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewConversationTurnRepository(client *dynamodb.Client, tableName string) *ConversationTurnRepository {
	return &ConversationTurnRepository{client: client, tableName: tableName}
}

func (r *ConversationTurnRepository) Save(ctx context.Context, record contracts.ConversationTurnRecord) (*contracts.ConversationTurnRecord, error) {
	if record.TurnID == "" {
		record.TurnID = idgen.New("turn_")
	}
	if record.CreatedAt == "" {
		record.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	item := conversationTurnRecord{
		PK:             "WORKSPACE#" + record.WorkspaceID + "#CHANNEL#" + record.ChannelID + "#CONVERSATION#" + record.ConversationTS,
		SK:             "TURN#" + record.TurnTS + "#" + record.TurnID,
		TurnID:         record.TurnID,
		WorkspaceID:    record.WorkspaceID,
		ChannelID:      record.ChannelID,
		ConversationTS: record.ConversationTS,
		ContextScope:   string(record.ContextScope),
		Role:           record.Role,
		Source:         record.Source,
		SourceEvent:    record.SourceEvent,
		ThreadTS:       record.ThreadTS,
		MessageTS:      record.MessageTS,
		TurnTS:         record.TurnTS,
		UserID:         record.UserID,
		Text:           record.Text,
		CreatedAt:      record.CreatedAt,
	}
	if record.ContextScope == contracts.ContextScopeChannelTopLevel {
		item.GSI1PK = "WORKSPACE#" + record.WorkspaceID + "#CHANNEL#" + record.ChannelID + "#SCOPE#" + string(record.ContextScope)
		item.GSI1SK = "TURN#" + record.TurnTS + "#CONVERSATION#" + record.ConversationTS + "#TURN#" + record.TurnID
	}
	itemMap, err := attributevalue.MarshalMap(item)
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
	return &record, nil
}

func (r *ConversationTurnRepository) ListByConversation(ctx context.Context, workspaceID string, channelID string, conversationTS string) ([]contracts.ConversationTurnRecord, error) {
	values, err := attributevalue.MarshalMap(map[string]string{
		":pk": "WORKSPACE#" + workspaceID + "#CHANNEL#" + channelID + "#CONVERSATION#" + conversationTS,
	})
	if err != nil {
		return nil, err
	}
	output, err := r.client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(r.tableName),
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: values,
		ScanIndexForward:          aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	return unmarshalConversationTurns(output.Items)
}

func (r *ConversationTurnRepository) ListRecentChannelTopLevelTurns(ctx context.Context, workspaceID string, channelID string, limit int) ([]contracts.ConversationTurnRecord, error) {
	if limit <= 0 {
		limit = 1
	}
	if limit > 50 {
		limit = 50
	}
	values, err := attributevalue.MarshalMap(map[string]string{
		":gsi1pk": "WORKSPACE#" + workspaceID + "#CHANNEL#" + channelID + "#SCOPE#" + string(contracts.ContextScopeChannelTopLevel),
	})
	if err != nil {
		return nil, err
	}
	output, err := r.client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(r.tableName),
		IndexName:                 aws.String("ChannelScopeIndex"),
		KeyConditionExpression:    aws.String("gsi1pk = :gsi1pk"),
		ExpressionAttributeValues: values,
		ScanIndexForward:          aws.Bool(false),
		Limit:                     aws.Int32(int32(limit)),
	})
	if err != nil {
		return nil, err
	}
	records, err := unmarshalConversationTurns(output.Items)
	if err != nil {
		return nil, err
	}
	sort.Slice(records, func(i int, j int) bool {
		return records[i].TurnTS < records[j].TurnTS
	})
	return records, nil
}

func unmarshalConversationTurns(items []map[string]types.AttributeValue) ([]contracts.ConversationTurnRecord, error) {
	records := make([]contracts.ConversationTurnRecord, 0, len(items))
	for _, item := range items {
		var raw conversationTurnRecord
		if err := attributevalue.UnmarshalMap(item, &raw); err != nil {
			return nil, err
		}
		records = append(records, contracts.ConversationTurnRecord{
			TurnID:         raw.TurnID,
			WorkspaceID:    raw.WorkspaceID,
			ChannelID:      raw.ChannelID,
			ConversationTS: raw.ConversationTS,
			ContextScope:   contracts.ContextScope(raw.ContextScope),
			Role:           raw.Role,
			Source:         raw.Source,
			SourceEvent:    raw.SourceEvent,
			ThreadTS:       raw.ThreadTS,
			MessageTS:      raw.MessageTS,
			TurnTS:         raw.TurnTS,
			UserID:         raw.UserID,
			Text:           raw.Text,
			CreatedAt:      raw.CreatedAt,
		})
	}
	return records, nil
}
