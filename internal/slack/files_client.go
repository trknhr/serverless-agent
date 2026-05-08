package slack

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/trknhr/slack-ai-assistant/internal/anthropic"
	"github.com/trknhr/slack-ai-assistant/internal/contracts"
	"github.com/trknhr/slack-ai-assistant/internal/documents"
)

type PreparedAttachment struct {
	File          contracts.SlackFileReference
	Label         string
	MimeType      string
	Status        string
	ContentBlocks []anthropic.InputBlock
	ContentBytes  []byte
}

type FilesClient struct {
	tokenProvider TokenProvider
	maxFileBytes  int
	httpClient    *http.Client
}

func NewFilesClient(tokenProvider TokenProvider, maxFileBytes int) *FilesClient {
	return &FilesClient{
		tokenProvider: tokenProvider,
		maxFileBytes:  maxFileBytes,
		httpClient:    &http.Client{},
	}
}

func (c *FilesClient) PrepareAttachments(ctx context.Context, files []contracts.SlackFileReference) ([]PreparedAttachment, error) {
	attachments := make([]PreparedAttachment, 0, len(files))
	for _, file := range files {
		attachment, err := c.prepareAttachment(ctx, file)
		if err != nil {
			label := chooseLabel(file)
			mimeType := chooseString(file.Mimetype, InferMimeTypeFromName(file.Name))
			attachments = append(attachments, PreparedAttachment{
				File:     file,
				Label:    label,
				MimeType: mimeType,
				Status:   "download_failed",
				ContentBlocks: []anthropic.InputBlock{
					{
						"type": "text",
						"text": fmt.Sprintf("Attachment note: Could not read %s. %s", label, err.Error()),
					},
				},
			})
			continue
		}
		attachments = append(attachments, attachment)
	}
	return attachments, nil
}

func (c *FilesClient) BuildContentBlocks(attachments []PreparedAttachment, maxInlineFiles int) []anthropic.InputBlock {
	if maxInlineFiles <= 0 {
		maxInlineFiles = 3
	}
	blocks := make([]anthropic.InputBlock, 0)
	for index, attachment := range attachments {
		if index >= maxInlineFiles {
			break
		}
		blocks = append(blocks, attachment.ContentBlocks...)
	}
	if len(attachments) > maxInlineFiles {
		blocks = append(blocks, anthropic.InputBlock{
			"type": "text",
			"text": fmt.Sprintf("Attachment note: %d additional file(s) were archived but omitted from inline analysis to keep the request bounded.", len(attachments)-maxInlineFiles),
		})
	}
	return blocks
}

func (c *FilesClient) prepareAttachment(ctx context.Context, file contracts.SlackFileReference) (PreparedAttachment, error) {
	resolved, err := c.resolveFile(ctx, file)
	if err != nil {
		return PreparedAttachment{}, err
	}
	label := chooseLabel(resolved)
	mimeType := chooseString(resolved.Mimetype, InferMimeTypeFromName(resolved.Name))

	if resolved.IsExternal != nil && *resolved.IsExternal && resolved.ExternalURL != "" {
		return PreparedAttachment{
			File:          resolved,
			Label:         label,
			MimeType:      mimeType,
			Status:        "external_link",
			ContentBlocks: []anthropic.InputBlock{{"type": "text", "text": fmt.Sprintf("Attached external file: %s. URL: %s", label, resolved.ExternalURL)}},
		}, nil
	}
	if resolved.Size != nil && int(*resolved.Size) > c.maxFileBytes {
		return PreparedAttachment{
			File:          resolved,
			Label:         label,
			MimeType:      mimeType,
			Status:        "skipped_oversize",
			ContentBlocks: []anthropic.InputBlock{{"type": "text", "text": fmt.Sprintf("Attachment note: %s was skipped because it is larger than %d bytes.", label, c.maxFileBytes)}},
		}, nil
	}
	downloadURL := chooseString(resolved.URLPrivateDownload, resolved.URLPrivate)
	if downloadURL == "" {
		return PreparedAttachment{
			File:          resolved,
			Label:         label,
			MimeType:      mimeType,
			Status:        "skipped_missing_url",
			ContentBlocks: []anthropic.InputBlock{{"type": "text", "text": fmt.Sprintf("Attachment note: %s did not include a downloadable URL.", label)}},
		}, nil
	}
	if !IsSupportedSlackArchiveMimeType(mimeType) {
		return PreparedAttachment{
			File:          resolved,
			Label:         label,
			MimeType:      mimeType,
			Status:        "skipped_unsupported",
			ContentBlocks: []anthropic.InputBlock{{"type": "text", "text": fmt.Sprintf("Attachment note: %s (%s) is not yet supported for inline analysis.", label, chooseString(mimeType, "unknown mime type"))}},
		}, nil
	}
	bytes, err := c.downloadFile(ctx, downloadURL)
	if err != nil {
		return PreparedAttachment{}, err
	}
	if len(bytes) > c.maxFileBytes {
		return PreparedAttachment{
			File:          resolved,
			Label:         label,
			MimeType:      mimeType,
			Status:        "skipped_oversize",
			ContentBlocks: []anthropic.InputBlock{{"type": "text", "text": fmt.Sprintf("Attachment note: %s exceeded the %d byte limit after download.", label, c.maxFileBytes)}},
		}, nil
	}
	return PreparedAttachment{
		File:          resolved,
		Label:         label,
		MimeType:      mimeType,
		Status:        "ready",
		ContentBytes:  bytes,
		ContentBlocks: documents.BuildClaudeContentBlocksForDocument(label, mimeType, bytes),
	}, nil
}

