export const EMBEDDINGS_QUEUE = 'embeddings';

/** Job type: embed every NULL-embedding chunk of one uploaded document. */
export const EMBED_DOCUMENT_JOB = 'embed-document';

export interface EmbedDocumentJobData {
  documentId: string;
}
