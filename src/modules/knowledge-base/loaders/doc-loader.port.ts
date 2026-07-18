export interface LoadedDoc {
  text: string;
  meta: Record<string, unknown>;
}

export interface DocLoader {
  load(buffer: Buffer): Promise<LoadedDoc>;
}
