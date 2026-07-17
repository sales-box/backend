import { ParsedAttachment } from '@/modules/attachments/attachments.service';
export function flattenParsedAttachments(
  attachments: ParsedAttachment[],
): string[] {
  return attachments
    .filter((a) => !a.skipped)
    .map((a) => {
      if (a.type === 'pdf' || a.type === 'docx' || a.type === 'pptx') {
        return a.text ? `[${a.filename}]\n${a.text}` : null;
      }
      if (a.type === 'xlsx') {
        return a.structured ? `[${a.filename}]\n${a.structured}` : null;
      }
      if (a.type === 'image') {
        // Known gap, tracked not hidden — see §6 coordination note with Rana/Nagy.
        return `[${a.filename}] image attachment — not processed (no vision path in AiModelService yet)`;
      }
      return null;
    })
    .filter((text): text is string => text !== null);
}
