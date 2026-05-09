package repo

import (
	"context"
	"sort"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/trknhr/slack-ai-assistant/internal/calendar"
)

type calendarDraftRecord struct {
	PK            string                    `dynamodbav:"pk"`
	SK            string                    `dynamodbav:"sk"`
	DraftID       string                    `dynamodbav:"draftId"`
	WorkspaceID   string                    `dynamodbav:"workspaceId"`
	UserID        string                    `dynamodbav:"userId,omitempty"`
	Title         string                    `dynamodbav:"title"`
	Notes         string                    `dynamodbav:"notes,omitempty"`
	SourceID      string                    `dynamodbav:"sourceId,omitempty"`
	SourceRef     string                    `dynamodbav:"sourceRef,omitempty"`
	CalendarID    string                    `dynamodbav:"calendarId,omitempty"`
	Status        string                    `dynamodbav:"status"`
	Candidates    []calendar.DraftCandidate `dynamodbav:"candidates"`
	CreatedAt     string                    `dynamodbav:"createdAt"`
	UpdatedAt     string                    `dynamodbav:"updatedAt"`
	ApprovedAt    string                    `dynamodbav:"approvedAt,omitempty"`
	RejectedAt    string                    `dynamodbav:"rejectedAt,omitempty"`
	LastAppliedAt string                    `dynamodbav:"lastAppliedAt,omitempty"`
}

type CalendarDraftRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewCalendarDraftRepository(client *dynamodb.Client, tableName string) *CalendarDraftRepository {
	return &CalendarDraftRepository{client: client, tableName: tableName}
}

func (r *CalendarDraftRepository) Save(ctx context.Context, draft calendar.Draft) (*calendar.Draft, error) {
	record := calendarDraftRecord{
		PK:            buildCalendarDraftPK(draft.WorkspaceID, draft.UserID),
		SK:            "DRAFT#" + draft.DraftID,
		DraftID:       draft.DraftID,
		WorkspaceID:   draft.WorkspaceID,
		UserID:        draft.UserID,
		Title:         draft.Title,
		Notes:         draft.Notes,
		SourceID:      draft.SourceID,
		SourceRef:     draft.SourceRef,
		CalendarID:    draft.CalendarID,
		Status:        draft.Status,
		Candidates:    draft.Candidates,
		CreatedAt:     draft.CreatedAt,
		UpdatedAt:     draft.UpdatedAt,
		ApprovedAt:    draft.ApprovedAt,
		RejectedAt:    draft.RejectedAt,
		LastAppliedAt: draft.LastAppliedAt,
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
	return &draft, nil
}

func (r *CalendarDraftRepository) Get(ctx context.Context, workspaceID string, userID string, draftID string) (*calendar.Draft, error) {
	key, err := attributevalue.MarshalMap(map[string]string{
		"pk": buildCalendarDraftPK(workspaceID, userID),
		"sk": "DRAFT#" + draftID,
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
	var record calendarDraftRecord
	if err := attributevalue.UnmarshalMap(output.Item, &record); err != nil {
		return nil, err
	}
	draft := calendar.Draft{
		DraftID:       record.DraftID,
		WorkspaceID:   record.WorkspaceID,
		UserID:        record.UserID,
		Title:         record.Title,
		Notes:         record.Notes,
		SourceID:      record.SourceID,
		SourceRef:     record.SourceRef,
		CalendarID:    record.CalendarID,
		Status:        record.Status,
		Candidates:    record.Candidates,
		CreatedAt:     record.CreatedAt,
		UpdatedAt:     record.UpdatedAt,
		ApprovedAt:    record.ApprovedAt,
		RejectedAt:    record.RejectedAt,
		LastAppliedAt: record.LastAppliedAt,
	}
	return &draft, nil
}

func (r *CalendarDraftRepository) List(ctx context.Context, workspaceID string, userID string, statuses []string, limit int) ([]calendar.Draft, error) {
	if limit <= 0 {
		limit = 10
	}
	if limit > 20 {
		limit = 20
	}
	values, err := attributevalue.MarshalMap(map[string]string{
		":pk": buildCalendarDraftPK(workspaceID, userID),
	})
	if err != nil {
		return nil, err
	}
	output, err := r.client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(r.tableName),
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: values,
		Limit:                     aws.Int32(50),
	})
	if err != nil {
		return nil, err
	}

	statusSet := map[string]struct{}{}
	for _, status := range statuses {
		statusSet[status] = struct{}{}
	}
	results := make([]calendar.Draft, 0, len(output.Items))
	for _, item := range output.Items {
		var record calendarDraftRecord
		if err := attributevalue.UnmarshalMap(item, &record); err != nil {
			return nil, err
		}
		if len(statusSet) > 0 {
			if _, ok := statusSet[record.Status]; !ok {
				continue
			}
		}
		results = append(results, calendar.Draft{
			DraftID:       record.DraftID,
			WorkspaceID:   record.WorkspaceID,
			UserID:        record.UserID,
			Title:         record.Title,
			Notes:         record.Notes,
			SourceID:      record.SourceID,
			SourceRef:     record.SourceRef,
			CalendarID:    record.CalendarID,
			Status:        record.Status,
			Candidates:    record.Candidates,
			CreatedAt:     record.CreatedAt,
			UpdatedAt:     record.UpdatedAt,
			ApprovedAt:    record.ApprovedAt,
			RejectedAt:    record.RejectedAt,
			LastAppliedAt: record.LastAppliedAt,
		})
	}

	sort.Slice(results, func(i int, j int) bool {
		return results[i].UpdatedAt > results[j].UpdatedAt
	})
	if len(results) > limit {
		results = results[:limit]
	}
	return results, nil
}

func buildCalendarDraftPK(workspaceID string, userID string) string {
	if userID == "" {
		userID = "_"
	}
	return "WORKSPACE#" + workspaceID + "#USER#" + userID
}
