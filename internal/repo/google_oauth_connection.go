package repo

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

type GoogleOAuthConnection struct {
	WorkspaceID   string
	UserID        string
	GoogleSubject string
	GoogleEmail   string
	RefreshToken  string
	CalendarID    string
	TimeZone      string
	Scopes        []string
	ConnectedAt   string
	UpdatedAt     string
}

type googleOAuthConnectionItem struct {
	PK            string   `dynamodbav:"pk"`
	SK            string   `dynamodbav:"sk"`
	WorkspaceID   string   `dynamodbav:"workspaceId"`
	UserID        string   `dynamodbav:"userId"`
	GoogleSubject string   `dynamodbav:"googleSubject,omitempty"`
	GoogleEmail   string   `dynamodbav:"googleEmail,omitempty"`
	RefreshToken  string   `dynamodbav:"refreshToken"`
	CalendarID    string   `dynamodbav:"calendarId,omitempty"`
	TimeZone      string   `dynamodbav:"timeZone,omitempty"`
	Scopes        []string `dynamodbav:"scopes,omitempty"`
	ConnectedAt   string   `dynamodbav:"connectedAt"`
	UpdatedAt     string   `dynamodbav:"updatedAt"`
}

type GoogleOAuthConnectionRepository struct {
	client    *dynamodb.Client
	tableName string
}

func NewGoogleOAuthConnectionRepository(client *dynamodb.Client, tableName string) *GoogleOAuthConnectionRepository {
	return &GoogleOAuthConnectionRepository{client: client, tableName: tableName}
}

func (r *GoogleOAuthConnectionRepository) Get(ctx context.Context, workspaceID string, userID string) (*GoogleOAuthConnection, error) {
	key, err := attributevalue.MarshalMap(map[string]string{
		"pk": buildGoogleOAuthConnectionPK(workspaceID, userID),
		"sk": "GOOGLE_CALENDAR",
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

	var item googleOAuthConnectionItem
	if err := attributevalue.UnmarshalMap(output.Item, &item); err != nil {
		return nil, err
	}

	return &GoogleOAuthConnection{
		WorkspaceID:   item.WorkspaceID,
		UserID:        item.UserID,
		GoogleSubject: item.GoogleSubject,
		GoogleEmail:   item.GoogleEmail,
		RefreshToken:  item.RefreshToken,
		CalendarID:    item.CalendarID,
		TimeZone:      item.TimeZone,
		Scopes:        item.Scopes,
		ConnectedAt:   item.ConnectedAt,
		UpdatedAt:     item.UpdatedAt,
	}, nil
}

func (r *GoogleOAuthConnectionRepository) Save(ctx context.Context, connection GoogleOAuthConnection) error {
	now := time.Now().UTC().Format(time.RFC3339)
	if connection.ConnectedAt == "" {
		connection.ConnectedAt = now
	}
	if connection.UpdatedAt == "" {
		connection.UpdatedAt = now
	}

	item, err := attributevalue.MarshalMap(googleOAuthConnectionItem{
		PK:            buildGoogleOAuthConnectionPK(connection.WorkspaceID, connection.UserID),
		SK:            "GOOGLE_CALENDAR",
		WorkspaceID:   connection.WorkspaceID,
		UserID:        connection.UserID,
		GoogleSubject: connection.GoogleSubject,
		GoogleEmail:   connection.GoogleEmail,
		RefreshToken:  connection.RefreshToken,
		CalendarID:    connection.CalendarID,
		TimeZone:      connection.TimeZone,
		Scopes:        connection.Scopes,
		ConnectedAt:   connection.ConnectedAt,
		UpdatedAt:     connection.UpdatedAt,
	})
	if err != nil {
		return err
	}

	_, err = r.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(r.tableName),
		Item:      item,
	})
	return err
}

func buildGoogleOAuthConnectionPK(workspaceID string, userID string) string {
	return fmt.Sprintf("WORKSPACE#%s#USER#%s", workspaceID, userID)
}