func (c *FilesClient) resolveFile(ctx context.Context, file contracts.SlackFileReference) (contracts.SlackFileReference, error) {
	if file.FileAccess != "check_file_info" && (file.URLPrivate != "" || file.URLPrivateDownload != "") {
		return file, nil
	}
	token, err := c.tokenProvider(ctx)
	if err != nil {
		return contracts.SlackFileReference{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://slack.com/api/files.info?file="+url.QueryEscape(file.ID), nil)
	if err != nil {
		return contracts.SlackFileReference{}, err
	}
	request.Header.Set("authorization", "Bearer "+token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return contracts.SlackFileReference{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return contracts.SlackFileReference{}, fmt.Errorf("files.info failed with status %d. Ensure the app has files:read", response.StatusCode)
	}
	var payload struct {
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
		File  struct {
			ID                 string `json:"id,omitempty"`
			Name               string `json:"name,omitempty"`
			Title              string `json:"title,omitempty"`
			Mimetype           string `json:"mimetype,omitempty"`
			FileAccess         string `json:"file_access,omitempty"`
			URLPrivate         string `json:"url_private,omitempty"`
			URLPrivateDownload string `json:"url_private_download,omitempty"`
			Permalink          string `json:"permalink,omitempty"`
			IsExternal         *bool  `json:"is_external,omitempty"`
			ExternalURL        string `json:"external_url,omitempty"`
			Size               *int64 `json:"size,omitempty"`
		} `json:"file"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return contracts.SlackFileReference{}, err
	}
	if !payload.OK {
		return contracts.SlackFileReference{}, fmt.Errorf("files.info returned error: %s. Ensure the app has files:read", payload.Error)
	}
	return contracts.SlackFileReference{
		ID:                 chooseString(payload.File.ID, file.ID),
		Name:               chooseString(payload.File.Name, file.Name),
		Title:              chooseString(payload.File.Title, file.Title),
		Mimetype:           chooseString(payload.File.Mimetype, file.Mimetype),
		FileAccess:         chooseString(payload.File.FileAccess, file.FileAccess),
		URLPrivate:         chooseString(payload.File.URLPrivate, file.URLPrivate),
		URLPrivateDownload: chooseString(payload.File.URLPrivateDownload, file.URLPrivateDownload),
		Permalink:          chooseString(payload.File.Permalink, file.Permalink),
		IsExternal:         chooseBoolPtr(payload.File.IsExternal, file.IsExternal),
		ExternalURL:        chooseString(payload.File.ExternalURL, file.ExternalURL),
		Size:               chooseInt64Ptr(payload.File.Size, file.Size),
	}, nil
}

func (c *FilesClient) downloadFile(ctx context.Context, downloadURL string) ([]byte, error) {
	token, err := c.tokenProvider(ctx)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("authorization", "Bearer "+token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("download failed with status %d. Ensure the app has files:read and access to this channel", response.StatusCode)
	}
	return io.ReadAll(response.Body)
}

func extractSlackFiles(value any) []contracts.SlackFileReference {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]contracts.SlackFileReference, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := entry["id"].(string)
		if id == "" {
			continue
		}
		var sizePtr *int64
		if number, ok := entry["size"].(float64); ok {
			size := int64(number)
			sizePtr = &size
		}
		var externalPtr *bool
		if value, ok := entry["is_external"].(bool); ok {
			externalPtr = &value
		}
		result = append(result, contracts.SlackFileReference{
			ID:                 id,
			Name:               optionalMapString(entry, "name"),
			Title:              optionalMapString(entry, "title"),
			Mimetype:           optionalMapString(entry, "mimetype"),
			FileAccess:         optionalMapString(entry, "file_access"),
			URLPrivate:         optionalMapString(entry, "url_private"),
			URLPrivateDownload: optionalMapString(entry, "url_private_download"),
			Permalink:          optionalMapString(entry, "permalink"),
			IsExternal:         externalPtr,
			ExternalURL:        optionalMapString(entry, "external_url"),
			Size:               sizePtr,
		})
	}
	return result
}

func optionalMapString(values map[string]any, key string) string {
	if value, ok := values[key].(string); ok {
		return value
	}
	return ""
}

func chooseLabel(file contracts.SlackFileReference) string {
	return chooseString(file.Name, file.Title, file.ID)
}

func chooseBoolPtr(values ...*bool) *bool {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func chooseInt64Ptr(values ...*int64) *int64 {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}
