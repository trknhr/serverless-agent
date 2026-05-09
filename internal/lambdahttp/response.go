package lambdahttp

import (
	"encoding/json"
	"net/http"

	"github.com/aws/aws-lambda-go/events"
)

func JSON(statusCode int, body any) events.APIGatewayProxyResponse {
	payload, err := json.Marshal(body)
	if err != nil {
		return events.APIGatewayProxyResponse{
			StatusCode: http.StatusInternalServerError,
			Headers: map[string]string{
				"content-type": "application/json; charset=utf-8",
			},
			Body: `{"ok":false,"error":"marshal_error"}`,
		}
	}

	return events.APIGatewayProxyResponse{
		StatusCode: statusCode,
		Headers: map[string]string{
			"content-type": "application/json; charset=utf-8",
		},
		Body: string(payload),
	}
}

func Text(statusCode int, body string) events.APIGatewayProxyResponse {
	return events.APIGatewayProxyResponse{
		StatusCode: statusCode,
		Headers: map[string]string{
			"content-type": "text/plain; charset=utf-8",
		},
		Body: body,
	}
}

func HTML(statusCode int, body string) events.APIGatewayProxyResponse {
	return events.APIGatewayProxyResponse{
		StatusCode: statusCode,
		Headers: map[string]string{
			"content-type": "text/html; charset=utf-8",
		},
		Body: body,
	}
}

func Redirect(location string) events.APIGatewayProxyResponse {
	return events.APIGatewayProxyResponse{
		StatusCode: http.StatusFound,
		Headers: map[string]string{
			"location": location,
		},
		Body: "",
	}
}
