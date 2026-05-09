package logger

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

type Fields map[string]any

type Logger struct {
	base Fields
}

func New(base Fields) *Logger {
	return &Logger{base: clone(base)}
}

func Default() *Logger {
	return New(nil)
}

func (l *Logger) Child(fields Fields) *Logger {
	merged := clone(l.base)
	for key, value := range fields {
		merged[key] = value
	}
	return &Logger{base: merged}
}

func (l *Logger) Info(message string, fields Fields) {
	l.write("INFO", message, fields)
}

func (l *Logger) Warn(message string, fields Fields) {
	l.write("WARN", message, fields)
}

func (l *Logger) Error(message string, fields Fields) {
	l.write("ERROR", message, fields)
}

func (l *Logger) write(level string, message string, fields Fields) {
	record := Fields{
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"level":     level,
		"message":   message,
	}
	for key, value := range l.base {
		record[key] = value
	}
	for key, value := range fields {
		record[key] = value
	}

	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(record); err != nil {
		fmt.Fprintf(os.Stdout, "{\"timestamp\":%q,\"level\":\"ERROR\",\"message\":%q}\n", time.Now().UTC().Format(time.RFC3339Nano), err.Error())
	}
}

func clone(fields Fields) Fields {
	if len(fields) == 0 {
		return Fields{}
	}
	out := make(Fields, len(fields))
	for key, value := range fields {
		out[key] = value
	}
	return out
}
