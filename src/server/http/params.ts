import { uuidSchema } from '@/lib/api/schemas';
import { ApiError } from './errors';

/** Malformed ids are indistinguishable from missing ones (404), never a 500. */
export function parseAreaId(id: string): string {
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw ApiError.notFound('Area not found');
  return parsed.data;
}
