import { z } from 'zod';

/** Removes control characters (keeps \n and \t), normalises Unicode, trims. */
export function sanitizeText(value: string): string {
  return value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').trim();
}

const text = (max: number) => z.string().transform(sanitizeText).pipe(z.string().max(max));

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }));

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: text(60).pipe(z.string().min(2, 'Display name must be at least 2 characters')),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const areaNameSchema = text(120).pipe(z.string().min(1, 'Name is required'));
export const areaDescriptionSchema = text(2000);

/**
 * Geometry is only shape-checked here; PolygonValidator performs the real
 * geometric validation (ring closure, self-intersection, area bounds).
 */
export const polygonInputSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.array(z.number()).min(2).max(4)).max(1002)).min(1).max(1),
});

export const createAreaSchema = z.object({
  name: areaNameSchema,
  description: areaDescriptionSchema.default(''),
  geometry: polygonInputSchema,
});

export const updateAreaSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    name: areaNameSchema.optional(),
    description: areaDescriptionSchema.optional(),
    geometry: polygonInputSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.geometry !== undefined, {
    message: 'Nothing to update',
  });

export const deleteAreaSchema = z.object({ expectedVersion: z.number().int().min(1).optional() });

export const uuidSchema = z.uuid();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateAreaInput = z.infer<typeof createAreaSchema>;
export type UpdateAreaInput = z.infer<typeof updateAreaSchema>;
