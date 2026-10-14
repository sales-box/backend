import { z } from 'zod';

export const UserPreferencesSchema = z.object({
  instructions: z
    .string()
    .describe('The updated list of strict writing instructions for this user.'),
});
