import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AgentContentBlock } from "../agent/types";
import { SourceDocumentRepository } from "../repo/sourceDocumentRepository";

const defaultMaxBytes = 750_000;

interface S3ObjectBody {
  transformToByteArray(): Promise<Uint8Array>;
}

interface S3ClientLike {
  send(command: GetObjectCommand): Promise<{ Body?: S3ObjectBody }>;
}

export interface ReadArchivedImageInput {
  workspaceId: string;
  sourceId: string;
  now?: Date;
  maxBytes?: number;
}

export class ArchivedAttachmentImageReader {
  private readonly s3: S3ClientLike;

  constructor(
    private readonly repository: Pick<SourceDocumentRepository, "get">,
    s3?: S3ClientLike,
  ) {
    this.s3 = s3 ?? new S3Client({});
  }

  async readImage(input: ReadArchivedImageInput): Promise<AgentContentBlock[]> {
    const document = await this.repository.get(input.workspaceId, input.sourceId);
    const maxBytes = input.maxBytes ?? defaultMaxBytes;

    if (!document) {
      return [textNote(`Archived image ${input.sourceId} was not found.`)];
    }

    const now = input.now ?? new Date();
    if (document.expiresAt && new Date(document.expiresAt).getTime() <= now.getTime()) {
      return [textNote(`Archived image ${input.sourceId} has expired.`)];
    }

    if (document.status !== "archived" || !document.s3Bucket || !document.s3Key) {
      return [textNote(`Archived source ${input.sourceId} is not available.`)];
    }

    if (!document.mimeType?.startsWith("image/")) {
      return [textNote(`Archived source ${input.sourceId} is not an image.`)];
    }

    const object = await this.s3.send(
      new GetObjectCommand({
        Bucket: document.s3Bucket,
        Key: document.s3Key,
      }),
    );
    const bytes = Buffer.from(await object.Body!.transformToByteArray());

    if (bytes.byteLength > maxBytes) {
      return [textNote(`Archived image ${input.sourceId} is larger than ${maxBytes} bytes.`)];
    }

    return [
      { type: "text", text: `Attached archived image: ${document.title}` },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: document.mimeType,
          data: bytes.toString("base64"),
        },
      },
    ];
  }
}

function textNote(text: string): AgentContentBlock {
  return { type: "text", text: `Attachment note: ${text}` };
}
