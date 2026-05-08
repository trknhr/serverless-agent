package slack

import "strings"

func InferMimeTypeFromName(name string) string {
	lower := strings.ToLower(strings.TrimSpace(name))
	switch {
	case strings.HasSuffix(lower, ".pdf"):
		return "application/pdf"
	case strings.HasSuffix(lower, ".png"):
		return "image/png"
	case strings.HasSuffix(lower, ".jpg"), strings.HasSuffix(lower, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(lower, ".webp"):
		return "image/webp"
	case strings.HasSuffix(lower, ".gif"):
		return "image/gif"
	case strings.HasSuffix(lower, ".txt"), strings.HasSuffix(lower, ".md"), strings.HasSuffix(lower, ".csv"):
		return "text/plain"
	case strings.HasSuffix(lower, ".json"):
		return "application/json"
	default:
		return ""
	}
}

func IsTextLikeMimeType(mimeType string) bool {
	return strings.HasPrefix(mimeType, "text/") ||
		mimeType == "application/json" ||
		mimeType == "application/xml" ||
		mimeType == "application/javascript"
}

func IsSupportedSlackArchiveMimeType(mimeType string) bool {
	return mimeType == "application/pdf" || strings.HasPrefix(mimeType, "image/") || IsTextLikeMimeType(mimeType)
}

func IsSupportedLocalImportMimeType(mimeType string) bool {
	return mimeType == "application/pdf" || mimeType == "image/jpeg" || mimeType == "image/png"
}

func DefaultExtensionForMimeType(mimeType string) string {
	switch mimeType {
	case "application/pdf":
		return ".pdf"
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "application/json":
		return ".json"
	case "text/markdown":
		return ".md"
	case "text/csv":
		return ".csv"
	default:
		if IsTextLikeMimeType(mimeType) {
			return ".txt"
		}
		return ""
	}
}
