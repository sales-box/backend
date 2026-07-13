export function wrapUntrustedContent(
  content: string,
  source:
    'email_body' | 'attachment_text' | 'vision_extracted' | 'google_drive',
): string {
  return `<untrusted_content source="${source}">\n${content}\n</untrusted_content>`;
}
