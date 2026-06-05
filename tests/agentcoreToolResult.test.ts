import { describe, expect, it } from "vitest";
import { mapToolExecutionResultToModelOutput } from "../src/agentcore/toolResultOutput";

describe("mapToolExecutionResultToModelOutput", () => {
  it("maps text and base64 images to content output", () => {
    expect(
      mapToolExecutionResultToModelOutput({
        content: [
          { type: "text", text: "Screenshot captured." },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ],
      }),
    ).toEqual({
      type: "content",
      value: [
        { type: "text", text: "Screenshot captured." },
        {
          type: "image-data",
          data: "iVBORw0KGgo=",
          mediaType: "image/png",
        },
      ],
    });
  });

  it("maps errors to error-text with the first text block", () => {
    expect(
      mapToolExecutionResultToModelOutput({
        isError: true,
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
          { type: "text", text: "Browser command failed." },
        ],
      }),
    ).toEqual({
      type: "error-text",
      value: "Browser command failed.",
    });
  });

  it("maps unsupported documents to an attachment note", () => {
    expect(
      mapToolExecutionResultToModelOutput({
        content: [
          {
            type: "document",
            title: "report.pdf",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0=",
            },
          },
        ],
      }),
    ).toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: "Attachment note: Non-image tool output report.pdf could not be sent to the model.",
        },
      ],
    });
  });

  it("maps empty content to a completion note", () => {
    expect(mapToolExecutionResultToModelOutput({})).toEqual({
      type: "content",
      value: [{ type: "text", text: "Tool completed without content." }],
    });
  });
});
